// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAggregator, IUniswapV3Pool} from "./interfaces/External.sol";

/// @title DarwinOracle
/// @notice Chainlink prices, Uniswap v3 spot prices and the market facts Darwin's circuits read.
/// Configured once at deployment, no admin: a new market means a new oracle.
contract DarwinOracle {
    struct Market {
        address token;
        uint8 decimals;
        IAggregator feed; // token/USD (or the underlying's USD feed for wrapped assets)
        uint32 heartbeat; // the feed's heartbeat, seconds
        IUniswapV3Pool pool; // token/quote pool used for trades (zero for the quote token itself)
        uint24 fee; // that pool's fee tier
        IAggregator reserveFeed; // optional: wrapped/underlying exchange rate (18 decimals), e.g. XBTC/BTC
    }

    /// The quote token every basket trades through (USDG).
    address public immutable quote;
    uint8 public immutable quoteDecimals;
    /// Chainlink L2 sequencer uptime feed.
    IAggregator public immutable sequencerFeed;

    uint256 public constant FRESH = 1 hours; // age class 0
    uint256 public constant GRACE = 1 hours; // after the heartbeat (class 2), and after a sequencer restart
    uint256 public constant MIN_RESERVE_RATE = 0.995e18; // a wrapped asset must stay 99.5% backed
    uint256 public constant PEG_BAND = 0.01e18; // a stablecoin within 1% of $1

    mapping(address => Market) internal markets;
    address[] public tokens;

    error UnknownToken(address token);
    error BadPrice(address token);
    error BadConfig();

    constructor(address quote_, IAggregator sequencerFeed_, Market[] memory list) {
        quote = quote_;
        sequencerFeed = sequencerFeed_;
        bool quoteListed;
        for (uint256 i; i < list.length; i++) {
            Market memory m = list[i];
            if (m.token == address(0) || address(m.feed) == address(0) || m.heartbeat == 0) revert BadConfig();
            if (markets[m.token].token != address(0)) revert BadConfig();
            if (m.token == quote_) {
                quoteListed = true;
                if (address(m.pool) != address(0)) revert BadConfig();
            } else {
                if (address(m.pool) == address(0)) revert BadConfig();
                bool pair = (m.pool.token0() == m.token && m.pool.token1() == quote_)
                    || (m.pool.token1() == m.token && m.pool.token0() == quote_);
                if (!pair || m.pool.fee() != m.fee) revert BadConfig();
            }
            markets[m.token] = m;
            tokens.push(m.token);
        }
        if (!quoteListed) revert BadConfig();
        quoteDecimals = markets[quote_].decimals;
    }

    function market(address token) public view returns (Market memory m) {
        m = markets[token];
        if (m.token == address(0)) revert UnknownToken(token);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ---- Chainlink -------------------------------------------------------------------------------

    /// USD price of one whole token, 18 decimals, and the time of the answer.
    function price(address token) public view returns (uint256 usd, uint256 updatedAt) {
        Market memory m = market(token);
        (, int256 answer,, uint256 at,) = m.feed.latestRoundData();
        if (answer <= 0 || at == 0 || at > block.timestamp) revert BadPrice(token);
        usd = uint256(answer) * 10 ** (18 - m.feed.decimals());
        updatedAt = at;
    }

    /// USD value (18 decimals) of `amount` base units of `token`.
    function value(address token, uint256 amount) public view returns (uint256) {
        (uint256 p,) = price(token);
        return Math.mulDiv(amount, p, 10 ** market(token).decimals);
    }

    /// Base units of `token` worth `usd` (18 decimals).
    function amountFor(address token, uint256 usd) public view returns (uint256) {
        (uint256 p,) = price(token);
        return Math.mulDiv(usd, 10 ** market(token).decimals, p);
    }

    /// 0: under an hour old, 1: within the heartbeat, 2: within heartbeat + grace, 3: stale.
    function ageClass(address token) public view returns (uint8) {
        Market memory m = market(token);
        (,,, uint256 at,) = m.feed.latestRoundData();
        if (at == 0 || at > block.timestamp) return 3;
        uint256 age = block.timestamp - at;
        if (age < FRESH) return 0;
        if (age <= m.heartbeat) return 1;
        if (age <= uint256(m.heartbeat) + GRACE) return 2;
        return 3;
    }

    /// The X Layer sequencer is up and has been for longer than the grace period.
    function sequencerUp() public view returns (bool) {
        if (address(sequencerFeed) == address(0)) return true;
        (, int256 answer, uint256 startedAt,,) = sequencerFeed.latestRoundData();
        return answer == 0 && startedAt != 0 && block.timestamp - startedAt > GRACE;
    }

    /// A wrapped asset with a reserve feed is at least 99.5% backed (true when it has none).
    function reserveOk(address token) public view returns (bool) {
        Market memory m = market(token);
        if (address(m.reserveFeed) == address(0)) return true;
        (, int256 rate,, uint256 at,) = m.reserveFeed.latestRoundData();
        if (rate <= 0 || at == 0) return false;
        uint256 r = uint256(rate) * 10 ** (18 - m.reserveFeed.decimals());
        return r >= MIN_RESERVE_RATE;
    }

    /// The quote stablecoin is within 1% of $1 by its own Chainlink feed.
    function quotePegOk() public view returns (bool) {
        (uint256 p,) = price(quote);
        return p >= 1e18 - PEG_BAND && p <= 1e18 + PEG_BAND;
    }

    // ---- Uniswap spot ----------------------------------------------------------------------------

    /// USD price of one whole token from its pool's current spot price (18 decimals). Easy to move
    /// within a block: Darwin only uses it to show prices, never to decide.
    function spotPrice(address token) public view returns (uint256) {
        Market memory m = market(token);
        if (token == quote) return _quoteUsd();
        (uint160 sqrtP,,,,,,) = m.pool.slot0();
        // (sqrtP^2 / 2^192) * 2^128: token1 base units per token0 base unit, Q128
        return _toUsd(m, Math.mulDiv(sqrtP, sqrtP, 1 << 64));
    }

    uint32 public constant TWAP_WINDOW = 30 minutes;

    /// USD price of one whole token from its pool's 30-minute time-weighted average (18 decimals).
    /// Moving it costs holding the pool off price for half an hour, not one flash loan.
    function twapPrice(address token) public view returns (uint256) {
        Market memory m = market(token);
        if (token == quote) return _quoteUsd();
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        (int56[] memory cum,) = m.pool.observe(ago);
        int56 delta = cum[1] - cum[0];
        int24 tick = int24(delta / int56(uint56(TWAP_WINDOW)));
        if (delta < 0 && delta % int56(uint56(TWAP_WINDOW)) != 0) tick--; // round towards -infinity
        return _toUsd(m, priceX128AtTick(tick));
    }

    function _quoteUsd() internal view returns (uint256 usd) {
        (usd,) = price(quote);
    }

    /// USD per whole token from a pool price (token1 base units per token0 base unit, Q128).
    function _toUsd(Market memory m, uint256 priceX128) internal view returns (uint256) {
        if (priceX128 == 0) revert BadPrice(m.token);
        uint256 quoteUnits; // quote base units per whole token, with 18 extra decimals
        if (m.pool.token0() == m.token) {
            quoteUnits = Math.mulDiv(priceX128, 10 ** m.decimals * 1e18, 1 << 128);
        } else {
            quoteUnits = Math.mulDiv(1 << 128, 10 ** m.decimals * 1e18, priceX128);
        }
        return Math.mulDiv(quoteUnits, _quoteUsd(), 10 ** quoteDecimals * 1e18);
    }

    /// 1.0001^tick as a Q128 number (token1 per token0 at that tick).
    function priceX128AtTick(int24 tick) public pure returns (uint256 r) {
        uint256 a = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        if (a > 887272) revert BadPrice(address(0));
        r = 1 << 128; // 1.0001^-a, built from 1.0001^-(2^i)
        if (a & 0x1 != 0) r = (r * 0xfff97272373d413259a46990580e2139) >> 128;
        if (a & 0x2 != 0) r = (r * 0xfff2e50f5f656932ef12357cf3c7fdcb) >> 128;
        if (a & 0x4 != 0) r = (r * 0xffe5caca7e10e4e61c3624eaa0941ccf) >> 128;
        if (a & 0x8 != 0) r = (r * 0xffcb9843d60f6159c9db58835c926643) >> 128;
        if (a & 0x10 != 0) r = (r * 0xff973b41fa98c081472e6896dfb254bf) >> 128;
        if (a & 0x20 != 0) r = (r * 0xff2ea16466c96a3843ec78b326b52860) >> 128;
        if (a & 0x40 != 0) r = (r * 0xfe5dee046a99a2a811c461f1969c3052) >> 128;
        if (a & 0x80 != 0) r = (r * 0xfcbe86c7900a88aedcffc83b479aa3a3) >> 128;
        if (a & 0x100 != 0) r = (r * 0xf987a7253ac413176f2b074cf7815e53) >> 128;
        if (a & 0x200 != 0) r = (r * 0xf3392b0822b70005940c7a398e4b70f2) >> 128;
        if (a & 0x400 != 0) r = (r * 0xe7159475a2c29b7443b29c7fa6e889d8) >> 128;
        if (a & 0x800 != 0) r = (r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (a & 0x1000 != 0) r = (r * 0xa9f746462d870fdf8a65dc1f90e061e4) >> 128;
        if (a & 0x2000 != 0) r = (r * 0x70d869a156d2a1b890bb3df62baf32f6) >> 128;
        if (a & 0x4000 != 0) r = (r * 0x31be135f97d08fd981231505542fcfa5) >> 128;
        if (a & 0x8000 != 0) r = (r * 0x9aa508b5b7a84e1c677de54f3e99bc8) >> 128;
        if (a & 0x10000 != 0) r = (r * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (a & 0x20000 != 0) r = (r * 0x2216e584f5fa1ea926041bedfe97) >> 128;
        if (a & 0x40000 != 0) r = (r * 0x48a170391f7dc42444e8fa2) >> 128;
        if (a & 0x80000 != 0) r = (r * 0x149b34ee7ac262) >> 128;
        if (tick > 0) r = Math.mulDiv(1 << 128, 1 << 128, r);
    }

    /// |a - b| / b in steps of 1/400 (0.25%), saturating at 15.
    function deviationSteps(uint256 a, uint256 b) public pure returns (uint8) {
        uint256 d = a > b ? a - b : b - a;
        uint256 steps = Math.mulDiv(d, 400, b);
        return steps > 15 ? 15 : uint8(steps);
    }
}
