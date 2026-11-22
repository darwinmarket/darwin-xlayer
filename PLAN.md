# Darwin on X Layer: the plan

Darwin is crypto index baskets: one token, a whole strategy. It is live on Miden mainnet with more
than 150 user wallets. This repository is its port to X Layer for the **X Layer TapeOut Accelerate**
hackathon (OKX Build X series, deadline **2026-12-07 23:59 UTC**), with TapeOut circuits deciding
what a basket is allowed to do.

Status: circuits and contracts built, 13 circuit tests and 21 mainnet-fork tests passing. Everything below "Measured" was checked on X Layer mainnet on 2026-11-22.

## 1. The hackathon in one screen

- Prizes: 100,000 USDT. 1st 20,000; 2nd 5 × 10,000; 3rd 5 × 6,000.
- Must use the TapeOut ecosystem on X Layer: circuits, contracts or on-chain data, or DeWEB.
- Circuit projects submit the **processor contract address and circuit IDs**. Apps submit an access
  link and say which TapeOut features they use.
- The description must cover the product, target users and how to reach them, the revenue model,
  and why users pay and stay.
- Existing projects are eligible with **substantial new development** during the event, described.
- Judging: user value and commercial potential; innovation; ecosystem integration (DeWEB, FabX,
  TapeCode, TapeKit, TapeSend); product readiness and UX; demo video (3 minutes max).
- Submission: Google Form. Shortlisted teams attend an offline Demo Day.

## 2. What we learned about TapeOut

- A **circuit** is a netlist of NAND and LATCH gates stored on X Layer, owned as an NFT of a
  **processor** (an ERC-721 "Circuits" contract created by the TapeOut factory).
- A contract uses a circuit with a synchronous view call, inside its own transaction:
  `eval(id, inputs) -> outputs` (combinational) or
  `step(id, state, inputs) -> (newState, outputs)` (with LATCH state, stored by the caller).
  Inputs and outputs are bit vectors, LSB first.
- Creating a processor costs 0.1 **BEM** (TapeOut's token, paid to the factory as an ERC-20);
  transistors are priced in OKB by each processor (ours: free). Checked on a mainnet fork.
- Cost: about 22.6k gas + 2,400 gas per gate. Gas is about 0.02 gwei, so a decision costs a
  fraction of a cent. Taping out a circuit costs about 0.0013 OKB plus 0.0001 OKB per gate.
- Circuits compute bits only: numbers must be quantised (an 8-bit comparator is about 37 NAND).
- Processors are beacon proxies and the factory is not sealed: we **pin** the netlist hash and the
  beacon implementation, and fail closed if either changes.
- **TapeOut exists on mainnet only.** X Layer testnet (1952) has no code at the TapeOut addresses
  (checked). Every serious competitor is on mainnet. So are we: Foundry fork tests first, mainnet
  after.
- Ecosystem pieces we will use: **DeWEB** (static site in a circuit's container, served at
  `https://<id>-2-<processor>.tapekit.org`), **TapeKit** (reads and verifies DeWEB sites),
  **TapeSend** (on-chain messages from a container).

| TapeOut contract (X Layer mainnet) | Address |
|---|---|
| Factory | `0x1f09DAeFA827f02CBb40967cc91b259763760761` |
| Circuit beacon | `0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C` |
| Beacon implementation (to pin) | `0x977f217887E085D298Cb3819cDAD5A0ee35F29B2` |
| Opener (container) | `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` |
| SiteRegistry (DeWEB) | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |
| DomainBinding | `0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9` |
| TapeSend hub | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` |

## 3. The competition

About 105 public repos across this hackathon and the earlier Genesis Transistor one. Fewer than 25
have a mainnet contract whose funds actually depend on a circuit's output.

- Strongest: **Fusebox** (agent wallet, payments pass circuit "fuses", designers earn 90% of fees),
  **Latch** (USDT0 vault that buys OKB, 7 rule bits checked by a circuit before each swap),
  **ViperX** (perp DEX for agents, 4 risk circuits, mock collateral), **TapePool** (lending, a
  credit-policy circuit on every borrow), **Lingxi** (a pet whose brain is a circuit, very polished).
- What almost everyone does: a few NANDs that AND together facts Solidity already computed. The
  circuit adds nothing.
- **What nobody does**: index baskets, portfolio weights or rebalancing; circuits that compute
  quantities instead of one yes/no; stateful LATCH breakers for market risk; circuits that consume
  oracle prices; real users and real volume.

That empty space is Darwin's.

## 4. The product

Same model as Darwin on Miden, which already works: **no team reserve, the DEX is the liquidity**.
On Miden an operator buys the coins and holds the funds during a trade. On an EVM we can remove the
operator entirely.

- **Buy**: the user signs one transaction in OKX Wallet. The router takes their stablecoin, buys
  each coin of the basket on Uniswap, deposits them into the basket vault and mints the shares to
  the user. If any step fails, everything reverts. Nobody holds the user's funds at any point.
- **Sell**: one transaction. The vault burns the shares and releases each coin pro rata, the router
  sells them for the stablecoin and sends it to the user.
- **Backing**: each basket token is fully backed by the coins in its vault, valued with Chainlink.
- **No capital needed** from the team, except a small permanent seed deposit per basket (as on
  Miden) that protects the share price against inflation attacks.
- **Rebalancing** without a keeper trading the vault: every buy is steered towards underweight
  coins and every sell takes more of the overweight ones, inside bands decided by the circuit (the
  "±5 pp band" that was planned on Miden and never shipped).

### Baskets

| Basket | Composition | Why |
|---|---|---|
| Blue Chip | 50% xBTC, 30% xETH, 20% xSOL | Same weights as the live Miden Blue Chip |
| Balanced | 35% xBTC, 35% xETH, 30% USDG | Lower volatility |
| OKX Ecosystem | 50% OKB, 25% xBTC, 25% xETH | X Layer's own token |

Stretch, if time allows: a **tokenized stocks** basket (wNVDAx, wSPYx, wQQQx...). X Layer has
Chainlink feeds and $1M to $3M Uniswap pools for these, and Darwin already built stock baskets on
Monad.

## 5. TapeOut, load-bearing

Every circuit below decides whether funds move. None of them repeats a check Solidity could keep.

### Circuit 1: Trade policy (per coin, quantitative)

Called on every buy and every sell, once per coin, in the same transaction.

- Inputs (quantised on chain from real data):
  - deviation between the Uniswap execution price and Chainlink, in 0.1% steps (4 bits);
  - age of the Chainlink answer against its heartbeat (2 bits);
  - X Layer sequencer up and past its grace period (1 bit, Chainlink uptime feed);
  - price impact of the leg (3 bits);
  - the coin's weight drift from target after the trade, in 1 pp steps, and its direction (5 bits).
- Outputs: `allow` (1 bit) plus a 2-bit severity.
- If any coin is not allowed, the whole trade reverts with the circuit's verdict. This is the
  "refuse if the DEX is more than 2% away from the oracle" rule of Miden, moved into a public
  circuit nobody can change silently.

### Circuit 2: Market-risk breaker (stateful, LATCH)

The breaker watches the market as a whole; one coin's trouble only makes that coin ineligible for
new money (the methodology gives it 0% until it recovers). Pool prices are read as 30-minute TWAPs,
so a flash loan cannot trip a basket.

Called with `step()` on every trade and by anyone through a public `poke()`.

- Trips when an oracle is stale, the sequencer is down, a stablecoin leaves its peg, a coin's
  DEX price leaves the oracle band, or (Blue Chip, Balanced) the xBTC proof-of-reserve check fails.
- Tripped means **sell-only**: holders can always leave, nobody can enter at a broken price.
- It resets only after N consecutive healthy beats (a counter in LATCH state), not by an admin.

### Circuit 3: Index methodology (the rules of each basket)

- Each basket's target weights, bands and per-coin caps are a circuit.
- Changing the methodology means taping out a new circuit and a public timelock before the
  basket switches to it. The basket contract pins the netlist hash.
- Holders can verify the rules themselves: the netlist is on chain, the truth table is in the repo,
  and the proof page replays every decision with `eval`.

### The rest of the ecosystem

- **DeWEB**: each basket's factsheet (rules, composition, NAV, circuit IDs) and the app itself,
  published in the methodology circuit's container, verifiable with TapeKit.
- **TapeSend**: a notice to holders when the breaker trips or resets and when the methodology
  changes.
- **Proof page**: every buy and sell links to the circuit call that allowed it, replayable by anyone.

## 6. Revenue model

- **0.30% per buy and per sell**, as on Miden.
- Later: a small management fee, and **third-party methodology circuits**. Anyone can tape out a
  methodology; a basket that adopts it pays the circuit's owner a share of its fees (the Fusebox
  model, applied to index design).
- Target users: Darwin's existing holders, OKX Wallet users who want BTC/ETH/SOL exposure in one
  click, and X Layer users holding stablecoins.

## 7. Measured on X Layer mainnet (2026-11-22)

Liquidity is real: Uniswap v3 pools against **USDG** (Paxos Global Dollar, 6 decimals) hold millions.

| Pool (Uniswap v3, 0.05%) | TVL |
|---|---|
| xBTC / USDG | $2.15M |
| xETH / USDG | $2.17M |
| xSOL / USDG | $1.89M |
| WOKB / USDG | $1.07M |
| USDG / USD₮0 (0.01%) | $3.13M |
| USDC / USDG (0.01%) | $3.05M |

Cost of buying with USDG on Uniswap (QuoterV2), against Chainlink:

| Buy | $100 | $1,000 | $10,000 | $50,000 |
|---|---|---|---|---|
| xBTC | 0.02% | 0.04% | 0.29% | 1.44% |
| xETH | 0.23% | 0.26% | 0.51% | 1.64% |
| xSOL | -0.03% | 0.02% | 0.52% | 2.75% |
| OKB | -0.08% | 0.00% | 0.78% | 4.37% |

A $10,000 basket buy costs well under 1%. The Miden beta caps a buy at $100.

| Contract | Address |
|---|---|
| USDG | `0x4ae46a509F6b1D9056937BA4500cb143933D2dc8` |
| USD₮0 | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` |
| USDC | `0xB6CEceAB302E2E4948951eE7843FC24E92933061` |
| xBTC | `0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f` |
| xETH | `0xe7b000003a45145decf8a28fc755ad5ec5ea025a` |
| xSOL | `0x505000008DE8748DBd4422ff4687a4FC9bEba15b` |
| WOKB | `0xe538905cf8410324e03A5A23C1c177a474D59b2b` |
| Uniswap v3 factory | `0x4b2ab38dbf28d31d467aa8993f6c2585981d6804` |
| Uniswap SwapRouter02 | `0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca` |
| Uniswap QuoterV2 | `0x976183ac3d09840d243a88c0268badb3b3e3259f` |
| Chainlink BTC/USD | `0x4D6f6488a2B3a5f7b088f276887f608a1e9805c4` |
| Chainlink ETH/USD | `0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b` |
| Chainlink SOL/USD | `0xF959E1B5cA535C28aD24F7f672Bf1A93900810cF` |
| Chainlink OKB/USD | `0x4Ff345b18a2bF894F8627F41501FBf30d5C5e7BE` |
| Chainlink USDT0/USD | `0x673b428Fd1df93a6F77fA7ea1F8eeD8A4Ff36b9f` |
| Chainlink XBTC/BTC | `0x265342dc2EDD57c05c1410115E8fA5E02a7C0886` |
| Chainlink sequencer uptime | `0x45c2b8C204568A03Dc7A2E32B71D67Fe97F908A9` |

Still to check: Chainlink feeds for xETH/ETH, xSOL/SOL and USDG/USD; whether the OKX DEX
aggregator beats Uniswap direct for our sizes.

## 8. Architecture

- `contracts/` (Foundry, Solidity 0.8.28)
  - `DarwinBasket`: ERC-20 share, in-kind mint and redeem, holds the coins, NAV from Chainlink.
  - `DarwinRouter`: buy and sell a whole basket for a stablecoin in one transaction through
    Uniswap v3, with per-leg minimum outputs from the user and from the circuit.
  - `ChainlinkOracle`: staleness, sequencer uptime, decimals.
  - `TapeoutGate`: calls the processor (`eval` / `step`) with a bounded staticcall, pins the netlist
    hash and beacon implementation, fails closed on any surprise.
  - `circuits/`: the netlists, their truth tables and a TypeScript builder and simulator that passes
    the official TAP-02 vectors.
- `app/` (Next.js, from the Darwin front): OKX Wallet (and any injected wallet), buy and sell,
  portfolio, the circuit verdicts on each trade, the proof page.
- `ops/`: deploy, tape out, publish to DeWEB, TapeSend notices.

## 9. Tests

- **Unit tests** for every contract, including all revert paths.
- **Fuzz and invariant tests**: shares always backed by the vault; NAV never decreases on a buy or a
  sell for existing holders; the router never keeps user funds; a tripped breaker never allows a
  buy.
- **Fork tests against X Layer mainnet**: real Uniswap pools, real Chainlink feeds, real TapeOut
  processor. Buy and sell every basket at $10, $100, $1,000 and $10,000; stale oracle; sequencer
  down; price manipulation of a pool; circuit replaced or beacon upgraded (must fail closed).
- **Circuit tests**: every circuit's full truth table checked off chain against a reference model,
  then on chain through `eval` on the real processor.
- **Mainnet battery** after deployment: many wallets buying and selling in parallel, every
  transaction hash recorded in `docs/e2e`.
- **Browser end to end tests** on production with Playwright.

## 10. Timeline (15 days)

| Days | Work |
|---|---|
| 1 to 2 | Contracts (basket, router, oracle) and fork tests against real Uniswap and Chainlink |
| 3 to 5 | The three circuits, builder, simulator, truth tables; tape out on mainnet; gate contract |
| 6 to 7 | Mainnet deployment of the three baskets, battery |
| 8 to 10 | App: OKX Wallet, buy, sell, portfolio, verdicts, proof page |
| 11 to 12 | DeWEB factsheets, TapeSend notices |
| 13 to 14 | Browser tests, README, docs, demo video |
| 15 | Submission |

## 11. Open questions

- OKX DEX aggregator API key: optional. Uniswap direct is enough for our sizes and keeps the whole
  trade on chain; the aggregator may improve prices.
- Deployer wallet on X Layer mainnet: needs a few OKB for gas, DeWEB (0.08 OKB per container) and
  tape-outs, plus a small seed per basket.
