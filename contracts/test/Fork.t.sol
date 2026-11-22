// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XLayerFork} from "./Base.t.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";
import {IBeacon, ITapeoutProcessor} from "../src/interfaces/External.sol";
import {XLayer} from "../script/XLayer.sol";

contract ForkTest is XLayerFork {
    // ---- the circuits on the real TapeOut processor ----------------------------------------------

    function test_circuitsTapedOutOnTheRealProcessor() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = processor.circuitInfo(policyId);
        assertEq(nIn, 14);
        assertEq(nOut, 3);
        assertEq(nState, 0);
        assertEq(gates, 105);
        (nIn, nOut, nState, gates) = processor.circuitInfo(breakerId);
        assertEq(nState, 4);
        assertEq(keccak256(processor.netlist(policyId)), circuitHash["darwin-trade-policy"]);
    }

    function test_policyCircuitVerdicts() public view {
        _verdict(0, 0, true, true, 0, false, true, 0); // clean
        _verdict(8, 0, true, true, 0, false, true, 1); // 2.00% away: warned
        _verdict(9, 0, true, true, 0, false, false, 2); // 2.25% away: buy refused
        _verdict(12, 0, true, false, 0, true, true, 1); // a sell tolerates 3%
        _verdict(0, 2, true, true, 0, false, false, 2); // past the heartbeat: no buy
        _verdict(0, 2, true, false, 0, true, true, 1); // ... but sells go
        _verdict(0, 0, false, false, 0, true, false, 3); // sequencer down: broken
        _verdict(0, 0, true, true, 9, false, false, 2); // a buy pushing a coin 9 pp off target
        _verdict(0, 0, true, true, 9, true, true, 0); // ... unless it brings it closer
    }

    function _verdict(uint8 dev, uint8 age, bool seq, bool isBuy, uint8 drift, bool better, bool allow, uint8 sev)
        internal
        view
    {
        (bool a, uint8 s) = guard.policy(DarwinGuard.Leg(dev, age, seq, isBuy, drift, better, true));
        assertEq(a, allow, "allow");
        assertEq(s, sev, "severity");
    }

    function test_methodologyCircuitsGiveTheTargets() public view {
        (uint256[] memory t, uint8 band) = blue.targets();
        assertEq(t[0], 5000);
        assertEq(t[1], 3000);
        assertEq(t[2], 2000);
        assertEq(band, 5);
        (t,) = bal.targets();
        assertEq(t[0] + t[1] + t[2], 10_000);
        assertEq(t[2], 3000);
        (t,) = okx.targets();
        assertEq(t[0], 5000);
    }

    // ---- buy and sell for real on Uniswap --------------------------------------------------------

    function test_buyEveryBasketAtEverySize() public {
        DarwinBasket[3] memory baskets = [blue, bal, okx];
        uint256[4] memory sizes = [uint256(10e6), 100e6, 1_000e6, 10_000e6];
        for (uint256 k; k < 3; k++) {
            for (uint256 j; j < sizes.length; j++) {
                uint256 before = _navPerShare(baskets[k]);
                uint256 shares = _buy(alice, baskets[k], USDG, sizes[j]);
                uint256 value = shares * _navPerShare(baskets[k]) / 1e18;
                uint256 paid = oracle.value(USDG, sizes[j]);
                // the buyer gets at least 98.5% of what they paid (0.30% fee + pool costs)
                assertGe(value * 1000, paid * 985, "value received");
                assertLe(value, paid, "never more than paid");
                // existing holders never lose
                assertGe(_navPerShare(baskets[k]), before, "nav per share");
                console2.log(baskets[k].symbol(), sizes[j] / 1e6, "USD ->", value * 10_000 / paid);
            }
        }
    }

    function test_buyWithUsdt0AndUsdc() public {
        uint256 s1 = _buy(alice, blue, USDT0, 500e6);
        uint256 s2 = _buy(bob, blue, USDC, 500e6);
        assertGt(s1, 0);
        assertGt(s2, 0);
        assertApproxEqRel(s1, s2, 0.01e18);
    }

    function test_buyThenSellRoundTrip() public {
        uint256 t0 = IERC20(USDG).balanceOf(treasury);
        uint256 c0 = IERC20(USDG).balanceOf(owner);
        uint256 shares = _buy(alice, blue, USDG, 1_000e6);
        uint256 out = _sell(alice, blue, shares, USDG);
        // two 0.30% fees and two pool crossings
        assertGe(out, 985e6, "round trip keeps >= 98.5%");
        assertEq(blue.balanceOf(alice), 0);
        uint256 toTreasury = IERC20(USDG).balanceOf(treasury) - t0;
        uint256 toCreator = IERC20(USDG).balanceOf(owner) - c0;
        assertApproxEqRel(toTreasury + toCreator, 5.98e6, 0.01e18, "0.30% twice");
        assertApproxEqRel(toCreator * 3, toTreasury + toCreator, 0.01e18, "a third to the strategy's creator");
    }

    function test_sellToUsdt0() public {
        uint256 shares = _buy(alice, okx, USDG, 1_000e6);
        uint256 out = _sell(alice, okx, shares, USDT0);
        assertGe(out, 980e6);
        assertEq(IERC20(USDT0).balanceOf(alice), out);
    }

    function test_redeemInKindAlwaysWorks() public {
        uint256 shares = _buy(alice, blue, USDG, 1_000e6);
        vm.prank(alice);
        uint256[] memory amounts = blue.redeem(shares, alice);
        uint256 v;
        address[] memory coins = blue.coinList();
        for (uint256 i; i < coins.length; i++) {
            assertEq(IERC20(coins[i]).balanceOf(alice), amounts[i]);
            v += oracle.value(coins[i], amounts[i]);
        }
        assertGe(v, 985e18);
    }

    function test_newMoneyGoesToUnderweightCoins() public {
        // push the basket off target: a big xBTC donation makes xBTC overweight
        deal(XBTC, address(blue), IERC20(XBTC).balanceOf(address(blue)) * 3);
        uint256 btcBefore = IERC20(XBTC).balanceOf(address(blue));
        _buy(alice, blue, USDG, 50e6);
        assertEq(IERC20(XBTC).balanceOf(address(blue)), btcBefore, "no new xBTC while overweight");
    }

    function test_allocateFuzz(uint96 a, uint96 b, uint96 c, uint64 q) public view {
        vm.assume(q > 0);
        uint256[] memory v = new uint256[](3);
        (v[0], v[1], v[2]) = (a, b, c);
        uint256[] memory t = new uint256[](3);
        (t[0], t[1], t[2]) = (5000, 3000, 2000);
        uint256[] memory alloc = router.allocate(v, t, q, uint256(q) * 1e12);
        assertEq(alloc[0] + alloc[1] + alloc[2], q, "everything allocated");
    }

    // ---- the policy refuses bad prices -----------------------------------------------------------

    function test_buyRefusedWhenAPoolIsManipulated() public {
        // a whale pushes xETH 5%+ above its oracle just before the buy
        _pushPool(USDG, XETH, 500, 400_000e6);
        _fund(alice, USDG, 1_000e6);
        vm.prank(alice);
        vm.expectRevert();
        router.buy(blue, USDG, 1_000e6, 0, block.timestamp, alice);
    }

    function test_sequencerDownClosesBuying() public {
        vm.mockCall(
            XLayer.FEED_SEQUENCER,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(1), block.timestamp - 10, block.timestamp - 10, uint80(1))
        );
        assertFalse(guard.buyOpen(address(blue)));
        _fund(alice, USDG, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DarwinRouter.BuyingClosed.selector, address(blue)));
        router.buy(blue, USDG, 100e6, 0, block.timestamp, alice);
    }

    function test_staleFeedTripsTheBreakerButExitsStayOpen() public {
        uint256 shares = _buy(alice, blue, USDG, 1_000e6);
        _mockFeed(XLayer.FEED_SOL, _feedAnswer(XLayer.FEED_SOL), 86_400 + 3 hours); // stale beyond grace
        guard.poke(address(blue));
        (uint8 state,) = guard.breakers(address(blue));
        assertEq(state & 1, 1, "tripped");
        assertFalse(guard.buyOpen(address(blue)));
        // selling xSOL on a dead feed is refused by the policy (market broken) ...
        vm.startPrank(alice);
        IERC20(address(blue)).approve(address(router), shares);
        vm.expectRevert();
        router.sell(blue, shares, USDG, 0, block.timestamp, alice);
        // ... but redeeming in kind always works
        blue.redeem(shares, alice);
        vm.stopPrank();
        assertGt(IERC20(XSOL).balanceOf(alice), 0);
    }

    function test_breakerResetsOnlyAfterEightHealthyBeats() public {
        _mockFeed(XLayer.FEED_SOL, _feedAnswer(XLayer.FEED_SOL), 86_400 + 3 hours);
        guard.poke(address(blue));
        vm.clearMockedCalls();
        uint256 t = vm.getBlockTimestamp(); // not block.timestamp: via-ir may reuse a cached value
        for (uint256 k = 1; k <= 8; k++) {
            t += 15 minutes;
            vm.warp(t);
            _refreshFeeds();
            guard.poke(address(blue));
            (uint8 state,) = guard.breakers(address(blue));
            if (k < 8) assertEq(state & 1, 1, "still tripped");
            else assertEq(state & 1, 0, "open after the eighth healthy beat");
        }
        assertTrue(guard.buyOpen(address(blue)));
    }

    function test_healthyPokeTooSoonReverts() public {
        guard.poke(address(blue));
        vm.expectRevert(DarwinGuard.TooSoon.selector);
        guard.poke(address(blue));
    }

    // ---- pinning ---------------------------------------------------------------------------------

    function test_processorUpgradeFailsClosed() public {
        vm.mockCall(XLayer.TAPEOUT_BEACON, abi.encodeWithSelector(IBeacon.implementation.selector), abi.encode(address(0xBEEF)));
        vm.expectRevert(abi.encodeWithSelector(DarwinGuard.ProcessorUpgraded.selector, address(0xBEEF)));
        guard.policy(DarwinGuard.Leg(0, 0, true, true, 0, false, true));
        _fund(alice, USDG, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        router.buy(blue, USDG, 100e6, 0, block.timestamp, alice);
    }

    function test_wrongCircuitHashIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(DarwinGuard.CircuitMismatch.selector, policyId));
        new DarwinGuard(processor, IBeacon(XLayer.TAPEOUT_BEACON), oracle, policyId, bytes32(uint256(1)), breakerId, circuitHash["darwin-breaker"]);
    }

    function test_methodologyChangeWaitsForTheTimelock() public {
        uint256 newId = circuitId["darwin-okx-ecosystem"]; // a different weight set
        vm.prank(owner);
        blue.proposeMethodology(newId, circuitHash["darwin-okx-ecosystem"]);
        uint256 t0 = vm.getBlockTimestamp();
        vm.expectRevert();
        blue.applyMethodology();
        vm.warp(t0 + 3 days);
        _refreshFeeds();
        blue.applyMethodology();
        assertEq(blue.methodologyId(), newId);
        (uint256[] memory t,) = blue.targets();
        assertEq(t[0], 5000);
        assertEq(t[1], 2500);
    }

    function test_onlyRouterMints() public {
        vm.expectRevert(DarwinBasket.NotRouter.selector);
        blue.mint(alice, 1e18);
    }

    function test_expiredDeadline() public {
        _fund(alice, USDG, 100e6);
        vm.prank(alice);
        vm.expectRevert(DarwinRouter.Expired.selector);
        router.buy(blue, USDG, 100e6, 0, block.timestamp - 1, alice);
    }

    function test_minSharesProtectsTheBuyer() public {
        _fund(alice, USDG, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        router.buy(blue, USDG, 100e6, 1_000e18, block.timestamp, alice);
    }
}
