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
| Chainlink | price coins | price a buy outside 2% of the pool, which the circuit refuses |
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
| US stock market closed | stock legs refused as closed; mixed baskets buy their open markets; no breaker trip | `WeekendTest` |

## Not covered

- **The tokenized stocks themselves.** xStocks are issued by a third party and are only as good as
  their issuer and custodian. Darwin prices them with Chainlink's equity feeds and does not verify
  their backing (no reserve feed exists for them on X Layer).
- **TapeOut's correctness.** Darwin's circuits are tested against our simulator and the TAP-02
  reference, and checked on chain, but the processor itself is third-party, upgradeable and
  unaudited. Darwin fails closed if it changes; it cannot defend against a bug in the pinned version.
- **Chainlink.** A wrong answer within 2% of the pool would pass. Both would have to be wrong.
- **Uniswap liquidity.** Large trades cost more; the policy refuses them when the cost exceeds 2%.
- **Holidays.** The session calendar knows weekends, not exchange holidays; on a holiday the equity
  feeds go stale and the policy refuses stock legs as stale.
- **No audit.** Built during a hackathon. Do not put in what you cannot afford to lose.
