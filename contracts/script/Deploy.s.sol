// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {DarwinOracle} from "../src/DarwinOracle.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";
import {DarwinStudio} from "../src/DarwinStudio.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {XLayer} from "./XLayer.sol";
import {
    IAggregator, IBeacon, ISwapRouter02, ITapeoutFactory, ITapeoutProcessor, ITransistors
} from "../src/interfaces/External.sol";

interface IObservations {
    function increaseObservationCardinalityNext(uint16 next) external;
}

/// Deploy Darwin on X Layer: a TapeOut processor of our own, the policy and breaker circuits, the
/// oracle, guard, router and studio, then Darwin's eight strategies launched through the studio.
///
///   forge script script/Deploy.s.sol --rpc-url <url> --broadcast --private-key <key>
///
/// Env: PROCESSOR (reuse an existing Darwin processor), TREASURY (defaults to the deployer),
/// OUT (deployments file, defaults to ../deployments/xlayer.json).
contract Deploy is Script {
    struct Strategy {
        string name;
        string symbol;
        string circuit;
        address[] coins;
    }

    function run() external {
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY", deployer);
        string memory out = vm.envOr("OUT", string("../deployments/xlayer.json"));
        vm.startBroadcast();

        ITapeoutProcessor processor = ITapeoutProcessor(vm.envOr("PROCESSOR", address(0)));
        if (address(processor) == address(0)) {
            IERC20(XLayer.BEM).approve(XLayer.TAPEOUT_FACTORY, type(uint256).max);
            (address t, address c) = ITapeoutFactory(XLayer.TAPEOUT_FACTORY).createCPU(
                "Darwin", "DRWN", "Darwin: crypto and stock index baskets whose rules are circuits", 1_000_000, 0
            );
            IERC20(XLayer.BEM).approve(t, type(uint256).max);
            IERC20(XLayer.BEM).approve(c, type(uint256).max);
            processor = ITapeoutProcessor(c);
            ITransistors(t).mint(0, 20_000);
            ITransistors(t).mint(1, 100);
        }
        uint256 policyId = _tapeout(processor, "darwin-trade-policy");
        uint256 breakerId = _tapeout(processor, "darwin-breaker");

        DarwinOracle oracle = new DarwinOracle(XLayer.USDG, IAggregator(XLayer.FEED_SEQUENCER), XLayer.markets());
        DarwinGuard guard = new DarwinGuard(
            processor,
            IBeacon(XLayer.TAPEOUT_BEACON),
            oracle,
            policyId,
            _hash("darwin-trade-policy"),
            breakerId,
            _hash("darwin-breaker")
        );
        DarwinRouter router = new DarwinRouter(guard, ISwapRouter02(XLayer.SWAP_ROUTER), treasury);
        DarwinStudio studio = new DarwinStudio(guard, address(router));
        IERC1155(processor.transistors()).safeTransferFrom(deployer, address(studio), 0, 10_000, "");

        // longer price histories on the pools whose TWAP window is short (skipped on a local fork,
        // where every new observation slot is fetched from the remote node)
        uint16 card = uint16(vm.envOr("CARDINALITY", uint256(1800)));
        address[6] memory pools =
            [XLayer.POOL_XBTC, XLayer.POOL_XETH, XLayer.POOL_WAAPLX, XLayer.POOL_WGOOGLX, XLayer.POOL_WCRCLX, XLayer.POOL_WMSTRX];
        for (uint256 i; card > 0 && i < pools.length; i++) {
            IObservations(pools[i]).increaseObservationCardinalityNext(card);
        }

        Strategy[] memory s = _strategies();
        address[] memory baskets = new address[](s.length);
        for (uint256 i; i < s.length; i++) {
            bytes memory nl = vm.parseJsonBytes(_json(s[i].circuit), ".netlist");
            baskets[i] = address(studio.createStrategy{value: studio.launchFee()}(s[i].name, s[i].symbol, s[i].coins, nl));
        }
        vm.stopBroadcast();

        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "block", block.number);
        vm.serializeAddress(j, "processor", address(processor));
        vm.serializeUint(j, "policyCircuit", policyId);
        vm.serializeUint(j, "breakerCircuit", breakerId);
        vm.serializeAddress(j, "oracle", address(oracle));
        vm.serializeAddress(j, "guard", address(guard));
        vm.serializeAddress(j, "router", address(router));
        vm.serializeAddress(j, "studio", address(studio));
        vm.serializeAddress(j, "treasury", treasury);
        string memory all = vm.serializeAddress(j, "baskets", baskets);
        vm.writeJson(all, out);
        console2.log("deployment written to", out);
    }

    function _strategies() internal pure returns (Strategy[] memory s) {
        s = new Strategy[](8);
        s[0] = Strategy("Darwin US Tech", "TECHdw", "darwin-us-tech", _a5(XLayer.WNVDAX, XLayer.WQQQX, XLayer.WAAPLX, XLayer.WGOOGLX, XLayer.WTSLAX));
        s[1] = Strategy("Darwin US Core", "COREdw", "darwin-us-core", _a2(XLayer.WSPYX, XLayer.WQQQX));
        s[2] = Strategy("Darwin Frontier", "FRONTdw", "darwin-frontier", _a3(XLayer.WSPCXX, XLayer.WTSLAX, XLayer.WNVDAX));
        s[3] = Strategy("Darwin Crypto Equities", "CRYPTOEQdw", "darwin-crypto-equities", _a3(XLayer.WCRCLX, XLayer.WMSTRX, XLayer.XBTC));
        s[4] = Strategy("Darwin All Weather", "ALLdw", "darwin-all-weather", _a4(XLayer.WSPYX, XLayer.XBTC, XLayer.XETH, XLayer.USDG));
        s[5] = Strategy("Darwin Blue Chip", "BLUEdw", "darwin-bluechip", _a3(XLayer.XBTC, XLayer.XETH, XLayer.XSOL));
        s[6] = Strategy("Darwin Balanced", "BALdw", "darwin-balanced", _a3(XLayer.XBTC, XLayer.XETH, XLayer.USDG));
        s[7] = Strategy("Darwin OKX Ecosystem", "OKXdw", "darwin-okx-ecosystem", _a3(XLayer.WOKB, XLayer.XBTC, XLayer.XETH));
    }

    function _json(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat("../circuits/build/", name, ".json"));
    }

    function _hash(string memory name) internal view returns (bytes32) {
        return keccak256(vm.parseJsonBytes(_json(name), ".netlist"));
    }

    function _tapeout(ITapeoutProcessor p, string memory name) internal returns (uint256) {
        string memory j = _json(name);
        return p.tapeout{value: p.TAPEOUT_FEE()}(
            vm.parseJsonBytes(j, ".netlist"), uint32(vm.parseJsonUint(j, ".nIn")), uint32(vm.parseJsonUint(j, ".nOut"))
        );
    }

    function _a2(address a, address b) internal pure returns (address[] memory x) {
        x = new address[](2);
        (x[0], x[1]) = (a, b);
    }

    function _a3(address a, address b, address c) internal pure returns (address[] memory x) {
        x = new address[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    function _a4(address a, address b, address c, address d) internal pure returns (address[] memory x) {
        x = new address[](4);
        (x[0], x[1], x[2], x[3]) = (a, b, c, d);
    }

    function _a5(address a, address b, address c, address d, address e) internal pure returns (address[] memory x) {
        x = new address[](5);
        (x[0], x[1], x[2], x[3], x[4]) = (a, b, c, d, e);
    }
}
