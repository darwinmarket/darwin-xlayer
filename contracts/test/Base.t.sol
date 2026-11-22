// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DarwinOracle} from "../src/DarwinOracle.sol";
import {DarwinGuard} from "../src/DarwinGuard.sol";
import {DarwinBasket} from "../src/DarwinBasket.sol";
import {DarwinRouter} from "../src/DarwinRouter.sol";
import {
    IAggregator,
    IBeacon,
    ISwapRouter02,
    ITapeoutFactory,
    ITapeoutProcessor,
    ITransistors,
    IUniswapV3Pool
} from "../src/interfaces/External.sol";

/// Everything on a fork of X Layer mainnet: the real TapeOut factory (a fresh processor of ours,
/// our circuits taped out on it), the real Chainlink feeds, the real Uniswap v3 pools.
abstract contract XLayerFork is Test {
    // ---- X Layer mainnet ----
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;
    address constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address constant USDC = 0xB6CEceAB302E2E4948951eE7843FC24E92933061;
    address constant XBTC = 0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f;
    address constant XETH = 0xE7B000003A45145decf8a28FC755aD5eC5EA025A;
    address constant XSOL = 0x505000008DE8748DBd4422ff4687a4FC9bEba15b;
    address constant WOKB = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;

    address constant POOL_XBTC = 0x520F8c07A529FFb5230e76bCb8EA553D664e5b76;
    address constant POOL_XETH = 0x6E18CEbFb9C5BBcf127b97a6daB026E941FfF6D5;
    address constant POOL_XSOL = 0x1284d2df2bF7DaC317D219d055Bd16F8259E06Df;
    address constant POOL_WOKB = 0x5d7E3Ad08B0C52e460787677B0632Cd024Df437C;
    address constant POOL_USDT0 = 0x0cBe0dBE1400e57f371a38BD3b9bC80F7C3676dA;
    address constant POOL_USDC = 0xbB9a35F790EA6eA9763b99e885f33BCF95860d40;

    address constant FEED_BTC = 0x4D6f6488a2B3a5f7b088f276887f608a1e9805c4;
    address constant FEED_ETH = 0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b;
    address constant FEED_SOL = 0xF959E1B5cA535C28aD24F7f672Bf1A93900810cF;
    address constant FEED_OKB = 0x4Ff345b18a2bF894F8627F41501FBf30d5C5e7BE;
    address constant FEED_USDG = 0x385C6bDDE06b0E438319bF4ddBfFe51C521ABf3D;
    address constant FEED_USDT0 = 0x673b428Fd1df93a6F77fA7ea1F8eeD8A4Ff36b9f;
    address constant FEED_USDC = 0xB8a08c178D96C315FbFB5661ABD208477391BC40;
    address constant FEED_XBTC_BTC = 0x265342dc2EDD57c05c1410115E8fA5E02a7C0886;
    address constant FEED_SEQUENCER = 0x45c2b8C204568A03Dc7A2E32B71D67Fe97F908A9;

    address constant SWAP_ROUTER = 0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA;
    address constant TAPEOUT_FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    address constant TAPEOUT_BEACON = 0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C;

    address constant BEM = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952; // TapeOut's token: pays the processor deploy fee

    uint256 constant FORK_BLOCK = 76_612_000;

    // ---- deployed in setUp ----
    ITapeoutProcessor processor;
    DarwinOracle oracle;
    DarwinGuard guard;
    DarwinRouter router;
    DarwinBasket blue;
    DarwinBasket bal;
    DarwinBasket okx;
    uint256 policyId;
    uint256 breakerId;
    mapping(string => uint256) circuitId;
    mapping(string => bytes32) circuitHash;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public virtual {
        vm.createSelectFork(vm.rpcUrl("xlayer"), FORK_BLOCK);
        vm.deal(owner, 100 ether);

        // a processor of our own on the real TapeOut factory, and our circuits taped out on it
        vm.startPrank(owner);
        deal(BEM, owner, 100e8);
        IERC20(BEM).approve(TAPEOUT_FACTORY, type(uint256).max);
        (address transistors, address circuits) = ITapeoutFactory(TAPEOUT_FACTORY).createCPU(
            "Darwin", "DRWN", "Darwin index circuits", 100_000, 0
        );
        IERC20(BEM).approve(transistors, type(uint256).max);
        IERC20(BEM).approve(circuits, type(uint256).max);
        processor = ITapeoutProcessor(circuits);
        policyId = _tapeout("darwin-trade-policy");
        breakerId = _tapeout("darwin-breaker");
        _tapeout("darwin-bluechip");
        _tapeout("darwin-balanced");
        _tapeout("darwin-okx-ecosystem");
        vm.stopPrank();

        oracle = new DarwinOracle(USDG, IAggregator(FEED_SEQUENCER), _markets());
        guard = new DarwinGuard(
            processor,
            IBeacon(TAPEOUT_BEACON),
            oracle,
            policyId,
            circuitHash["darwin-trade-policy"],
            breakerId,
            circuitHash["darwin-breaker"]
        );
        router = new DarwinRouter(guard, ISwapRouter02(SWAP_ROUTER), treasury);

        blue = _basket("Darwin Blue Chip", "BLUEdw", "darwin-bluechip", _three(XBTC, XETH, XSOL));
        bal = _basket("Darwin Balanced", "BALdw", "darwin-balanced", _three(XBTC, XETH, USDG));
        okx = _basket("Darwin OKX Ecosystem", "OKXdw", "darwin-okx-ecosystem", _three(WOKB, XBTC, XETH));
        _seed(blue, 50e18);
        _seed(bal, 50e18);
        _seed(okx, 50e18);
    }

    // ---- helpers ---------------------------------------------------------------------------------

    function _tapeout(string memory name) internal returns (uint256 id) {
        string memory json = vm.readFile(string.concat("../circuits/build/", name, ".json"));
        bytes memory nl = vm.parseJsonBytes(json, ".netlist");
        uint256 nIn = vm.parseJsonUint(json, ".nIn");
        uint256 nOut = vm.parseJsonUint(json, ".nOut");
        uint256 nand = vm.parseJsonUint(json, ".nand");
        uint256 latch = vm.parseJsonUint(json, ".latch");
        // the price of a transistor is in OKB (ours is free); TapeOut's protocol fee is paid in BEM
        ITransistors t = ITransistors(processor.transistors());
        t.mint{value: nand * t.mintPrice()}(0, nand);
        if (latch > 0) t.mint{value: latch * t.mintPrice()}(1, latch);
        id = processor.tapeout{value: processor.TAPEOUT_FEE()}(nl, uint32(nIn), uint32(nOut));
        circuitId[name] = id;
        circuitHash[name] = keccak256(nl);
    }

    function _markets() internal pure returns (DarwinOracle.Market[] memory m) {
        m = new DarwinOracle.Market[](7);
        m[0] = _m(USDG, 6, FEED_USDG, address(0), 0, address(0));
        m[1] = _m(XBTC, 8, FEED_BTC, POOL_XBTC, 500, FEED_XBTC_BTC);
        m[2] = _m(XETH, 18, FEED_ETH, POOL_XETH, 500, address(0));
        m[3] = _m(XSOL, 9, FEED_SOL, POOL_XSOL, 500, address(0));
        m[4] = _m(WOKB, 18, FEED_OKB, POOL_WOKB, 500, address(0));
        m[5] = _m(USDT0, 6, FEED_USDT0, POOL_USDT0, 100, address(0));
        m[6] = _m(USDC, 6, FEED_USDC, POOL_USDC, 100, address(0));
    }

    function _m(address token, uint8 dec, address feed, address pool, uint24 fee, address reserve)
        internal
        pure
        returns (DarwinOracle.Market memory)
    {
        return DarwinOracle.Market(token, dec, IAggregator(feed), 86_400, IUniswapV3Pool(pool), fee, IAggregator(reserve));
    }

    function _three(address a, address b, address c) internal pure returns (address[] memory x) {
        x = new address[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    function _basket(string memory name, string memory sym, string memory method, address[] memory coins)
        internal
        returns (DarwinBasket b)
    {
        b = new DarwinBasket(name, sym, owner, address(router), guard, coins, circuitId[method], circuitHash[method]);
    }

    /// Seed a basket with `usd` (18 decimals) split by its targets, bought at the oracle price.
    function _seed(DarwinBasket b, uint256 usd) internal {
        address[] memory coins = b.coinList();
        (uint256[] memory t,) = b.targets();
        uint256[] memory amounts = new uint256[](coins.length);
        vm.startPrank(owner);
        for (uint256 i; i < coins.length; i++) {
            amounts[i] = oracle.amountFor(coins[i], usd * t[i] / 10_000);
            deal(coins[i], owner, amounts[i]);
            IERC20(coins[i]).approve(address(b), amounts[i]);
        }
        b.seed(amounts);
        vm.stopPrank();
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
        vm.mockCall(
            feed,
            abi.encodeWithSelector(IAggregator.latestRoundData.selector),
            abi.encode(uint80(1), answer, block.timestamp - age, block.timestamp - age, uint80(1))
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
        IERC20(tokenIn).approve(SWAP_ROUTER, amount);
        ISwapRouter02(SWAP_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, whale, amount, 0, 0)
        );
        vm.stopPrank();
    }
}
