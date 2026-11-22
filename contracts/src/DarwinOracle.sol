// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAggregator, IUniswapV3Pool} from "./interfaces/External.sol";

/// @title DarwinOracle
/// @notice Every market Darwin can put in a basket, crypto and tokenized stocks (xStocks), with
/// the facts Darwin's circuits read: Chainlink prices and their age, trading sessions, the L2
/// sequencer, pegs, reserves, and Uniswap v3 spot and 30-minute TWAP prices.
/// Configured once at deployment, no admin: a new market list means a new oracle.
contract DarwinOracle {
    /// Always open (crypto, stablecoins).
    uint8 public constant SESSION_ALWAYS = 0;
    /// US equities 24/5 (Chainlink's "us_equities_24/5" feeds): closed from Saturday 00:00 UTC to
    /// Monday 01:00 UTC (Friday 20:00 to Sunday 20:00 New York time, with an hour to spare in winter).
    uint8 public constant SESSION_US_EQUITIES = 1;

    struct Market {
        address token;
        uint8 decimals;
        uint8 session;
        IAggregator feed; // token/USD (the underlying's feed for wrapped assets)
        uint32 heartbeat; // seconds after which an answer is late
        IUniswapV3Pool pool; // token/pair pool whose TWAP is checked (zero for the quote token)
        address pair; // the other token of that pool: the quote or another market
        bytes path; // Uniswap v3 path from the quote to the token (empty for the quote token)
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
    uint32 public constant TWAP_WINDOW = 30 minutes;

    mapping(address => Market) internal markets;
    address[] public tokens;

    error UnknownToken(address token);
    error BadPrice(address token);
    error BadConfig(address token);

    constructor(address quote_, IAggregator sequencerFeed_, Market[] memory list) {
        quote = quote_;
        sequencerFeed = sequencerFeed_;
        bool quoteListed;
        for (uint256 i; i < list.length; i++) {
            Market memory m = list[i];
            if (m.token == address(0) || address(m.feed) == address(0) || m.heartbeat == 0 || m.session > 1) {
                revert BadConfig(m.token);
            }
            if (markets[m.token].token != address(0)) revert BadConfig(m.token);
            if (m.token == quote_) {
                quoteListed = true;
                if (address(m.pool) != address(0) || m.path.length != 0) revert BadConfig(m.token);
            } else {
                // the pair must already be listed (the quote first, then the markets it prices)
                if (m.pair != quote_ && markets[m.pair].token == address(0)) revert BadConfig(m.token);
                bool ok = (m.pool.token0() == m.token && m.pool.token1() == m.pair)
                    || (m.pool.token1() == m.token && m.pool.token0() == m.pair);
                if (!ok) revert BadConfig(m.token);
                if (!_pathOk(m.path, quote_, m.token)) revert BadConfig(m.token);
            }
            markets[m.token] = m;
            tokens.push(m.token);
        }
        if (!quoteListed) revert BadConfig(quote_);
        quoteDecimals = markets[quote_].decimals;
    }

    /// A path is token (20 bytes), then (fee (3) token (20)) per hop, from `from` to `to`.
    function _pathOk(bytes memory path, address from, address to) internal pure returns (bool) {
        if (path.length < 43 || (path.length - 20) % 23 != 0) return false;
        return _addrAt(path, 0) == from && _addrAt(path, path.length - 20) == to;
    }

    function _addrAt(bytes memory b, uint256 i) internal pure returns (address a) {
        assembly {
            a := shr(96, mload(add(add(b, 32), i)))
        }
    }

    function market(address token) public view returns (Market memory m) {
        m = markets[token];
        if (m.token == address(0)) revert UnknownToken(token);
    }

    function listed(address token) external view returns (bool) {
        return markets[token].token != address(0);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function allTokens() external view returns (address[] memory) {
        return tokens;
    }

    /// Path to buy `token` with the quote, and the reverse path to sell it.
    function buyPath(address token) external view returns (bytes memory) {
        return market(token).path;
    }

    function sellPath(address token) external view returns (bytes memory r) {
        bytes memory p = market(token).path;
        r = new bytes(p.length);
        uint256 hops = (p.length - 20) / 23;
        // tokens reversed, each fee stays between the same two tokens
        for (uint256 h; h <= hops; h++) {
            _copy(p, h * 23, r, (hops - h) * 23, 20);
            if (h < hops) _copy(p, h * 23 + 20, r, (hops - h - 1) * 23 + 20, 3);
        }
    }

    function _copy(bytes memory src, uint256 from, bytes memory dst, uint256 to, uint256 n) internal pure {
        for (uint256 k; k < n; k++) {
            dst[to + k] = src[from + k];
        }
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

    /// Whether the token's market is in session now.
    function sessionOpen(address token) public view returns (bool) {
        return isOpen(market(token).session, block.timestamp);
    }

    function isOpen(uint8 session, uint256 t) public pure returns (bool) {
        if (session == SESSION_ALWAYS) return true;
        // 1970-01-01 was a Thursday: day 0 = Thursday, so (days + 4) % 7 = 0 is Sunday
        uint256 weekday = (t / 1 days + 4) % 7;
        uint256 hour = (t % 1 days) / 1 hours;
        if (weekday == 6) return false; // Saturday
        if (weekday == 0) return false; // Sunday
        if (weekday == 1 && hour < 1) return false; // Monday before 01:00 UTC
        return true;
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

    // ---- Uniswap ---------------------------------------------------------------------------------

    /// USD price of one whole token from its pool's current spot price and its pair's Chainlink
    /// price (18 decimals). Easy to move within a block: Darwin only shows it, never decides on it.
    function spotPrice(address token) public view returns (uint256) {
        Market memory m = market(token);
        if (token == quote) return _usd(quote);
        (uint160 sqrtP,,,,,,) = m.pool.slot0();
        // (sqrtP^2 / 2^192) * 2^128: token1 base units per token0 base unit, Q128
        return _toUsd(m, Math.mulDiv(sqrtP, sqrtP, 1 << 64));
    }

    /// USD price of one whole token from its pool's time-weighted average (18 decimals): over 30
    /// minutes, or over the longest of 10, 5 or 1 minute that the pool's observation history covers
    /// (a busy pool with a short history). Moving it means holding the pool off price for that long,
    /// across many blocks, not one flash loan. Returns the window used.
    function twapPrice(address token) public view returns (uint256) {
        (uint256 p,) = twap(token);
        return p;
    }

    function twap(address token) public view returns (uint256 usd, uint32 window) {
        Market memory m = market(token);
        if (token == quote) return (_usd(quote), 0);
        uint32[4] memory windows = [TWAP_WINDOW, 10 minutes, 5 minutes, 1 minutes];
        for (uint256 i; i < windows.length; i++) {
            uint32[] memory ago = new uint32[](2);
            ago[0] = windows[i];
            try m.pool.observe(ago) returns (int56[] memory cum, uint160[] memory) {
                int56 delta = cum[1] - cum[0];
                int56 w = int56(uint56(windows[i]));
                int24 tick = int24(delta / w);
                if (delta < 0 && delta % w != 0) tick--; // round towards -infinity
                return (_toUsd(m, priceX128AtTick(tick)), windows[i]);
            } catch {}
        }
        revert BadPrice(token);
    }

    function _usd(address token) internal view returns (uint256 usd) {
        (usd,) = price(token);
    }

    /// USD per whole token from a pool price (token1 base units per token0 base unit, Q128).
    function _toUsd(Market memory m, uint256 priceX128) internal view returns (uint256) {
        if (priceX128 == 0) revert BadPrice(m.token);
        uint8 pairDecimals = m.pair == quote ? quoteDecimals : markets[m.pair].decimals;
        uint256 pairUnits; // pair base units per whole token, with 18 extra decimals
        if (m.pool.token0() == m.token) {
            pairUnits = Math.mulDiv(priceX128, 10 ** m.decimals * 1e18, 1 << 128);
        } else {
            pairUnits = Math.mulDiv(1 << 128, 10 ** m.decimals * 1e18, priceX128);
        }
        return Math.mulDiv(pairUnits, _usd(m.pair), 10 ** pairDecimals * 1e18);
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
