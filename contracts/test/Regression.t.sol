// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {XLayerFork} from "./Base.t.sol";
import {XLayer} from "../script/XLayer.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";

/// A contract posing as a basket: before the fix, the router believed whatever it said.
contract FakeBasket is ERC20 {
    address[] internal c;
    uint256 internal fakeAmount;
    address public creator;

    constructor(address coin, uint256 amount) ERC20("fake", "FAKE") {
        c.push(coin);
        fakeAmount = amount;
        creator = msg.sender;
        _mint(msg.sender, 1e18);
    }

    function coinList() external view returns (address[] memory) {
        return c;
    }

    function balances() external pure returns (uint256[] memory b) {
        b = new uint256[](1);
    }

    function targets() external pure returns (uint256[] memory t, uint8 band) {
        t = new uint256[](1);
        t[0] = 10_000;
        band = 5;
    }

    function redeem(uint256, address) external view returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = fakeAmount;
    }
}

/// Every finding of the pre-deployment audit (2026-11-23), turned into a test that the fix holds.
contract RegressionTest is XLayerFork {
    address attacker = makeAddr("attacker");

    /// M1. On a weekend, a basket holding stocks priced at Friday's close cannot be bought (a buyer
    /// would take Monday's gap from the holders), nor sold through the router; redeeming in kind
    /// stays open.
    function test_noBuyWhileAHeldStockIsClosed() public {
        _buy(bob, cryptoEq, USDG, 3_000e6); // Friday
        uint256 t = vm.getBlockTimestamp();
        vm.warp(t + 44 hours); // Sunday noon
        vm.roll(block.number + 100_000);
        _mockFeed(XLayer.FEED_BTC, _feedAnswer(XLayer.FEED_BTC), 60);
        _mockFeed(XLayer.FEED_USDG, _feedAnswer(XLayer.FEED_USDG), 60);
        _mockFeed(XLayer.FEED_XBTC_BTC, _feedAnswer(XLayer.FEED_XBTC_BTC), 60);
        assertFalse(oracle.sessionOpen(WCRCLX));
        assertEq(router.closedHolding(cryptoEq), WCRCLX);

        _fund(attacker, USDG, 10_000e6);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(DarwinRouter.MarketClosed.selector, WCRCLX));
        router.buy(cryptoEq, USDG, 10_000e6, 0, vm.getBlockTimestamp(), attacker);

        uint256 shares = cryptoEq.balanceOf(bob);
        vm.prank(bob);
        uint256[] memory got = cryptoEq.redeem(shares, bob);
        assertGt(got[0], 0, "bob leaves in kind");
    }

    /// M2. Chainlink's 24 h feeds land seconds late every day: that must not close buying.
    function test_lateDailyFeedDoesNotTripTheBreaker() public {
        _refreshFeeds();
        _mockFeed(XLayer.FEED_USDG, _feedAnswer(XLayer.FEED_USDG), 86_430); // 30 s past 24 h
        assertEq(oracle.ageClass(USDG), 1, "within heartbeat + 15 min");
        DarwinBasket[8] memory all = [blue, bal, okx, tech, core, frontier, cryptoEq, allWeather];
        for (uint256 i; i < all.length; i++) {
            assertFalse(guard.poke(address(all[i])), "not tripped");
        }
        assertTrue(guard.buyOpen(address(blue)));
        _buy(alice, blue, USDG, 100e6);
    }

    /// L1. The router only trades the studio's baskets.
    function test_fakeBasketIsRefused() public {
        deal(USDG, address(router), 1_000e6);
        vm.startPrank(attacker);
        FakeBasket fake = new FakeBasket(USDG, 1_000e6);
        fake.approve(address(router), 1e18);
        vm.expectRevert(abi.encodeWithSelector(DarwinRouter.NotABasket.selector, address(fake)));
        router.sell(DarwinBasket(address(fake)), 1e18, USDG, 0, block.timestamp, attacker);
        vm.stopPrank();
        _fund(attacker, USDG, 10e6);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(DarwinRouter.NotABasket.selector, address(fake)));
        router.buy(DarwinBasket(address(fake)), USDG, 10e6, 0, block.timestamp, attacker);
        assertEq(IERC20(USDG).balanceOf(address(router)), 1_000e6);
    }

    /// L2. A dust allocation goes to the largest leg instead of reverting the buy.
    function test_dustLegsGoToTheLargestLeg() public view {
        uint256[] memory v = new uint256[](2);
        uint256[] memory t = new uint256[](2);
        (t[0], t[1]) = (5_000, 5_000);
        v[0] = 150e18 - 1e15; // a hair under its post-trade target
        v[1] = 50e18;
        uint256[] memory alloc = router.allocate(v, t, 100e6, 100e18, 10_000);
        assertEq(alloc[0], 0, "no dust leg");
        assertEq(alloc[1], 100e6, "all to the other coin");
    }

    function test_allocationFuzzNeverLeavesDust(uint96 a, uint96 b, uint96 c, uint64 q) public view {
        vm.assume(q > 1e6);
        uint256[] memory v = new uint256[](3);
        (v[0], v[1], v[2]) = (a, b, c);
        uint256[] memory t = new uint256[](3);
        (t[0], t[1], t[2]) = (5000, 3000, 2000);
        uint256[] memory alloc = router.allocate(v, t, q, uint256(q) * 1e12, 10_000);
        assertEq(alloc[0] + alloc[1] + alloc[2], q, "everything allocated");
        for (uint256 i; i < 3; i++) {
            assertTrue(alloc[i] == 0 || alloc[i] >= 10_000, "no dust");
        }
    }

    /// L3. Launching costs a fee per gate, paid to the treasury.
    function test_launchFeeGrowsWithGates() public {
        (bytes memory nl,,) = _netlist("fixture-nvda-btc");
        uint256 gates = nl.length / 7;
        uint256 fee = studio.launchFee(gates);
        assertEq(fee, processor.TAPEOUT_FEE() + gates * studio.GATE_FEE());
        address carol = makeAddr("carol");
        vm.deal(carol, 1 ether);
        uint256 before = treasury.balance;
        address[] memory coins = new address[](2);
        (coins[0], coins[1]) = (WNVDAX, XBTC);
        vm.prank(carol);
        vm.expectRevert();
        studio.createStrategy{value: fee - 1}("x", "X", coins, nl);
        vm.prank(carol);
        studio.createStrategy{value: fee}("x", "X", coins, nl);
        assertEq(treasury.balance - before, gates * studio.GATE_FEE());
    }

    /// L4. A methodology that keeps weighting an ineligible coin is refused, at launch and later.
    function test_methodologyMustIgnoreIneligibleCoins() public {
        (bytes memory nl,,) = _netlist("fixture-ignores-eligibility");
        address[] memory coins = new address[](2);
        (coins[0], coins[1]) = (WNVDAX, XBTC);
        address carol = makeAddr("carol");
        vm.deal(carol, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(DarwinGuard.BadWeights.selector, 0, uint8(50), false));
        studio.createStrategy{value: fee}("x", "X", coins, nl);
    }

    function test_proposalIsCheckedLikeALaunch() public {
        // a valid circuit for three coins is not a methodology for Core's two
        vm.prank(owner);
        vm.expectRevert();
        core.proposeMethodology(circuitId["darwin-bluechip"], circuitHash["darwin-bluechip"]);
    }

    /// The history is on chain (public RPCs search logs 100 blocks at a time).
    function test_tradesAreRecordedOnChain() public {
        uint256 n0 = router.tradeCount();
        uint256 shares = _buy(alice, blue, USDG, 200e6);
        _sell(alice, blue, shares / 2, USDC);
        assertEq(router.tradeCount(), n0 + 2);
        (DarwinRouter.Trade[] memory mine,) = router.recentOfTrader(alice, 10);
        assertEq(mine.length, 2);
        assertFalse(mine[0].isBuy);
        assertEq(mine[0].payToken, USDC);
        assertEq(mine[0].shares, shares / 2);
        assertTrue(mine[1].isBuy);
        assertEq(mine[1].amount, 200e6);
        assertEq(mine[1].basket, address(blue));
        (DarwinRouter.Trade[] memory ofBlue,) = router.recentOfBasket(address(blue), 1);
        assertEq(ofBlue.length, 1);
        assertEq(ofBlue[0].blockNumber, block.number);
    }
}
