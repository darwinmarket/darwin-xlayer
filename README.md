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
5. **The trade-policy circuit judges every leg** with its real execution price, the oracle's age,
   the sequencer, the market session and the basket's weights after the trade. One refusal reverts
   everything.
6. Shares are minted at the lower of what the coins are worth and what you paid: existing holders
   can never lose to a buyer.

**Sell:** your shares are redeemed in kind, every coin is sold along its route, judged the same
way, and you receive USDG, USDC or USD₮0.

**Stocks keep market hours:** while a basket holds a stock outside the US session (weekends), nobody
can buy into it, because its value would use Friday's price and a buyer could take Monday's gap
from the holders. Crypto baskets trade around the clock.

**Redeem in kind:** always open. No oracle, no circuit, no router: you burn shares and receive your
share of every coin and stock.

## TapeOut, load-bearing

Darwin taped out its circuits on its own TapeOut processor on X Layer. They are called with
`eval`/`step` inside every trade, and their answers decide whether money moves. Details and truth
tables: [docs/CIRCUITS.md](docs/CIRCUITS.md).

| Circuit | Decides | Size |
|---|---|---|
| Trade policy | whether each leg of a trade goes through, and how severe a refusal is | 14 inputs, 105 gates |
| Market-risk breaker | whether a basket accepts buys (stateful: trips at once, reopens only after 8 healthy beats over at least 1 h 45 min) | 4 LATCH, 57 gates |
| Methodology (one per basket) | each coin's target weight and the band, given whether the coin is eligible | 61 to 146 gates |

What makes it more than a checkbox:

- **The circuits compute, they do not rubber-stamp.** Quantised prices, ages, drifts and sessions
  go in; verdicts with a severity, target weights and a breaker state come out.
- **Stocks have sessions.** On a weekend a stock leg is *closed*, not *broken*: the breaker does not
  trip, and a basket holding stocks and crypto buys only its crypto until Monday, then rebalances
  with the next buys.
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
contracts  59 tests   on a fork of X Layer mainnet, plus 3 invariants (540 random trades)
```

- Buys and sells of every basket from 10 to 10,000 USD, with USDG, USDC and USD₮0.
- Manipulated pools refused, sequencer outage, stale feeds, breaker trip and recovery.
- A Sunday block: stocks closed, no breaker trip, mixed baskets buy their open markets.
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
