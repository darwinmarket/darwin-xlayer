# Threat model

What Darwin on X Layer protects, against whom, and what it does not cover.

## Assets

- The coins and stocks inside each basket (held by the basket contract).
- The buyer's stablecoins during a trade (held for one transaction by the router).
- The fairness of the share price for existing holders.

## Who is trusted for what

| Party | Can | Cannot |
|---|---|---|
| Basket owner (the strategy's creator) | propose a new methodology circuit, applied after 3 days | move coins, mint shares, pause exits, change the fee |
| Treasury | receive fees | anything else |
| Router | mint shares after handing the coins in | redeem other people's shares |
| TapeOut processor | evaluate circuits | change a circuit Darwin pinned without every call failing |
| Chainlink | price coins (stocks: in session) | price a buy outside 2% of the pool, which the circuit refuses |
| xStocks pools | price a stock while its feed rests (1-hour TWAP) | move it more than 10% from the last Chainlink price, or price it while being pushed (spot more than 1% off the TWAP) |
| Anyone | buy, sell, redeem in kind, beat a breaker, launch a strategy | reopen a tripped breaker faster than 8 healthy beats over 1 h 45 min |

There is no admin key over funds, no pause on exits, no upgradeable Darwin contract.

## Attacks and answers

| Attack | Answer | Test |
|---|---|---|
| Sandwich or manipulate a pool before a buy | each leg's real execution price must be within 2% of Chainlink (3% for sells), judged by the policy circuit; the swap's own minimum output is set from Chainlink too | `test_buyRefusedWhenAPoolIsManipulated`, `test_stockPoolManipulationIsRefused` |
| Flash-loan a pool to trip a breaker | the breaker reads 30-minute TWAPs (or the longest window the pool covers), never the spot price; a pool without history is never judged | `DarwinGuard.facts` |
| Buy shares at a stale or wrong oracle price | new shares are worth the lower of the oracle value bought and the value paid; buys need a fresh feed | `test_buyEveryBasketAtEverySize` (existing holders never lose) |
| Share price inflation on a new basket | the first buy must bring 5 USD and locks 1 USD of shares at DEAD forever | `test_firstBuyLocksADollarAtDead` |
| TapeOut upgrades its processor | the guard pins the beacon implementation and fails closed | `test_processorUpgradeFailsClosed` |
| A different circuit under the same id | netlist hashes pinned at deployment and on every methodology proposal | `test_wrongCircuitHashIsRejected` |
| A creator changes the rules on holders | 3-day timelock, visible on chain; holders can leave in the meantime | `test_methodologyChangeWaitsForTheTimelock` |
| A creator launches a broken methodology | the studio evaluates the new circuit on chain: weights sum to 100, nothing on missing coins, NAND only, at most 400 gates | `StudioTest` |
| Sequencer outage on X Layer | Chainlink's uptime feed: no buy while down or within an hour of a restart | `test_sequencerDownClosesBuying` |
| A wrapped asset loses its backing | xBTC/BTC exchange rate below 0.995 trips the breaker | `DarwinGuard.facts` |
| A dead feed traps holders | redeeming in kind needs no oracle, no circuit, no router | `test_staleFeedTripsTheBreakerButExitsStayOpen` |
| US stock market closed | stocks are priced by their own pool's 1-hour TWAP (the pools trade all weekend); a stock without a trustworthy pool price takes no money and a basket holding it takes no buy (no one takes the reopening gap from holders); redeeming in kind stays open; no breaker trip | `WeekendTest`, `test_noBuyWhileAHeldStockIsClosed` |
| Push a stock pool on a weekend to misprice a basket | the price is a 1-hour TWAP; a spot more than 1% off it removes the price; it may not leave 10% of the last Chainlink price; the pool must have moved within 6 h; the circuit holds pool-priced legs to 1.5%/2% | `test_aPushedPoolLosesItsPrice`, `test_aPoolHeldFarOffForAnHourHasNoPrice`, `test_aQuietPoolHasNoPrice` |
| Equity feeds wake up late on Monday | between 01:00 and the first answer, stocks are priced by their pools and no breaker trips | `test_mondaysFirstHour` |
| A contract posing as a basket | the router only trades baskets launched by its studio | `test_fakeBasketIsRefused` |
| Chainlink's daily feeds land seconds late | 24 h heartbeats get 15 minutes of margin, so nobody can trip every breaker in those seconds | `test_lateDailyFeedDoesNotTripTheBreaker` |
| Dust legs that cannot be priced | allocations under 1 cent go to the largest leg | `test_dustLegsGoToTheLargestLeg` |
| Draining the studio's transistors | a fee per gate (0.00005 OKB) to the treasury | `test_launchFeeGrowsWithGates` |
| A methodology that funds stale or closed coins | every launch and every proposal is evaluated on all 16 inputs: 0 for ineligible coins, sum 100, at most 400 gates | `test_methodologyMustIgnoreIneligibleCoins`, `test_proposalIsCheckedLikeALaunch` |

## Audit

Before mainnet, three independent reviews ran on 2026-11-23: contracts (security and every mainnet
address, decimal and pool checked on chain), circuits (all 16,384 policy inputs, 512 breaker cases
and every methodology evaluated on the real TapeOut processor and against the TAP-02 reference, 0
mismatches) and the app (transactions, RPC limits, phishing). No critical issue; every medium and
low finding is fixed and has a regression test in `contracts/test/Regression.t.sol`.

The same day, weekend pricing was added (stocks priced by their pools while their feeds rest). It
also fixed a breaker trip in Monday's first hour, when the session is open but some equity feeds
have not answered yet. The new policy circuit was swept again on the real TapeOut processor (all
32,768 inputs, 0 mismatches).

## Not covered

- **The tokenized stocks themselves.** xStocks are issued by a third party and are only as good as
  their issuer and custodian. Darwin prices them with Chainlink's equity feeds and does not verify
  their backing (no reserve feed exists for them on X Layer).
- **TapeOut's correctness.** Darwin's circuits are tested against our simulator and the TAP-02
  reference, and checked on chain, but the processor itself is third-party, upgradeable and
  unaudited. Darwin fails closed if it changes; it cannot defend against a bug in the pinned version.
- **Chainlink.** A wrong answer within 2% of the pool would pass. Both would have to be wrong.
- **A pool held off its market for an hour.** On a weekend, someone holding a stock's pool off its
  true price for a full hour, against every arbitrageur, moves its TWAP; the price stays within 10%
  of the last Chainlink price and within 1% of the pool's own spot. The cost of holding a ~$1M pool
  off for an hour is expected to exceed what that buys; we did not measure arbitrage speed.
- **Uniswap liquidity.** Large trades cost more; the policy refuses them when the cost exceeds 2%.
- **Holidays.** The session calendar knows weekends, not exchange holidays; on a holiday the equity
  feeds go past their heartbeat and the stocks are priced by their pools, like on a weekend.
- **No audit.** Built during a hackathon. Do not put in what you cannot afford to lose.
