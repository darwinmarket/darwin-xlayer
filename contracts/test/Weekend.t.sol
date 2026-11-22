// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XLayerFork} from "./Base.t.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";

/// A Sunday on X Layer: US stocks are closed (their Chainlink feeds are 40+ hours old), crypto
/// trades as usual. Stock legs must be refused as "closed", never as "broken", and no breaker may
/// trip for a normal weekend.
contract WeekendTest is XLayerFork {
    function forkBlock() internal pure override returns (uint256) {
        return WEEKEND_BLOCK;
    }

    /// Only crypto baskets can take a first buy on a Sunday.
    function _firstBuys() internal override {
        _buy(owner, blue, USDG, 50e6);
        _buy(owner, bal, USDG, 50e6);
        _buy(owner, okx, USDG, 50e6);
    }

    function test_stocksAreClosedOnSunday() public view {
        assertFalse(oracle.sessionOpen(WNVDAX));
        assertFalse(oracle.sessionOpen(WSPYX));
        assertTrue(oracle.sessionOpen(XBTC));
        assertEq(oracle.ageClass(WNVDAX), 3, "the equity feed is old on a weekend");
    }

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

    function test_aWeekendDoesNotTripTheBreaker() public {
        (,, uint8 bits) = guard.preview(address(tech));
        assertEq(bits, 31, "every fact healthy: the closed stocks are skipped");
        guard.poke(address(tech));
        (uint8 state,) = guard.breakers(address(tech));
        assertEq(state & 1, 0);
    }

    function test_noNewMoneyForClosedStocks() public view {
        (uint256[] memory t,) = tech.targets();
        for (uint256 i; i < t.length; i++) {
            assertEq(t[i], 0, "closed stocks get no new money");
        }
    }

    function test_firstBuyOfAStockBasketWaitsForMonday() public {
        _fund(alice, USDG, 100e6);
        vm.prank(alice);
        vm.expectRevert(DarwinRouter.NoEligibleCoin.selector);
        router.buy(tech, USDG, 100e6, 0, block.timestamp, alice);
    }

    function test_mixedBasketBuysOnlyItsOpenMarketsOnSunday() public {
        // All Weather (wSPYx, xBTC, xETH, USDG) takes its Friday first buy, then a Sunday buy
        vm.warp(vm.getBlockTimestamp()); // stay on Sunday
        (uint256[] memory t,) = allWeather.targets();
        assertEq(t[0], 0, "wSPYx closed");
        assertEq(t[1] + t[2] + t[3], 10_000, "crypto and USDG take the whole buy");
        assertApproxEqAbs(t[1], 4166, 1, "xBTC 25/60");
        // with no shares yet it needs $5: crypto only, wSPYx untouched
        uint256 shares = _buy(alice, allWeather, USDG, 100e6);
        assertGt(shares, 0);
        assertEq(IERC20(WSPYX).balanceOf(address(allWeather)), 0);
    }

    function test_stockLegsAreRefusedAsClosedNotBroken() public {
        // a sell of a stock basket bought on Friday: its stock legs are "closed" (severity 2)
        (bool allow, uint8 severity) = guard.policy(_closedLeg());
        assertFalse(allow);
        assertEq(severity, 2);
    }

    function _closedLeg() internal view returns (DarwinGuard.Leg memory l) {
        l = DarwinGuard.Leg(0, oracle.ageClass(WSPYX), true, false, 0, true, false);
    }

    function test_cryptoBasketsTradeAllWeekend() public {
        uint256 shares = _buy(alice, blue, USDG, 1_000e6);
        uint256 out = _sell(alice, blue, shares, USDG);
        assertGe(out, 985e6);
    }
}
