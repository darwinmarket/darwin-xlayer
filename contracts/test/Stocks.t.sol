// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XLayerFork} from "./Base.t.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";

/// Tokenized-stock baskets on a weekday fork: real xStocks, real Chainlink equity feeds, real
/// Uniswap routes through USDG, USDC, xBTC and wSPYx.
contract StocksTest is XLayerFork {
    function test_everyStockIsInSessionOnAWeekday() public view {
        address[9] memory stocks = [WNVDAX, WSPYX, WQQQX, WTSLAX, WSPCXX, WAAPLX, WGOOGLX, WCRCLX, WMSTRX];
        for (uint256 i; i < stocks.length; i++) {
            assertTrue(oracle.sessionOpen(stocks[i]), "in session");
            assertLe(oracle.ageClass(stocks[i]), 1, "fresh equity feed");
        }
    }

    function test_stockPricesMatchTheirPools() public view {
        address[9] memory stocks = [WNVDAX, WSPYX, WQQQX, WTSLAX, WSPCXX, WAAPLX, WGOOGLX, WCRCLX, WMSTRX];
        for (uint256 i; i < stocks.length; i++) {
            (uint256 p,) = oracle.price(stocks[i]);
            uint256 spot = oracle.spotPrice(stocks[i]);
            console2.log(IERC20Meta(stocks[i]).symbol(), p / 1e16, spot / 1e16);
            assertApproxEqRel(spot, p, 0.03e18, "pool within 3% of Chainlink");
        }
    }

    function test_sellPathIsTheReverseOfTheBuyPath() public view {
        bytes memory buyP = oracle.buyPath(WGOOGLX);
        bytes memory sellP = oracle.sellPath(WGOOGLX);
        assertEq(sellP, abi.encodePacked(WGOOGLX, uint24(500), WSPYX, uint24(500), USDG));
        assertEq(buyP, abi.encodePacked(USDG, uint24(500), WSPYX, uint24(500), WGOOGLX));
        assertEq(oracle.sellPath(WQQQX), abi.encodePacked(WQQQX, uint24(500), USDC, uint24(100), USDG));
    }

    function test_buyEveryStockBasket() public {
        DarwinBasket[5] memory stockBaskets = [tech, core, frontier, cryptoEq, allWeather];
        uint256[3] memory sizes = [uint256(25e6), 500e6, 5_000e6];
        for (uint256 k; k < stockBaskets.length; k++) {
            for (uint256 j; j < sizes.length; j++) {
                uint256 before = _navPerShare(stockBaskets[k]);
                uint256 shares = _buy(alice, stockBaskets[k], USDG, sizes[j]);
                uint256 value = shares * _navPerShare(stockBaskets[k]) / 1e18;
                uint256 paid = oracle.value(USDG, sizes[j]);
                console2.log(stockBaskets[k].symbol(), sizes[j] / 1e6, "USD ->", value * 10_000 / paid);
                assertGe(value * 1000, paid * 980, "at least 98% of what was paid");
                assertLe(value, paid, "never more than paid");
                assertGe(_navPerShare(stockBaskets[k]), before, "existing holders never lose");
            }
        }
    }

    function test_stockBasketHoldsItsTargets() public {
        _buy(alice, tech, USDG, 2_000e6);
        (uint256[] memory t,) = tech.targets();
        address[] memory coins = tech.coinList();
        uint256[] memory b = tech.balances();
        uint256 nav = tech.nav();
        for (uint256 i; i < coins.length; i++) {
            uint256 w = oracle.value(coins[i], b[i]) * 10_000 / nav;
            assertApproxEqAbs(w, t[i], 150, "within 1.5 pp of target");
        }
    }

    function test_stockRoundTrip() public {
        uint256 shares = _buy(alice, frontier, USDG, 1_000e6);
        uint256 out = _sell(alice, frontier, shares, USDG);
        console2.log("FRONTdw round trip, per 10k:", out * 10_000 / 1_000e6);
        assertGe(out, 975e6);
    }

    function test_buyStocksWithUsdcAndSellToUsdt0() public {
        uint256 shares = _buy(bob, core, USDC, 800e6);
        uint256 out = _sell(bob, core, shares, USDT0);
        assertGe(out, 775e6);
        assertEq(IERC20(USDT0).balanceOf(bob), out);
    }

    function test_cryptoEquitiesRouteThroughXbtc() public {
        uint256 btcPoolBefore = IERC20(XBTC).balanceOf(0x5A87091008124f5C879844905B7F9A1Cd315Faf1);
        _buy(alice, cryptoEq, USDG, 1_000e6);
        assertGt(IERC20(XBTC).balanceOf(0x5A87091008124f5C879844905B7F9A1Cd315Faf1), btcPoolBefore, "wCRCLx bought with xBTC");
        assertGt(IERC20(WCRCLX).balanceOf(address(cryptoEq)), 0);
        assertGt(IERC20(WMSTRX).balanceOf(address(cryptoEq)), 0);
    }

    function test_stockPoolManipulationIsRefused() public {
        // someone pushes wNVDAx 5% up on its pool just before a buy
        _pushPool(USDG, WNVDAX, 500, 150_000e6);
        _fund(alice, USDG, 1_000e6);
        vm.prank(alice);
        vm.expectRevert();
        router.buy(frontier, USDG, 1_000e6, 0, block.timestamp, alice);
    }

    function test_legEventsCarryTheCircuitVerdicts() public {
        _fund(alice, USDG, 300e6);
        vm.recordLogs();
        vm.prank(alice);
        router.buy(core, USDG, 300e6, 0, block.timestamp, alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Leg(address,address,bool,uint256,uint256,uint8,uint8,uint8,bool,bool,bool,uint8)");
        uint256 legs;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != sig) continue;
            legs++;
            (bool isBuy,,, uint8 dev,,,, bool open, bool pool, uint8 severity) =
                abi.decode(logs[i].data, (bool, uint256, uint256, uint8, uint8, uint8, bool, bool, bool, uint8));
            assertTrue(isBuy);
            assertTrue(open, "in session");
            assertFalse(pool, "priced by Chainlink");
            assertLe(dev, 8, "within 2% of Chainlink");
            assertLe(severity, 1, "allowed");
        }
        assertEq(legs, 2, "one verdict per stock (wSPYx, wQQQx)");
    }
}

interface IERC20Meta {
    function symbol() external view returns (string memory);
}
