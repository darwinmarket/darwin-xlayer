// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {XLayerFork} from "./Base.t.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinStudio} from "../src/DarwinStudio.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";

/// Anyone designs a strategy, tapes it out and launches it as a basket.
contract StudioTest is XLayerFork {
    address carol = makeAddr("carol");

    function _two(address a, address b) internal pure returns (address[] memory x) {
        x = new address[](2);
        (x[0], x[1]) = (a, b);
    }

    function _create(address who, string memory fixture, address[] memory coins) internal returns (DarwinBasket b) {
        (bytes memory nl,,) = _netlist(fixture);
        vm.deal(who, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(who);
        b = studio.createStrategy{value: fee}("Carol AI + BTC", "CAROLdw", coins, nl);
    }

    function test_anyoneLaunchesAStrategy() public {
        uint256 count = studio.basketCount();
        DarwinBasket b = _create(carol, "fixture-nvda-btc", _two(WNVDAX, XBTC));
        assertEq(studio.basketCount(), count + 1);
        assertTrue(studio.isBasket(address(b)));
        assertEq(b.owner(), carol);
        assertEq(b.creator(), carol);
        // carol owns the circuit NFT of her methodology
        assertEq(IERC721(address(processor)).ownerOf(studio.circuitOf(address(b))), carol);
        (uint256[] memory t, uint8 band) = b.targets();
        assertEq(t[0], 5000);
        assertEq(t[1], 5000);
        assertEq(band, 4);
    }

    function test_creatorEarnsAThirdOfTheFees() public {
        DarwinBasket b = _create(carol, "fixture-nvda-btc", _two(WNVDAX, XBTC));
        _buy(alice, b, USDG, 100e6); // first buy
        uint256 before = IERC20(USDG).balanceOf(carol);
        _buy(bob, b, USDG, 1_000e6);
        assertEq(IERC20(USDG).balanceOf(carol) - before, 999_900, "a third of the 0.30% fee on a 1,000 USD buy");
    }

    function test_excessFeeIsRefunded() public {
        (bytes memory nl,,) = _netlist("fixture-nvda-btc");
        vm.deal(carol, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(carol);
        studio.createStrategy{value: fee + 0.5 ether}("x", "X", _two(WNVDAX, XBTC), nl);
        assertEq(carol.balance, 1 ether - fee);
    }

    function test_refusesWeightsThatDoNotSumTo100() public {
        (bytes memory nl,,) = _netlist("fixture-bad-sum");
        vm.deal(carol, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(DarwinGuard.BadWeights.selector, type(uint256).max, uint8(90), true));
        studio.createStrategy{value: fee}("x", "X", _two(WNVDAX, XBTC), nl);
    }

    function test_refusesWeightOnAMissingCoin() public {
        (bytes memory nl,,) = _netlist("fixture-extra-index");
        vm.deal(carol, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(DarwinGuard.BadWeights.selector, 2, uint8(20), true));
        studio.createStrategy{value: fee}("x", "X", _two(WNVDAX, XBTC), nl);
    }

    function test_refusesAnUnlistedCoin() public {
        (bytes memory nl,,) = _netlist("fixture-nvda-btc");
        vm.deal(carol, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(carol);
        vm.expectRevert(DarwinStudio.BadCoins.selector);
        studio.createStrategy{value: fee}("x", "X", _two(WNVDAX, address(0xBAD)), nl);
    }

    function test_refusesACircuitWithLatches() public {
        (bytes memory nl,,) = _netlist("darwin-breaker"); // has LATCH records: not a methodology
        vm.deal(carol, 1 ether);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(carol);
        vm.expectRevert(DarwinStudio.BadNetlist.selector);
        studio.createStrategy{value: fee}("x", "X", _two(WNVDAX, XBTC), nl);
    }

    function test_refusesWithoutTheFee() public {
        (bytes memory nl,,) = _netlist("fixture-nvda-btc");
        uint256 fee = studio.launchFee(nl.length / 7);
        if (fee == 0) return; // a free processor has nothing to check
        vm.prank(carol);
        vm.expectRevert();
        studio.createStrategy("x", "X", _two(WNVDAX, XBTC), nl);
    }

    function test_creatorCanChangeTheMethodologyOnlyAfterTheTimelock() public {
        DarwinBasket b = _create(carol, "fixture-nvda-btc", _two(WNVDAX, XBTC));
        vm.prank(alice);
        vm.expectRevert();
        b.proposeMethodology(circuitId["darwin-us-core"], circuitHash["darwin-us-core"]);
        vm.prank(carol);
        b.proposeMethodology(circuitId["darwin-us-core"], circuitHash["darwin-us-core"]);
        vm.expectRevert();
        b.applyMethodology();
    }

    function test_firstBuyLocksADollarAtDead() public {
        DarwinBasket b = _create(carol, "fixture-nvda-btc", _two(WNVDAX, XBTC));
        _fund(alice, USDG, 4e6);
        vm.prank(alice);
        vm.expectRevert(); // under the 5 USD minimum
        router.buy(b, USDG, 4e6, 0, block.timestamp, alice);
        uint256 shares = _buy(alice, b, USDG, 20e6);
        assertEq(b.balanceOf(b.DEAD()), 1e18);
        assertApproxEqRel(shares + 1e18, b.nav(), 0.005e18, "1 share = 1 USD at launch");
        assertLe(shares + 1e18, b.nav(), "never more shares than value");
    }
}
