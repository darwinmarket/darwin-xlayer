// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DarwinOracle} from "./DarwinOracle.sol";
import {IBeacon, ITapeoutProcessor} from "./interfaces/External.sol";

interface IBasketCoins {
    function coinList() external view returns (address[] memory);
}

/// @title DarwinGuard
/// @notice Darwin's link to TapeOut. Every decision below is taken by a circuit on X Layer, called
/// in the same transaction: the trade policy (one call per coin of a trade) and the market-risk
/// breaker (a stateful circuit, one state per basket). Basket methodologies are circuits too; the
/// guard calls them for the baskets.
///
/// The guard pins what it calls: the processor's beacon implementation (TapeOut processors are
/// upgradeable) and the keccak256 of each circuit's netlist, checked when the guard is deployed.
/// If the processor is ever upgraded, every call fails closed until a new guard is deployed.
contract DarwinGuard {
    ITapeoutProcessor public immutable processor;
    IBeacon public immutable beacon;
    address public immutable pinnedImplementation;
    DarwinOracle public immutable oracle;
    uint256 public immutable policyCircuit;
    uint256 public immutable breakerCircuit;

    /// Circuit shapes (circuits/src/darwin.ts).
    uint32 internal constant POLICY_IN = 14;
    uint32 internal constant POLICY_OUT = 3;
    uint32 internal constant BREAKER_IN = 5;
    uint32 internal constant BREAKER_OUT = 4;
    uint32 internal constant BREAKER_STATE = 4;
    uint32 internal constant METHOD_IN = 4;
    uint32 internal constant METHOD_OUT = 11;

    /// A healthy beat counts at most once per interval (an unhealthy one trips at any time).
    uint256 public constant BEAT_INTERVAL = 15 minutes;
    /// Gas given to one circuit call, and the most it may return.
    uint256 internal constant CALL_GAS = 3_000_000;
    uint256 internal constant MAX_RETURN = 256;
    /// A coin whose pool is further than this from its oracle (in 0.25% steps) gets no new money.
    uint8 public constant MAX_SPOT_DEV = 12; // 3%

    struct Breaker {
        uint8 state; // bit 0 tripped, bits 1..3 counter (LATCH order of the circuit)
        uint64 lastBeat;
    }

    mapping(address basket => Breaker) public breakers;

    event Beat(address indexed basket, uint8 facts, uint8 state, bool tripped);

    error ProcessorUpgraded(address implementation);
    error CircuitMismatch(uint256 id);
    error CircuitCallFailed(uint256 id);
    error TooSoon();

    constructor(
        ITapeoutProcessor processor_,
        IBeacon beacon_,
        DarwinOracle oracle_,
        uint256 policyId,
        bytes32 policyHash,
        uint256 breakerId,
        bytes32 breakerHash
    ) {
        processor = processor_;
        beacon = beacon_;
        pinnedImplementation = beacon_.implementation();
        oracle = oracle_;
        policyCircuit = policyId;
        breakerCircuit = breakerId;
        checkCircuit(processor_, policyId, policyHash, POLICY_IN, POLICY_OUT, 0);
        checkCircuit(processor_, breakerId, breakerHash, BREAKER_IN, BREAKER_OUT, BREAKER_STATE);
    }

    /// Reverts unless circuit `id` has exactly this netlist and shape.
    function checkCircuit(ITapeoutProcessor p, uint256 id, bytes32 hash, uint32 nIn, uint32 nOut, uint32 nState)
        public
        view
    {
        (uint32 i, uint32 o, uint32 s,) = p.circuitInfo(id);
        if (i != nIn || o != nOut || s != nState || keccak256(p.netlist(id)) != hash) revert CircuitMismatch(id);
    }

    // ---- calling circuits ------------------------------------------------------------------------

    function _pinned() internal view {
        address impl = beacon.implementation();
        if (impl != pinnedImplementation) revert ProcessorUpgraded(impl);
    }

    function _call(uint256 id, bytes memory data) internal view returns (bytes memory out) {
        _pinned();
        (bool ok, bytes memory ret) = address(processor).staticcall{gas: CALL_GAS}(data);
        if (!ok || ret.length > MAX_RETURN) revert CircuitCallFailed(id);
        out = ret;
    }

    function _eval(uint256 id, bytes memory inputs) internal view returns (uint256 bits) {
        bytes memory ret = _call(id, abi.encodeCall(ITapeoutProcessor.eval, (id, inputs)));
        bits = _bits(abi.decode(ret, (bytes)));
    }

    function _step(uint256 id, uint8 state, uint8 inputs) internal view returns (uint8 next, uint8 out) {
        bytes memory ret = _call(
            id, abi.encodeCall(ITapeoutProcessor.step, (id, abi.encodePacked(state), abi.encodePacked(inputs)))
        );
        (bytes memory s, bytes memory o) = abi.decode(ret, (bytes, bytes));
        if (s.length != 1 || o.length != 1) revert CircuitCallFailed(id);
        next = uint8(s[0]);
        out = uint8(o[0]);
    }

    /// LSB-first packed bytes as an integer (bit i of the vector is bit i of the result).
    function _bits(bytes memory b) internal pure returns (uint256 v) {
        if (b.length > 32) revert CircuitCallFailed(0);
        for (uint256 i; i < b.length; i++) {
            v |= uint256(uint8(b[i])) << (8 * i);
        }
    }

    function _packed(uint256 v, uint256 nBits) internal pure returns (bytes memory b) {
        b = new bytes((nBits + 7) / 8);
        for (uint256 i; i < b.length; i++) {
            b[i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    // ---- 1. trade policy -------------------------------------------------------------------------

    struct Leg {
        uint8 dev; // |execution price - oracle| in 0.25% steps, saturating at 15
        uint8 age; // oracle age class 0..3
        bool seqUp;
        bool isBuy;
        uint8 drift; // |weight after - target| in pp, saturating at 15
        bool better; // the trade does not move the coin further from its target
        bool open; // the coin's market is in session
    }

    function policyInputs(Leg memory l) public pure returns (uint256 v) {
        v = uint256(l.dev > 15 ? 15 : l.dev) | (uint256(l.age > 3 ? 3 : l.age) << 4)
            | (uint256(l.seqUp ? 1 : 0) << 6) | (uint256(l.isBuy ? 1 : 0) << 7)
            | (uint256(l.drift > 15 ? 15 : l.drift) << 8) | (uint256(l.better ? 1 : 0) << 12)
            | (uint256(l.open ? 1 : 0) << 13);
    }

    /// The circuit's verdict on one leg: allowed, and a severity (0 clean, 1 warned, 2 refused,
    /// 3 refused because the market itself is broken). A stock outside its session is refused (2).
    function policy(Leg memory l) public view returns (bool allow, uint8 severity) {
        uint256 out = _eval(policyCircuit, _packed(policyInputs(l), POLICY_IN));
        allow = out & 1 == 1;
        severity = uint8((out >> 1) & 3);
    }

    // ---- 2. market-risk breaker ------------------------------------------------------------------

    /// The five facts of the breaker for a basket, as its input bits. They describe the market as a
    /// whole; one coin's trouble only makes that coin ineligible (see `eligible`).
    ///   0 feeds alive: the quote's feed under an hour old, every coin in session within heartbeat + grace
    ///   1 the X Layer sequencer is up
    ///   2 the quote stablecoin is on its peg
    ///   3 no pool more than 10% away from its oracle (30-minute TWAP)
    ///   4 every wrapped coin is backed
    function facts(address basket) public view returns (uint8 bits) {
        address[] memory coins = IBasketCoins(basket).coinList();
        bool alive = oracle.ageClass(oracle.quote()) <= 1;
        bool pricesOk = true;
        bool reservesOk = true;
        for (uint256 i; i < coins.length; i++) {
            if (!oracle.reserveOk(coins[i])) reservesOk = false;
            // a closed stock market is not an incident: its feed and pool rest until it opens
            if (!oracle.sessionOpen(coins[i])) continue;
            if (oracle.ageClass(coins[i]) > 2) alive = false;
            // a coin without a TWAP history is never judged on its spot: one flash loan must not trip a basket
            (bool ok, uint256 bps) = twapDeviationBps(coins[i]);
            if (ok && bps > MAX_BREAKER_DEV_BPS) pricesOk = false;
        }
        bits = (alive ? 1 : 0) | (oracle.sequencerUp() ? 2 : 0) | (oracle.quotePegOk() ? 4 : 0)
            | (pricesOk ? 8 : 0) | (reservesOk ? 16 : 0);
    }

    uint256 public constant MAX_BREAKER_DEV_BPS = 1000; // 10%

    /// |30-minute TWAP - oracle| / oracle in basis points (0 for the quote token).
    /// `ok` is false when the pool has no usable history yet (a quiet pool, or a new one).
    function twapDeviationBps(address coin) public view returns (bool ok, uint256 bps) {
        if (coin == oracle.quote()) return (true, 0);
        (uint256 p,) = oracle.price(coin);
        try oracle.twapPrice(coin) returns (uint256 tw) {
            return (true, (tw > p ? tw - p : p - tw) * 10_000 / p);
        } catch {
            return (false, 0);
        }
    }

    /// |spot - oracle| / oracle in basis points.
    function spotDeviationBps(address coin) public view returns (uint256) {
        if (coin == oracle.quote()) return 0;
        (uint256 p,) = oracle.price(coin);
        uint256 sp = oracle.spotPrice(coin);
        return (sp > p ? sp - p : p - sp) * 10_000 / p;
    }

    /// The coin's pool (30-minute TWAP) is within MAX_SPOT_DEV of its oracle. A TWAP, so one flash
    /// loan cannot make a coin ineligible.
    /// Without a TWAP history the spot price stands in: the worst a flash loan can do with it is
    /// move new money between coins, and every trade is judged on its real execution price anyway.
    function coinPriceOk(address coin) public view returns (bool) {
        (bool ok, uint256 bps) = twapDeviationBps(coin);
        if (!ok) bps = spotDeviationBps(coin);
        return bps <= uint256(MAX_SPOT_DEV) * 25;
    }

    /// What one beat would do now, without storing it.
    function preview(address basket) public view returns (uint8 next, bool tripped, uint8 bits) {
        bits = facts(basket);
        uint8 out;
        (next, out) = _step(breakerCircuit, breakers[basket].state, bits);
        tripped = out & 1 == 1;
    }

    /// Buying is open: the stored breaker is not tripped and this beat would not trip it.
    function buyOpen(address basket) external view returns (bool) {
        if (breakers[basket].state & 1 == 1) return false;
        (, bool tripped,) = preview(basket);
        return !tripped;
    }

    /// Anyone may beat a basket's breaker. A healthy beat counts once per BEAT_INTERVAL, so it
    /// takes eight healthy beats over at least 1 h 45 min to reopen a tripped basket; an unhealthy
    /// beat trips it at once.
    function poke(address basket) external returns (bool tripped) {
        (uint8 next, bool t, uint8 bits) = preview(basket);
        Breaker storage b = breakers[basket];
        bool healthy = bits == 31;
        if (healthy && block.timestamp < b.lastBeat + BEAT_INTERVAL) revert TooSoon();
        b.state = next;
        b.lastBeat = uint64(block.timestamp);
        emit Beat(basket, bits, next, t);
        return t;
    }

    // ---- 3. methodologies ------------------------------------------------------------------------

    /// A coin is eligible for new money when its market is in session, its feed is fresh and its
    /// pool sits on its oracle.
    function eligible(address coin) public view returns (bool) {
        return oracle.sessionOpen(coin) && oracle.ageClass(coin) <= 1 && coinPriceOk(coin);
    }

    /// Target weight (percent) and band (pp) of coin `index` under methodology circuit `id`.
    function methodology(uint256 id, uint8 index, bool isEligible) external view returns (uint8 weight, uint8 band) {
        uint256 out = _eval(id, _packed(uint256(index & 7) | (isEligible ? 8 : 0), METHOD_IN));
        weight = uint8(out & 0x7f);
        band = uint8((out >> 7) & 0xf);
    }

    function checkMethodology(uint256 id, bytes32 hash) external view {
        checkCircuit(processor, id, hash, METHOD_IN, METHOD_OUT, 0);
    }

    /// The largest methodology accepted: keeps every buy far below the circuit call's gas budget.
    uint32 public constant MAX_METHOD_GATES = 400;

    error BadWeights(uint256 index, uint8 weight, bool eligible);
    error BadBand(uint8 band);
    error TooManyGates(uint32 gates);

    /// Reverts unless circuit `id` is a methodology for `n` coins: evaluated on chain for all 16
    /// inputs, each listed coin gets a weight in 1..100 when eligible and 0 when not, the weights
    /// sum to 100, one band in 1..15, and nothing for an index beyond the coins. At most 400 gates.
    function checkWeights(uint256 id, uint256 n) external view {
        (,,, uint32 gates) = processor.circuitInfo(id);
        if (gates > MAX_METHOD_GATES) revert TooManyGates(gates);
        uint256 sum;
        uint8 band;
        for (uint8 i; i < 8; i++) {
            (uint8 w, uint8 b) = this.methodology(id, i, true);
            (uint8 wOff,) = this.methodology(id, i, false);
            if (wOff != 0) revert BadWeights(i, wOff, false);
            if (i < n) {
                if (w == 0 || w > 100) revert BadWeights(i, w, true);
                if (i == 0) band = b;
                else if (b != band) revert BadBand(b);
                sum += w;
            } else if (w != 0) {
                revert BadWeights(i, w, true);
            }
        }
        if (sum != 100) revert BadWeights(type(uint256).max, uint8(sum > 255 ? 255 : sum), true);
        if (band == 0 || band > 15) revert BadBand(band);
    }
}
