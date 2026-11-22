// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";
import {DarwinStudio} from "../src/DarwinStudio.sol";
import {XLayer} from "./XLayer.sol";

/// The first buy of every basket that has none yet (it locks 1 USD of shares at DEAD).
/// Stock baskets need the US market in session.
///
///   AMOUNT=10000000 DEPLOYMENT=../deployments/xlayer.json forge script script/FirstBuys.s.sol --rpc-url <url> --broadcast
contract FirstBuys is Script {
    function run() external {
        string memory j = vm.readFile(vm.envOr("DEPLOYMENT", string("../deployments/xlayer.json")));
        DarwinRouter router = DarwinRouter(vm.parseJsonAddress(j, ".router"));
        DarwinStudio studio = DarwinStudio(payable(vm.parseJsonAddress(j, ".studio")));
        uint256 amount = vm.envOr("AMOUNT", uint256(10e6)); // 10 USDG each
        address[] memory baskets = studio.allBaskets();
        vm.startBroadcast();
        IERC20(XLayer.USDG).approve(address(router), type(uint256).max);
        for (uint256 i; i < baskets.length; i++) {
            DarwinBasket b = DarwinBasket(baskets[i]);
            if (b.totalSupply() > 0) continue;
            try router.buy(b, XLayer.USDG, amount, 0, block.timestamp + 600, msg.sender) returns (uint256 shares) {
                console2.log(b.symbol(), "first buy, shares:", shares);
            } catch {
                console2.log(b.symbol(), "skipped (market closed or refused)");
            }
        }
        vm.stopBroadcast();
    }
}
