// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";
import {DarwinStudio} from "../src/DarwinStudio.sol";

/// Beat every basket's breaker that is due: an unhealthy market trips at once, a healthy beat
/// counts once per 15 minutes. Anyone can run it; Darwin runs it on a schedule.
///
///   DEPLOYMENT=../deployments/xlayer.json forge script script/Poke.s.sol --rpc-url <url> --broadcast
contract Poke is Script {
    function run() external {
        string memory j = vm.readFile(vm.envOr("DEPLOYMENT", string("../deployments/xlayer.json")));
        DarwinGuard guard = DarwinGuard(vm.parseJsonAddress(j, ".guard"));
        DarwinStudio studio = DarwinStudio(payable(vm.parseJsonAddress(j, ".studio")));
        address[] memory baskets = studio.allBaskets();
        vm.startBroadcast();
        for (uint256 i; i < baskets.length; i++) {
            (uint8 state, uint64 last) = guard.breakers(baskets[i]);
            (, bool trips, uint8 bits) = guard.preview(baskets[i]);
            bool healthy = bits == 31;
            if (healthy && block.timestamp < last + guard.BEAT_INTERVAL()) continue;
            if (healthy && state == 0 && last != 0) continue; // open and healthy: nothing to count
            guard.poke(baskets[i]);
            console2.log(baskets[i], bits, trips ? "tripped" : "open");
        }
        vm.stopBroadcast();
    }
}
