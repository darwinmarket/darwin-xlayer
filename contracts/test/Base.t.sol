// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {DarwinOracle} from "../src/DarwinOracle.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinRouter, IStudioRegistry} from "../src/DarwinRouter.sol";
import {DarwinStudio} from "../src/DarwinStudio.sol";
import {XLayer} from "../script/XLayer.sol";
import {
    IAggregator, IBeacon, ISwapRouter02, ITapeoutFactory, ITapeoutProcessor, ITransistors
} from "../src/interfaces/External.sol";

/// Everything on a fork of X Layer mainnet: the real TapeOut factory (a fresh processor of ours,
/// our circuits taped out on it), the real Chainlink feeds, the real Uniswap v3 pools and xStocks.
abstract contract XLayerFork is Test {
    address constant USDG = XLayer.USDG;
    address constant USDT0 = XLayer.USDT0;
    address constant USDC = XLayer.USDC;
    address constant XBTC = XLayer.XBTC;
    address constant XETH = XLayer.XETH;
    address constant XSOL = XLayer.XSOL;
    address constant WOKB = XLayer.WOKB;
    address constant WNVDAX = XLayer.WNVDAX;
    address constant WSPYX = XLayer.WSPYX;
    address constant WQQQX = XLayer.WQQQX;
    address constant WTSLAX = XLayer.WTSLAX;
    address constant WSPCXX = XLayer.WSPCXX;
    address constant WAAPLX = XLayer.WAAPLX;
    address constant WGOOGLX = XLayer.WGOOGLX;
    address constant WCRCLX = XLayer.WCRCLX;
    address constant WMSTRX = XLayer.WMSTRX;

    /// Friday 2026-11-20 16:00 UTC: US stocks in session, every feed live.
    uint256 constant WEEKDAY_BLOCK = 76_421_394;
    /// Sunday 2026-11-22 12:00 UTC: stocks closed, crypto open.
    uint256 constant WEEKEND_BLOCK = 76_579_805;

    ITapeoutProcessor processor;
    DarwinOracle oracle;
    DarwinGuard guard;
    DarwinRouter router;
    DarwinStudio studio;
    uint256 policyId;
    uint256 breakerId;
    mapping(string => DarwinBasket) basket;
    mapping(string => bytes32) circuitHash;
    mapping(string => uint256) circuitId;

    DarwinBasket blue;
    DarwinBasket bal;
    DarwinBasket okx;
    DarwinBasket tech;
    DarwinBasket core;
    DarwinBasket frontier;
    DarwinBasket cryptoEq;
    DarwinBasket allWeather;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function forkBlock() internal view virtual returns (uint256) {
        return WEEKDAY_BLOCK;
    }

    function setUp() public virtual {
        vm.createSelectFork(vm.rpcUrl("xlayer"), forkBlock());
        vm.deal(owner, 100 ether);

        // a processor of our own on the real TapeOut factory (0.1 BEM), transistors for our circuits
        vm.startPrank(owner);
        deal(XLayer.BEM, owner, 100e8);
        IERC20(XLayer.BEM).approve(XLayer.TAPEOUT_FACTORY, type(uint256).max);
        (address transistors, address circuits) =
            ITapeoutFactory(XLayer.TAPEOUT_FACTORY).createCPU("Darwin", "DRWN", "Darwin index circuits", 1_000_000, 0);
        IERC20(XLayer.BEM).approve(transistors, type(uint256).max);
        IERC20(XLayer.BEM).approve(circuits, type(uint256).max);
        processor = ITapeoutProcessor(circuits);
        ITransistors(transistors).mint(0, 20_000);
        ITransistors(transistors).mint(1, 100);
        policyId = _tapeout("darwin-trade-policy");
        breakerId = _tapeout("darwin-breaker");
        vm.stopPrank();

        oracle = new DarwinOracle(USDG, IAggregator(XLayer.FEED_SEQUENCER), XLayer.markets());
        guard = new DarwinGuard(
            processor,
            IBeacon(XLayer.TAPEOUT_BEACON),
            oracle,
            policyId,
            circuitHash["darwin-trade-policy"],
            breakerId,
            circuitHash["darwin-breaker"]
        );
        address studioAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        router = new DarwinRouter(guard, ISwapRouter02(XLayer.SWAP_ROUTER), treasury, IStudioRegistry(studioAt));
        studio = new DarwinStudio(guard, address(router), treasury);
        assertEq(address(studio), studioAt);
        vm.prank(owner);
        IERC1155(transistors).safeTransferFrom(owner, address(studio), 0, 10_000, "");

        // Darwin's own strategies, launched through the studio like anyone's
        blue = _launch("Darwin Blue Chip", "BLUEdw", "darwin-bluechip", _list3(XBTC, XETH, XSOL));
        bal = _launch("Darwin Balanced", "BALdw", "darwin-balanced", _list3(XBTC, XETH, USDG));
        okx = _launch("Darwin OKX Ecosystem", "OKXdw", "darwin-okx-ecosystem", _list3(WOKB, XBTC, XETH));
        address[] memory t5 = new address[](5);
        (t5[0], t5[1], t5[2], t5[3], t5[4]) = (WNVDAX, WQQQX, WAAPLX, WGOOGLX, WTSLAX);
        tech = _launch("Darwin US Tech", "TECHdw", "darwin-us-tech", t5);
        address[] memory c2 = new address[](2);
        (c2[0], c2[1]) = (WSPYX, WQQQX);
        core = _launch("Darwin US Core", "COREdw", "darwin-us-core", c2);
        frontier = _launch("Darwin Frontier", "FRONTdw", "darwin-frontier", _list3(WSPCXX, WTSLAX, WNVDAX));
        cryptoEq = _launch("Darwin Crypto Equities", "CRYPTOEQdw", "darwin-crypto-equities", _list3(WCRCLX, WMSTRX, XBTC));
        address[] memory a4 = new address[](4);
        (a4[0], a4[1], a4[2], a4[3]) = (WSPYX, XBTC, XETH, USDG);
        allWeather = _launch("Darwin All Weather", "ALLdw", "darwin-all-weather", a4);

        // the first buy of each basket (the stock ones need an open market)
        _firstBuys();
    }

    function _firstBuys() internal virtual {
        DarwinBasket[8] memory all = [blue, bal, okx, tech, core, frontier, cryptoEq, allWeather];
        for (uint256 i; i < all.length; i++) {
            _buy(owner, all[i], USDG, 50e6);
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------

    function _netlist(string memory name) internal view returns (bytes memory nl, uint32 nIn, uint32 nOut) {
        string memory json = vm.readFile(string.concat("../circuits/build/", name, ".json"));
        nl = vm.parseJsonBytes(json, ".netlist");
        nIn = uint32(vm.parseJsonUint(json, ".nIn"));
        nOut = uint32(vm.parseJsonUint(json, ".nOut"));
    }

    function _tapeout(string memory name) internal returns (uint256 id) {
        (bytes memory nl, uint32 nIn, uint32 nOut) = _netlist(name);
        id = processor.tapeout{value: processor.TAPEOUT_FEE()}(nl, nIn, nOut);
        circuitId[name] = id;
        circuitHash[name] = keccak256(nl);
    }

    function _launch(string memory name, string memory sym, string memory method, address[] memory coins)
        internal
        returns (DarwinBasket b)
    {
        (bytes memory nl,,) = _netlist(method);
        uint256 fee = studio.launchFee(nl.length / 7);
        vm.prank(owner);
        b = studio.createStrategy{value: fee}(name, sym, coins, nl);
        circuitId[method] = studio.circuitOf(address(b));
        circuitHash[method] = keccak256(nl);
        basket[sym] = b;
    }

    function _list3(address a, address b, address c) internal pure returns (address[] memory x) {
        x = new address[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    function _fund(address who, address token, uint256 amount) internal {
        deal(token, who, amount);
        vm.prank(who);
        IERC20(token).approve(address(router), type(uint256).max);
    }

    function _buy(address who, DarwinBasket b, address payToken, uint256 amount) internal returns (uint256 shares) {
        _fund(who, payToken, amount);
        vm.prank(who);
        shares = router.buy(b, payToken, amount, 0, block.timestamp, who);
    }

    function _sell(address who, DarwinBasket b, uint256 shares, address payToken) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20(address(b)).approve(address(router), shares);
        out = router.sell(b, shares, payToken, 0, block.timestamp, who);
        vm.stopPrank();
    }

    /// USD value of one share, 18 decimals.
    function _navPerShare(DarwinBasket b) internal view returns (uint256) {
        return b.nav() * 1e18 / b.totalSupply();
    }

    /// Make a Chainlink feed answer `answer` (feed decimals) updated `age` seconds ago.
    function _mockFeed(address feed, int256 answer, uint256 age) internal {
        uint256 now_ = vm.getBlockTimestamp();
        vm.mockCall(
            feed,
            abi.encodeWithSelector(IAggregator.latestRoundData.selector),
            abi.encode(uint80(1), answer, now_ - age, now_ - age, uint80(1))
        );
    }

    function _feedAnswer(address feed) internal view returns (int256 a) {
        (, a,,,) = IAggregator(feed).latestRoundData();
    }

    /// Move a pool's price by swapping `amount` of `tokenIn` through it (a whale or a manipulator).
    function _pushPool(address tokenIn, address tokenOut, uint24 fee, uint256 amount) internal {
        address whale = makeAddr("whale");
        deal(tokenIn, whale, amount);
        vm.startPrank(whale);
        IERC20(tokenIn).approve(XLayer.SWAP_ROUTER, amount);
        ISwapRouter02(XLayer.SWAP_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, whale, amount, 0, 0)
        );
        vm.stopPrank();
    }

    /// Every feed answered a minute ago and the sequencer has been up for a month (after a warp).
    function _refreshFeeds() internal {
        address[15] memory feeds = [
            XLayer.FEED_BTC,
            XLayer.FEED_ETH,
            XLayer.FEED_SOL,
            XLayer.FEED_OKB,
            XLayer.FEED_USDG,
            XLayer.FEED_USDT0,
            XLayer.FEED_USDC,
            XLayer.FEED_XBTC_BTC,
            XLayer.FEED_WNVDAX,
            XLayer.FEED_WSPYX,
            XLayer.FEED_WQQQX,
            XLayer.FEED_WTSLAX,
            XLayer.FEED_WAAPLX,
            XLayer.FEED_WGOOGLX,
            XLayer.FEED_WSPCXX
        ];
        for (uint256 i; i < feeds.length; i++) {
            _mockFeed(feeds[i], _feedAnswer(feeds[i]), 60);
        }
        _mockFeed(XLayer.FEED_WCRCLX, _feedAnswer(XLayer.FEED_WCRCLX), 60);
        _mockFeed(XLayer.FEED_WMSTRX, _feedAnswer(XLayer.FEED_WMSTRX), 60);
        uint256 now_ = vm.getBlockTimestamp();
        vm.mockCall(
            XLayer.FEED_SEQUENCER,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(0), now_ - 30 days, now_ - 30 days, uint80(1))
        );
    }
}
