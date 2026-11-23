// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XLayerFork} from "./Base.t.sol";
import {XLayer} from "../script/XLayer.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";

interface IGrowable {
    function increaseObservationCardinalityNext(uint16 next) external;
}

/// A Sunday on X Layer: the US stock market is closed and the xStocks' Chainlink feeds have been
/// frozen since Saturday 01:00 UTC, but their Uniswap pools keep trading against 24/7 venues.
/// Stocks are then priced by their own pool's one-hour TWAP, within bounds; a stock whose pool
/// cannot be trusted has no price and takes no money. No breaker trips for a normal weekend.
contract WeekendTest is XLayerFork {
    function forkBlock() internal pure override returns (uint256) {
        return WEEKEND_BLOCK;
    }

    /// Crypto baskets, and Frontier, whose three stocks are priced by their pools on Sunday.
    function _firstBuys() internal override {
        _buy(owner, blue, USDG, 50e6);
        _buy(owner, bal, USDG, 50e6);
        _buy(owner, okx, USDG, 50e6);
        _buy(owner, frontier, USDG, 50e6);
    }

    // ---- the clock and the prices ----------------------------------------------------------------

    function test_sessionCalendar() public view {
        // 2026-11-20 is a Friday
        uint256 fri = 1_795_132_800; // 2026-11-20 00:00 UTC
        assertTrue(oracle.isOpen(1, fri + 23 hours));
        assertFalse(oracle.isOpen(1, fri + 1 days)); // Saturday 00:00
        assertFalse(oracle.isOpen(1, fri + 2 days + 12 hours)); // Sunday noon
        assertFalse(oracle.isOpen(1, fri + 3 days + 30 minutes)); // Monday 00:30
        assertTrue(oracle.isOpen(1, fri + 3 days + 1 hours)); // Monday 01:00
        assertTrue(oracle.isOpen(0, fri + 2 days)); // crypto: always
    }

    function test_stocksArePricedByTheirPoolsOnSunday() public view {
        address[5] memory stocks = [WNVDAX, WSPYX, WQQQX, WTSLAX, WSPCXX];
        for (uint256 i; i < stocks.length; i++) {
            assertFalse(oracle.sessionOpen(stocks[i]), "market closed");
            assertTrue(oracle.poolPriced(stocks[i]), "priced by its pool");
            assertTrue(oracle.tradable(stocks[i]));
            assertLe(oracle.ageClass(stocks[i]), 1, "the pool traded recently");
            (uint256 p,) = oracle.price(stocks[i]);
            (uint256 friday,) = oracle.chainlinkPrice(stocks[i]);
            assertApproxEqRel(p, friday, 0.1e18, "within 10% of the last Chainlink price");
            assertApproxEqRel(p, oracle.spotPrice(stocks[i]), 0.01e18, "spot within 1% of the TWAP");
        }
        assertFalse(oracle.poolPriced(XBTC), "crypto keeps Chainlink");
    }

    /// Sunday noon, measured on chain: the pools had moved 1-3% since Friday's close, towards
    /// where Monday opened. Darwin follows them instead of Friday's price.
    function test_poolPricesMovedSinceFriday() public view {
        (uint256 p,) = oracle.price(WNVDAX);
        (uint256 friday,) = oracle.chainlinkPrice(WNVDAX);
        assertGt(p, friday, "NVIDIA traded up over the weekend");
        assertGt((p - friday) * 10_000 / friday, 100, "by more than 1%");
    }

    function test_aStockFollowsItsPairPrice() public view {
        // Alphabet trades against the S&P 500 token, itself priced by its pool on a Sunday
        if (oracle.poolPriced(WGOOGLX)) {
            assertTrue(oracle.poolPriced(WSPYX));
            (uint256 p,) = oracle.price(WGOOGLX);
            (uint256 friday,) = oracle.chainlinkPrice(WGOOGLX);
            assertApproxEqRel(p, friday, 0.1e18);
        }
    }

    // ---- trading -----------------------------------------------------------------------------------

    function test_aStockBasketTradesOnSunday() public {
        vm.recordLogs();
        uint256 shares = _buy(alice, frontier, USDG, 1_000e6);
        uint256 pools;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Leg(address,address,bool,uint256,uint256,uint8,uint8,uint8,bool,bool,bool,uint8)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != sig) continue;
            (,,, uint8 dev,,,, bool open, bool pool, uint8 severity) =
                abi.decode(logs[i].data, (bool, uint256, uint256, uint8, uint8, uint8, bool, bool, bool, uint8));
            assertFalse(open, "the market is closed");
            assertTrue(pool, "the circuit was told the price is the pool's");
            assertLe(dev, 6, "within 1.5% of the pool's hour");
            assertLe(severity, 1);
            pools++;
        }
        assertEq(pools, 3, "SpaceX, Tesla, NVIDIA");
        // value received, fee included
        assertGe(shares * _navPerShare(frontier) / 1e18, 985e18);
        uint256 out = _sell(alice, frontier, shares, USDG);
        assertGe(out, 975e6, "a weekend round trip keeps 97.5% or more");
    }

    function test_mixedBasketBuysEverythingOnSunday() public {
        (uint256[] memory t,) = allWeather.targets();
        assertEq(t[0], 4000, "wSPYx priced by its pool: full weight");
        _buy(alice, allWeather, USDG, 100e6);
        assertGt(IERC20(WSPYX).balanceOf(address(allWeather)), 0);
    }

    function test_aStockWithoutPoolHistoryGetsNoMoney() public view {
        // the Apple pool keeps a single observation (Darwin's deployment grows it): no hour of
        // history whenever it traded in the last hour
        if (!oracle.poolPriced(WAAPLX)) {
            assertFalse(oracle.tradable(WAAPLX));
            assertFalse(guard.eligible(WAAPLX));
            (uint256[] memory t,) = tech.targets();
            assertEq(t[2], 0, "Apple gets nothing");
            assertEq(t[0] + t[1] + t[3] + t[4], 10_000, "the others share the buy");
        }
    }

    function test_growingAPoolsHistoryMakesItPriceable() public {
        IGrowable(XLayer.POOL_WAAPLX).increaseObservationCardinalityNext(200);
        _pushPool(USDC, WAAPLX, 500, 50e6); // a trade writes an observation
        vm.warp(vm.getBlockTimestamp() + 61 minutes);
        _refreshFeeds();
        _pushPool(USDC, WAAPLX, 500, 10e6);
        _restoreStockFeeds();
        assertTrue(oracle.poolPriced(WAAPLX), "an hour of history, a recent trade");
    }

    function test_aWeekendDoesNotTripTheBreaker() public {
        DarwinBasket[4] memory stocks = [tech, core, frontier, cryptoEq];
        for (uint256 i; i < stocks.length; i++) {
            (,, uint8 bits) = guard.preview(address(stocks[i]));
            assertEq(bits, 31, "every fact healthy");
            assertFalse(guard.poke(address(stocks[i])));
        }
    }

    function test_cryptoBasketsTradeAllWeekend() public {
        uint256 shares = _buy(alice, blue, USDG, 1_000e6);
        uint256 out = _sell(alice, blue, shares, USDG);
        assertGe(out, 985e6);
    }

    // ---- attacks on the weekend price ------------------------------------------------------------

    /// Pushing a pool right before a buy: its spot leaves its hour average, it loses its price, and
    /// a basket holding it takes no buy until the pool is back.
    function test_aPushedPoolLosesItsPrice() public {
        _pushPool(USDG, WNVDAX, 500, 200_000e6); // buys NVIDIA hard: spot several % up
        assertFalse(oracle.poolPriced(WNVDAX), "spot more than 1% off its hour");
        assertEq(router.closedHolding(frontier), WNVDAX);
        _fund(attacker(), USDG, 10_000e6);
        vm.prank(attacker());
        vm.expectRevert(abi.encodeWithSelector(DarwinRouter.MarketClosed.selector, WNVDAX));
        router.buy(frontier, USDG, 10_000e6, 0, vm.getBlockTimestamp(), attacker());
        // holders still leave in kind
        uint256 s = frontier.balanceOf(owner);
        vm.prank(owner);
        frontier.redeem(s, owner);
    }

    /// Holding a pool far off for an hour (against every arbitrageur) moves its average too, but
    /// never more than 10% from the last Chainlink price.
    function test_aPoolHeldFarOffForAnHourHasNoPrice() public {
        _pushPool(USDG, WNVDAX, 500, 2_000_000e6);
        vm.warp(vm.getBlockTimestamp() + 61 minutes);
        _refreshFeeds();
        _pushPool(USDG, WNVDAX, 500, 1e6); // a fresh trade
        _restoreStockFeeds();
        assertGt(oracle.spotPrice(WNVDAX), _friday(WNVDAX) * 110 / 100, "pool held >10% up");
        assertFalse(oracle.poolPriced(WNVDAX), "beyond the 10% anchor");
        assertFalse(oracle.tradable(WNVDAX));
    }

    /// A pool that stopped trading is as frozen as the feed.
    function test_aQuietPoolHasNoPrice() public {
        vm.warp(vm.getBlockTimestamp() + 7 hours);
        _refreshFeeds();
        _restoreStockFeeds();
        assertFalse(oracle.poolPriced(WSPCXX), "no trade for 7 hours");
        assertEq(router.closedHolding(frontier), WSPCXX);
    }

    /// The circuit holds a pool-priced leg to 1.5% on a buy (2% with Chainlink).
    function test_poolPricedLegsHaveTighterLimits() public view {
        (bool a,) = guard.policy(DarwinGuard.Leg(7, 0, true, true, 0, true, false, true));
        assertFalse(a, "1.75% from the pool's hour: refused");
        (a,) = guard.policy(DarwinGuard.Leg(7, 0, true, true, 0, true, true, false));
        assertTrue(a, "1.75% from Chainlink: allowed");
        (a,) = guard.policy(DarwinGuard.Leg(0, 0, true, true, 0, true, false, false));
        assertFalse(a, "closed and no pool price: refused");
    }

    // ---- Monday ----------------------------------------------------------------------------------

    /// Monday 01:30 UTC: the session is open but some equity feeds only answer around 02:00. The
    /// pools price those stocks meanwhile, and no breaker trips.
    function test_mondaysFirstHour() public {
        uint256 monday = vm.getBlockTimestamp() + 13 hours + 30 minutes;
        vm.warp(monday);
        _refreshFeeds();
        _restoreStockFeeds(); // equity feeds still frozen on Saturday's answer
        // trades that move each pool's price (Uniswap records an observation when the tick moves)
        _pushPool(USDG, WSPCXX, 500, 5_000e6);
        _pushPool(USDG, WNVDAX, 500, 5_000e6);
        _pushPool(USDC, WTSLAX, 500, 5_000e6);
        assertTrue(oracle.sessionOpen(WNVDAX));
        assertTrue(oracle.poolPriced(WNVDAX), "feed past its heartbeat: the pool prices it");
        assertFalse(guard.poke(address(frontier)), "no trip");
        _buy(alice, frontier, USDG, 500e6);
    }

    // ---- helpers ---------------------------------------------------------------------------------

    function attacker() internal returns (address) {
        return makeAddr("attacker");
    }

    function _friday(address stock) internal view returns (uint256 p) {
        (p,) = oracle.chainlinkPrice(stock);
    }

    /// After `_refreshFeeds` (which makes every feed fresh), put the equity feeds back to their
    /// real, frozen Saturday answers: crypto stays fresh, stocks rest.
    function _restoreStockFeeds() internal {
        vm.clearMockedCalls();
        // every mock is gone: put the 24/7 ones back
        address[7] memory live = [
            XLayer.FEED_BTC,
            XLayer.FEED_ETH,
            XLayer.FEED_SOL,
            XLayer.FEED_OKB,
            XLayer.FEED_USDG,
            XLayer.FEED_USDT0,
            XLayer.FEED_USDC
        ];
        for (uint256 i; i < live.length; i++) {
            _mockFeed(live[i], _feedAnswer(live[i]), 60);
        }
        _mockFeed(XLayer.FEED_XBTC_BTC, _feedAnswer(XLayer.FEED_XBTC_BTC), 60);
        uint256 now_ = vm.getBlockTimestamp();
        vm.mockCall(
            XLayer.FEED_SEQUENCER,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(0), now_ - 30 days, now_ - 30 days, uint80(1))
        );
    }
}
