// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XLayerFork} from "./Base.t.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";

/// Random buys, sells and in-kind redemptions by several users on a stock basket and a crypto
/// basket, on the mainnet fork.
contract Handler is Test {
    DarwinRouter public router;
    DarwinBasket[] public baskets;
    address[] public users;
    address public usdg;
    uint256 public buys;
    uint256 public sells;
    uint256 public redeems;

    constructor(DarwinRouter router_, DarwinBasket[] memory baskets_, address usdg_) {
        router = router_;
        baskets = baskets_;
        usdg = usdg_;
        for (uint256 i; i < 3; i++) {
            users.push(makeAddr(string.concat("user", vm.toString(i))));
        }
    }

    function buy(uint256 u, uint256 b, uint256 amount) external {
        address who = users[u % users.length];
        DarwinBasket basket = baskets[b % baskets.length];
        amount = bound(amount, 10e6, 3_000e6);
        deal(usdg, who, amount);
        vm.startPrank(who);
        IERC20(usdg).approve(address(router), amount);
        router.buy(basket, usdg, amount, 0, block.timestamp, who);
        vm.stopPrank();
        buys++;
    }

    function sell(uint256 u, uint256 b, uint256 fraction) external {
        address who = users[u % users.length];
        DarwinBasket basket = baskets[b % baskets.length];
        uint256 shares = basket.balanceOf(who) * bound(fraction, 1, 100) / 100;
        if (shares == 0) return;
        vm.startPrank(who);
        IERC20(address(basket)).approve(address(router), shares);
        router.sell(basket, shares, usdg, 0, block.timestamp, who);
        vm.stopPrank();
        sells++;
    }

    function redeem(uint256 u, uint256 b, uint256 fraction) external {
        address who = users[u % users.length];
        DarwinBasket basket = baskets[b % baskets.length];
        uint256 shares = basket.balanceOf(who) * bound(fraction, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(who);
        basket.redeem(shares, who);
        redeems++;
    }
}

contract InvariantTest is XLayerFork {
    Handler handler;
    DarwinBasket[] tracked;
    mapping(address => uint256) startNavPerShare;

    function setUp() public override {
        super.setUp();
        tracked.push(core);
        tracked.push(blue);
        handler = new Handler(router, tracked, USDG);
        for (uint256 i; i < tracked.length; i++) {
            startNavPerShare[address(tracked[i])] = _navPerShare(tracked[i]);
        }
        targetContract(address(handler));
    }

    /// Trading never takes value from holders: the value of a share does not fall (the oracle is
    /// frozen on the fork, so any fall would be value leaking to traders). 0.05% for rounding.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 15
    function invariant_navPerShareNeverFalls() public view {
        for (uint256 i; i < tracked.length; i++) {
            uint256 nps = _navPerShare(tracked[i]);
            assertGe(nps * 10_000, startNavPerShare[address(tracked[i])] * 9_995, "nav per share");
        }
    }

    /// The router never keeps anything between transactions.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 15
    function invariant_routerHoldsNothing() public view {
        address[6] memory tokens = [USDG, WSPYX, WQQQX, XBTC, XETH, XSOL];
        for (uint256 i; i < tokens.length; i++) {
            assertEq(IERC20(tokens[i]).balanceOf(address(router)), 0, "router balance");
        }
        assertEq(IERC20(address(core)).balanceOf(address(router)), 0);
        assertEq(IERC20(address(blue)).balanceOf(address(router)), 0);
    }

    /// Every share is backed: a basket with shares holds coins worth at least a dollar per DEAD share.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 15
    function invariant_sharesAreBacked() public view {
        for (uint256 i; i < tracked.length; i++) {
            assertGt(tracked[i].nav(), 0);
            assertGe(tracked[i].balanceOf(tracked[i].DEAD()), 1e18);
        }
    }
}
