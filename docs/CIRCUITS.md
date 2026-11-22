# Darwin's TapeOut circuits

Every rule that decides whether money moves in Darwin is a circuit on X Layer, taped out on
Darwin's own TapeOut processor and called in the same transaction as the trade. None of them
repeats a check Solidity already made: Solidity measures the market, the circuit decides.

Source: [`circuits/src/darwin.ts`](../circuits/src/darwin.ts). Built netlists:
[`circuits/build/`](../circuits/build). Every circuit's full truth table is tested against a
reference model, and our simulator is checked against the official TAP-02 Python reference.

## How a contract calls a circuit

```solidity
bytes memory out = processor.eval(circuitId, packedInputs);              // combinational
(bytes memory next, bytes memory out) = processor.step(id, state, inputs); // with LATCH state
```

Both are `view` calls, synchronous, inside the trade's own transaction. Inputs and outputs are bit
vectors packed least significant bit first. `DarwinGuard` makes every call with a bounded gas
budget, refuses oversized answers, and checks before each call that TapeOut's processor
implementation is still the one it was deployed against (processors are upgradeable beacon proxies).
When it deploys, it checks each circuit's netlist hash and shape.

## 1. Trade policy (105 gates)

Called once per coin of every buy and sell.

| Bit | Input | Measured on chain by |
|---|---|---|
| 0-3 | `dev`: execution price vs Chainlink, in 0.25% steps (saturates at 15) | `DarwinRouter._execDev` from the real swap's amounts |
| 4-5 | `age`: 0 < 1 h, 1 < heartbeat, 2 < heartbeat + 1 h, 3 older | `DarwinOracle.ageClass` |
| 6 | `seqUp`: X Layer sequencer up for more than an hour | Chainlink L2 sequencer uptime feed |
| 7 | `isBuy` | the router |
| 8-11 | `drift`: weight after the trade vs target, in pp | `DarwinRouter._judgeBuy` |
| 12 | `better`: the trade does not move the coin away from its target | `DarwinRouter._judgeBuy` |
| 13 | `open`: the coin's market is in session (US stocks: 24/5) | `DarwinOracle.sessionOpen` |

Outputs: `allow`, and a 2-bit severity: 0 clean, 1 allowed with a warning, 2 refused, 3 refused
because the market itself is broken.

Rules:

- Buys: within 2% of Chainlink, oracle within its heartbeat, sequencer up, market open, and the
  coin may not end more than 5 pp off its target unless the buy brings it closer.
- Sells: within 3%, oracle within heartbeat + grace (a seller must be able to leave when a feed is
  late), sequencer up, market open. Drift never holds a sale back.
- A stock outside its session is refused as **closed** (2), not broken (3): its feed is expected to
  be old on a weekend.

## 2. Market-risk breaker (57 gates, 4 LATCH)

Stateful: one state per basket, stored by `DarwinGuard`, advanced with `step()`.

| Bit | Input |
|---|---|
| 0 | feeds alive: the quote's feed under an hour old, every coin in session within heartbeat + grace |
| 1 | sequencer up |
| 2 | USDG on its peg (within 1%) |
| 3 | no pool more than 10% from its oracle (time-weighted average, never the spot price) |
| 4 | every wrapped coin backed (xBTC/BTC exchange rate at least 0.995) |

State: `tripped` and a 3-bit counter. One unhealthy beat trips the basket and clears the counter.
While tripped, each healthy beat counts; the eighth healthy beat in a row reopens it. A healthy beat
counts at most once every 15 minutes, so reopening takes at least 1 h 45 min of a healthy market.
Nobody can reset it by hand. Anyone can beat a basket with `DarwinGuard.poke`.

Tripped means **sell only**: buying is closed, selling and redeeming in kind stay open.

## 3. Methodologies (one per basket)

Input: a coin index (3 bits) and whether the coin is eligible (1 bit: market in session, feed
fresh, pool near its oracle). Output: the coin's target weight in percent (7 bits) and the basket's
band (4 bits). An ineligible coin gets 0%, so new money goes to the others until it recovers. On a
Sunday, a basket holding both stocks and crypto buys only its crypto.

The basket reads its targets from its circuit on every trade. A new methodology can only be applied
3 days after the owner proposes it, and its netlist hash is pinned when proposed.

### Anyone can design one

`DarwinStudio.createStrategy` takes a methodology netlist built in the browser, tapes it out, and
checks on chain, by evaluating the new circuit, that it really is a methodology for the chosen
coins: listed coins get weights summing to 100% under one band, and indexes beyond them get nothing.
It then deploys the basket and hands the circuit's NFT to its creator, who earns a third of the
basket's fees.

## Gas

About 22.6k gas plus about 2,400 gas per gate for each call. A three-coin buy makes 3 policy calls,
3 methodology calls and one breaker preview: about 1.5M gas, a fraction of a cent at X Layer's gas
price.
