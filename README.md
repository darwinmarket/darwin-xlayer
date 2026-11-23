# Darwin on X Layer

> Index baskets of tokenized US stocks and crypto, bought and sold in one transaction on Uniswap,
> with every rule that moves money decided by a TapeOut circuit.

Darwin turns a strategy into one token. Buy **US Tech** (NVIDIA, Nasdaq 100, Apple, Alphabet,
Tesla) or **Frontier** (SpaceX, Tesla, NVIDIA) with USDG, USDC or USD₮0 in one signature, hold one
ERC-20, sell it back in one signature. Darwin is already live on Miden mainnet with more than 150
user wallets; this repository is its port to X Layer for the **X Layer TapeOut Accelerate**
hackathon.

- [The baskets](#the-baskets)
- [How a trade works](#how-a-trade-works)
- [Stocks on weekends](#stocks-on-weekends)
- [TapeOut, load-bearing](#tapeout-load-bearing)
- [Design your own strategy](#design-your-own-strategy)
- [Measured on X Layer](#measured-on-x-layer)
- [Tests](#tests)
- [Repository](#repository)
- [Run it](#run-it)

## The baskets

| Basket | Holds | Market |
|---|---|---|
| **US Tech** `TECHdw` | 30% NVIDIA, 25% Nasdaq 100, 15% Apple, 15% Alphabet, 15% Tesla | xStocks, 24/5 |
| **US Core** `COREdw` | 60% S&P 500, 40% Nasdaq 100 | xStocks, 24/5 |
| **Frontier** `FRONTdw` | 40% SpaceX, 30% Tesla, 30% NVIDIA | xStocks, 24/5 |
| **Crypto Equities** `CRYPTOEQdw` | 35% Circle, 35% MicroStrategy, 30% Bitcoin | xStocks + crypto |
| **All Weather** `ALLdw` | 40% S&P 500, 25% Bitcoin, 15% Ether, 20% USDG | mixed |
| **Blue Chip** `BLUEdw` | 50% Bitcoin, 30% Ether, 20% Solana | crypto, 24/7 |
| **Balanced** `BALdw` | 35% Bitcoin, 35% Ether, 30% USDG | crypto, 24/7 |
| **OKX Ecosystem** `OKXdw` | 50% OKB, 25% Bitcoin, 25% Ether | crypto, 24/7 |

Every basket holds the real tokens (wrapped xStocks, xBTC, xETH, xSOL, WOKB, USDG), valued with
Chainlink. Anyone can launch more from the [studio](#design-your-own-strategy).

## How a trade works

**Buy, one transaction, no custodian, no reserve:**

1. The router takes your stablecoin (USD₮0 and USDC are converted to USDG on 0.01% pools).
2. 0.30% fee: two thirds to Darwin, one third to the strategy's creator.
3. The money is split over the basket's coins, the coins furthest under their target first (that
   is how baskets rebalance: with new money, not with a keeper trading the vault).
4. Each coin is bought along its Uniswap v3 route: directly against USDG, or through USDC (Nasdaq,
   Tesla, Apple), xBTC (Circle, MicroStrategy) or the S&P 500 token (Alphabet). The coins land in
   the basket.
5. **The trade-policy circuit judges every leg** with its real execution price, the price's age,
   the sequencer, the market session, where the price comes from (Chainlink or the stock's own pool)
   and the basket's weights after the trade. One refusal reverts everything.
6. Shares are minted at the lower of what the coins are worth and what you paid: existing holders
   can never lose to a buyer.

**Sell:** your shares are redeemed in kind, every coin is sold along its route, judged the same
way, and you receive USDG, USDC or USD₮0.

**Redeem in kind:** always open. No oracle, no circuit, no router: you burn shares and receive your
share of every coin and stock.

## Stocks on weekends

Chainlink's xStocks feeds follow the US equities session: they stop around Saturday 01:00 UTC and
resume from Monday 01:00 UTC (some only an hour later). The xStocks pools on X Layer do not stop:
they keep trading all weekend against 24/7 venues. We measured it on chain over the weekend of
2026-11-21 — every pool kept moving, and on Sunday night the pools were closer to Monday's first
Chainlink price than Friday's last one was, for every stock:

| Stock | Friday's last Chainlink price vs Monday | Sunday 23:00 pool price vs Monday |
|---|---|---|
| NVIDIA | −1.84% | +1.42% |
| S&P 500 | −1.12% | −0.64% |
| Nasdaq 100 | −1.41% | −0.31% |
| Tesla | −1.94% | +0.23% |
| SpaceX | −0.65% | +0.36% |
| Apple | −1.30% | −0.17% |

So when a stock's Chainlink price is frozen (weekend, holiday, the first hour of Monday), Darwin
prices it at **its own pool's current price**, the price a trade gets right now, and stock baskets
keep trading. Only if:

- the spot price is within 1% of the pool's one-hour TWAP;
- that TWAP is within 10% of the last Chainlink price;
- the pool's price moved within the last 6 hours (a quiet pool is as frozen as the feed);
- the pool has an hour of history;
- its pair is priced too (Alphabet trades against the S&P 500 token).

The 1% band is what makes the spot safe. One flash loan can move a pool's spot, never its hour's
average: pushed further than 1%, the stock loses its price instead of moving it. Pushed just inside
the band, the attack does not pay: on the Sunday fork, pushing NVIDIA 1.16% down, buying Frontier
and pushing it back loses 43 USD on a 1,000 USD buy, 84 on 10,000, 185 on 25,000, and at 50,000 the
circuit refuses the trade (`test_pushingInsideTheBandDoesNotPay`).

The trade-policy circuit is told the price is the pool's (its `pool` input) and holds those legs to
1.5% on a buy and 2% on a sell instead of 2% and 3%. If a stock fails any condition it has no live
price: it gets no new money, and while a basket holds it nobody can buy into the basket (its value
would be stale and a buyer could take the reopening gap from the holders). Redeeming in kind stays
open. Crypto trades around the clock on Chainlink.

## TapeOut, load-bearing

Darwin taped out its circuits on its own TapeOut processor on X Layer. They are called with
`eval`/`step` inside every trade, and their answers decide whether money moves. Details and truth
tables: [docs/CIRCUITS.md](docs/CIRCUITS.md).

| Circuit | Decides | Size |
|---|---|---|
| Trade policy | whether each leg of a trade goes through, and how severe a refusal is, with tighter limits for a stock priced by its own pool | 15 inputs, 147 gates |
| Market-risk breaker | whether a basket accepts buys (stateful: trips at once, reopens only after 8 healthy beats over at least 1 h 45 min) | 4 LATCH, 57 gates |
| Methodology (one per basket) | each coin's target weight and the band, given whether the coin is eligible | 61 to 146 gates |

What makes it more than a checkbox:

- **The circuits compute, they do not rubber-stamp.** Quantised prices, ages, drifts and sessions
  go in; verdicts with a severity, target weights and a breaker state come out.
- **Stocks have sessions.** On a weekend a stock is priced by its pool and the circuit knows it
  (stricter limits); a stock without a trustworthy pool price is *closed*, not *broken*: the breaker
  does not trip, and it simply gets no new money until it has a price again.
- **Pinned and fail-closed.** Netlist hashes are checked at deployment; the processor's
  implementation is checked before every call. If TapeOut upgrades, Darwin stops instead of trusting
  new code.
- **Replayable.** Every leg's inputs and verdict are emitted on chain; the app's proof page
  re-evaluates them in the browser and on chain.
- **Strategies are circuits anyone can write.** See below.

## Design your own strategy

The studio (`DarwinStudio`) lets anyone launch a basket:

1. In the app, pick up to 8 stocks, coins and stablecoins and set their weights.
2. The methodology circuit is built in your browser (same code as Darwin's own:
   [circuits/src](circuits/src)). You see its gates, netlist and truth table.
3. One transaction tapes it out, and the studio checks **on chain, by evaluating the new circuit**,
   that the weights sum to 100% for exactly your coins. It deploys your basket and sends you the
   circuit's NFT.
4. You earn a third of every fee your basket takes. You can change its methodology, but only 3 days
   after proposing it, in public.

## Measured on X Layer

On a fork of X Layer mainnet (real Uniswap pools, real Chainlink feeds, real TapeOut factory), the
value a buyer receives per 100 paid, fee included:

| Basket | 25 USD | 500 USD | 5,000 USD |
|---|---|---|---|
| US Tech | 99.68 | 99.67 | 99.62 |
| US Core | 99.57 | 99.57 | 99.56 |
| Frontier | 99.65 | 99.65 | 99.57 |
| Crypto Equities | 99.72 | 99.69 | 99.02 |
| All Weather | 99.53 | 99.53 | 99.51 |

A full round trip (buy then sell Frontier, 1,000 USD) keeps 99.29 USD of every 100, after two fees.

## Tests

```
circuits   13 tests   every truth table in full, checked against the TAP-02 Python reference
           + an on-chain sweep: all 32,768 policy inputs evaluated by the TapeOut processor, 0 mismatches
contracts  69 tests   on forks of X Layer mainnet (a Friday and a Sunday), plus 3 invariants (540 random trades)
app         8 tests   Playwright on a local fork: buy, sell, redeem, proofs, studio, weekend trading
```

- Buys and sells of every basket from 10 to 10,000 USD, with USDG, USDC and USD₮0.
- Manipulated pools refused, sequencer outage, stale feeds, breaker trip and recovery.
- A Sunday block: stocks priced at their pools' spot, the price following the last trade, a stock
  basket bought and sold, prices that moved since Friday, a push inside the 1% band that loses money; pushed pools, pools held more than 10% off for an hour and quiet pools lose their
  price; Monday's first hour; no breaker trip.
- The studio: launches, refusals of bad circuits, creator fees.
- Processor upgrade and wrong circuits fail closed.

## Repository

```
circuits/     TAP-02 builder and simulator, Darwin's circuits, build outputs, truth-table tests
contracts/    Foundry: DarwinOracle, DarwinGuard, DarwinBasket, DarwinRouter, DarwinStudio
              script/XLayer.sol (every market, feed, pool and route), script/Deploy.s.sol
app/          the web app (Next.js): baskets, trading, proof pages, studio, circuits
docs/         CIRCUITS.md, THREAT_MODEL.md
PLAN.md       the hackathon plan and the competitive analysis
```

## Run it

```bash
# circuits (Node 22, no dependencies)
cd circuits && node src/build.ts && node --test test/*.test.ts

# contracts (Foundry), tests run on a fork of X Layer mainnet
cd contracts && forge test
```

## Credits

TapeOut protocol and the TAP-02 netlist specification (the test vectors and Python reference in
`circuits/vectors` are CC0), Uniswap v3, Chainlink data feeds, OpenZeppelin Contracts, xStocks.
MIT licence.
