// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DarwinOracle} from "../src/DarwinOracle.sol";
import {IAggregator, IUniswapV3Pool} from "../src/interfaces/External.sol";

/// X Layer mainnet (chain 196): every market Darwin lists, with its Chainlink feed, its deepest
/// Uniswap v3 pool and the route to buy it with USDG. Checked on chain on 2026-11-22.
library XLayer {
    // ---- stablecoins ----
    address internal constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8; // Paxos Global Dollar, the quote
    address internal constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant USDC = 0xB6CEceAB302E2E4948951eE7843FC24E92933061;
    // ---- crypto ----
    address internal constant XBTC = 0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f;
    address internal constant XETH = 0xE7B000003A45145decf8a28FC755aD5eC5EA025A;
    address internal constant XSOL = 0x505000008DE8748DBd4422ff4687a4FC9bEba15b;
    address internal constant WOKB = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;
    // ---- tokenized US stocks (wrapped xStocks) ----
    address internal constant WNVDAX = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address internal constant WSPYX = 0xE7E553Cd128F0011777323A0b44a7b96EA1CB540;
    address internal constant WQQQX = 0x4C1AE29c159838fC1b224636E28E086EB69101f7;
    address internal constant WTSLAX = 0xc3FdBe3A68EE5dE461D30415a8165cf9Aefe1171;
    address internal constant WSPCXX = 0x8e2eeD8b8B5E13Ea7BF38e50d7821d2C57309072;
    address internal constant WAAPLX = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    address internal constant WGOOGLX = 0xf8c5308F80E459bb53d9EbE689854d9cBb2Caa6f;
    address internal constant WCRCLX = 0xb11134F14d5B94DB60d4599DfdC3bF1bbA2150e8;
    address internal constant WMSTRX = 0x30987adF0B11dc698438a99BA04ec3a1AB2c7EaB;

    // ---- Uniswap v3 pools ----
    address internal constant POOL_XBTC = 0x520F8c07A529FFb5230e76bCb8EA553D664e5b76; // xBTC/USDG 0.05%
    address internal constant POOL_XETH = 0x6E18CEbFb9C5BBcf127b97a6daB026E941FfF6D5; // xETH/USDG 0.05%
    address internal constant POOL_XSOL = 0x1284d2df2bF7DaC317D219d055Bd16F8259E06Df; // xSOL/USDG 0.05%
    address internal constant POOL_WOKB = 0x5d7E3Ad08B0C52e460787677B0632Cd024Df437C; // WOKB/USDG 0.05%
    address internal constant POOL_USDT0 = 0x0cBe0dBE1400e57f371a38BD3b9bC80F7C3676dA; // USDT0/USDG 0.01%
    address internal constant POOL_USDC = 0xbB9a35F790EA6eA9763b99e885f33BCF95860d40; // USDC/USDG 0.01%
    address internal constant POOL_WNVDAX = 0x2a2B11730C2b6d99a58034A869dd810D7300a7b2; // wNVDAx/USDG 0.05%
    address internal constant POOL_WSPYX = 0x07c40850D14064D20eB0AfDEf9574675392f2c11; // wSPYx/USDG 0.05%
    address internal constant POOL_WQQQX = 0x2Bd90724ffc80ba22Ec7Af8CFd2B4b51Ff395b04; // wQQQx/USDC 0.05%
    address internal constant POOL_WTSLAX = 0x6A58944EEd3d2074E137Eb4e94b302FE4AF247a6; // wTSLAx/USDC 0.05%
    address internal constant POOL_WSPCXX = 0x535AabfAF9A6Fbc1A04317b98885706dc6Bf1650; // wSPCXx/USDG 0.05%
    address internal constant POOL_WAAPLX = 0xfDd9f2a36645Ab7A65e04B32CC23a4184728b47c; // wAAPLx/USDC 0.05%
    address internal constant POOL_WGOOGLX = 0x091F2AbEb246fC3A186457Af9e3aaaB3C78E6832; // wGOOGLx/wSPYx 0.05%
    address internal constant POOL_WCRCLX = 0x5A87091008124f5C879844905B7F9A1Cd315Faf1; // wCRCLx/xBTC 0.05%
    address internal constant POOL_WMSTRX = 0xe08a6B107981d8a94eE9cEA32dD297aEF2d810e8; // wMSTRx/xBTC 0.05%

    // ---- Chainlink ----
    address internal constant FEED_USDG = 0x385C6bDDE06b0E438319bF4ddBfFe51C521ABf3D;
    address internal constant FEED_USDT0 = 0x673b428Fd1df93a6F77fA7ea1F8eeD8A4Ff36b9f;
    address internal constant FEED_USDC = 0xB8a08c178D96C315FbFB5661ABD208477391BC40;
    address internal constant FEED_BTC = 0x4D6f6488a2B3a5f7b088f276887f608a1e9805c4;
    address internal constant FEED_ETH = 0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b;
    address internal constant FEED_SOL = 0xF959E1B5cA535C28aD24F7f672Bf1A93900810cF;
    address internal constant FEED_OKB = 0x4Ff345b18a2bF894F8627F41501FBf30d5C5e7BE;
    address internal constant FEED_XBTC_BTC = 0x265342dc2EDD57c05c1410115E8fA5E02a7C0886;
    address internal constant FEED_WNVDAX = 0x761FE3B4C1043862bB0c53F5fAAe19F159F6b303;
    address internal constant FEED_WSPYX = 0xFf1Ad069D1500970e5f0e5375b011C24EA819950;
    address internal constant FEED_WQQQX = 0x70149e006a03dF3739B8C37E4d80145Dea4c09F6;
    address internal constant FEED_WTSLAX = 0xf35fE36ad2A24e8197A048135b3d1787b5665AB9;
    address internal constant FEED_WSPCXX = 0x54494E6Fb9eF83C18df10326cDb5b046E3D54Bd0;
    address internal constant FEED_WAAPLX = 0x363875dAB2910D1d7677a944EFE1BF5Be0c37E13;
    address internal constant FEED_WGOOGLX = 0x64B67C4C176E78064E0470a062C83c17AE0FA779;
    address internal constant FEED_WCRCLX = 0xbC0E9C5C5F51f93948e6A13d2bAD887BedD5d6Fa;
    address internal constant FEED_WMSTRX = 0x263EDDE0DCfc064f645778aE919E3f7aDA758018;
    address internal constant FEED_SEQUENCER = 0x45c2b8C204568A03Dc7A2E32B71D67Fe97F908A9;

    // ---- protocols ----
    address internal constant SWAP_ROUTER = 0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA;
    address internal constant TAPEOUT_FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    address internal constant TAPEOUT_BEACON = 0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C;
    address internal constant BEM = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952; // pays TapeOut's processor deploy fee

    uint32 internal constant CRYPTO_HEARTBEAT = 86_400; // Chainlink heartbeat on X Layer
    uint32 internal constant EQUITY_HEARTBEAT = 6 hours; // in session a 24/5 equity feed moves far more often

    /// The markets, pairs before the markets they price (the oracle checks that order).
    function markets() internal pure returns (DarwinOracle.Market[] memory m) {
        m = new DarwinOracle.Market[](18);
        uint256 k;
        m[k++] = _stable(USDG, FEED_USDG, address(0), 0);
        m[k++] = _stable(USDT0, FEED_USDT0, POOL_USDT0, 100);
        m[k++] = _stable(USDC, FEED_USDC, POOL_USDC, 100);
        m[k++] = _crypto(XBTC, 8, FEED_BTC, POOL_XBTC, FEED_XBTC_BTC);
        m[k++] = _crypto(XETH, 18, FEED_ETH, POOL_XETH, address(0));
        m[k++] = _crypto(XSOL, 9, FEED_SOL, POOL_XSOL, address(0));
        m[k++] = _crypto(WOKB, 18, FEED_OKB, POOL_WOKB, address(0));
        m[k++] = _stock(WNVDAX, FEED_WNVDAX, POOL_WNVDAX, USDG, abi.encodePacked(USDG, uint24(500), WNVDAX));
        m[k++] = _stock(WSPYX, FEED_WSPYX, POOL_WSPYX, USDG, abi.encodePacked(USDG, uint24(500), WSPYX));
        m[k++] = _stock(WSPCXX, FEED_WSPCXX, POOL_WSPCXX, USDG, abi.encodePacked(USDG, uint24(500), WSPCXX));
        m[k++] = _stock(WQQQX, FEED_WQQQX, POOL_WQQQX, USDC, abi.encodePacked(USDG, uint24(100), USDC, uint24(500), WQQQX));
        m[k++] = _stock(WTSLAX, FEED_WTSLAX, POOL_WTSLAX, USDC, abi.encodePacked(USDG, uint24(100), USDC, uint24(500), WTSLAX));
        m[k++] = _stock(WAAPLX, FEED_WAAPLX, POOL_WAAPLX, USDC, abi.encodePacked(USDG, uint24(100), USDC, uint24(500), WAAPLX));
        m[k++] = _stock(WGOOGLX, FEED_WGOOGLX, POOL_WGOOGLX, WSPYX, abi.encodePacked(USDG, uint24(500), WSPYX, uint24(500), WGOOGLX));
        m[k++] = _stock(WCRCLX, FEED_WCRCLX, POOL_WCRCLX, XBTC, abi.encodePacked(USDG, uint24(500), XBTC, uint24(500), WCRCLX));
        m[k++] = _stock(WMSTRX, FEED_WMSTRX, POOL_WMSTRX, XBTC, abi.encodePacked(USDG, uint24(500), XBTC, uint24(500), WMSTRX));
        assembly {
            mstore(m, k)
        }
    }

    function _stable(address t, address feed, address pool, uint24 fee) private pure returns (DarwinOracle.Market memory) {
        bytes memory path = pool == address(0) ? bytes("") : abi.encodePacked(USDG, fee, t);
        return DarwinOracle.Market(t, 6, 0, IAggregator(feed), CRYPTO_HEARTBEAT, IUniswapV3Pool(pool), USDG, path, IAggregator(address(0)));
    }

    function _crypto(address t, uint8 dec, address feed, address pool, address reserve)
        private
        pure
        returns (DarwinOracle.Market memory)
    {
        return DarwinOracle.Market(
            t, dec, 0, IAggregator(feed), CRYPTO_HEARTBEAT, IUniswapV3Pool(pool), USDG, abi.encodePacked(USDG, uint24(500), t), IAggregator(reserve)
        );
    }

    function _stock(address t, address feed, address pool, address pair, bytes memory path)
        private
        pure
        returns (DarwinOracle.Market memory)
    {
        return DarwinOracle.Market(t, 18, 1, IAggregator(feed), EQUITY_HEARTBEAT, IUniswapV3Pool(pool), pair, path, IAggregator(address(0)));
    }
}
