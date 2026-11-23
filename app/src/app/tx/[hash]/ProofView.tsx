"use client";

import Link from "next/link";
import { formatUnits, isHash, type Hash } from "viem";
import { darwinBasketAbi } from "@/abi/DarwinBasket";
import { darwinOracleAbi } from "@/abi/DarwinOracle";
import { AssetLogo, Bits, Check, ErrorBox, RequireDeployment, Skeleton } from "@/components/ui";
import { evalOnchain, fetchCircuit, policyBits, verdictOf, type PolicyInput, type Verdict } from "@/lib/circuits";
import { publicClient } from "@/lib/client";
import { loadMarkets, type Markets } from "@/lib/data";
import { DEPLOYMENT, explorerAddress, explorerToken, explorerTx, IS_LOCAL } from "@/lib/deployment";
import { int, qty, severityLabel, short, utc } from "@/lib/format";
import { decodeTrade, type LegEvent } from "@/lib/trade";
import { useQuery } from "@/lib/useQuery";

const AGE = ["< 1 h", "< heartbeat", "< heartbeat + grace", "stale"];

type LegProof = { leg: LegEvent; input: PolicyInput; bits: number[]; local: Verdict; onchain: Verdict | null; onchainError?: string };

async function loadProof(hash: Hash) {
  const d = DEPLOYMENT!;
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const [block, markets, circuit] = await Promise.all([
    publicClient.getBlock({ blockNumber: receipt.blockNumber }),
    loadMarkets(),
    fetchCircuit(d.policyCircuit, "darwin-trade-policy"),
  ]);
  const trade = decodeTrade(receipt);
  // The sequencer bit is not in the event: read it as it was in the trade's block. A leg can only
  // exist if the circuit allowed it, and allow requires the sequencer up, so the fallback is 1.
  const seqUp = await publicClient
    .readContract({ address: d.oracle, abi: darwinOracleAbi, functionName: "sequencerUp", blockNumber: receipt.blockNumber })
    .then((v) => (v ? 1 : 0))
    .catch(() => 1);
  const basketAddr = trade.bought?.basket ?? trade.sold?.basket ?? trade.legs[0]?.basket;
  const meta = basketAddr
    ? await publicClient
        .multicall({
          allowFailure: true,
          contracts: [
            { address: basketAddr, abi: darwinBasketAbi, functionName: "name" },
            { address: basketAddr, abi: darwinBasketAbi, functionName: "symbol" },
          ],
        })
        .then((r) => ({ name: r[0].result as string | undefined, symbol: r[1].result as string | undefined }))
    : { name: undefined, symbol: undefined };
  const legs: LegProof[] = await Promise.all(
    trade.legs.map(async (leg) => {
      const input: PolicyInput = {
        dev: leg.dev,
        age: leg.age,
        seqUp,
        isBuy: leg.isBuy ? 1 : 0,
        drift: leg.drift,
        better: leg.better ? 1 : 0,
        open: leg.open ? 1 : 0,
        pool: leg.pool ? 1 : 0,
      };
      const bits = policyBits(input);
      const local = verdictOf(circuit.circuit.eval(bits));
      try {
        const out = await evalOnchain(d.policyCircuit, bits, circuit.nOut);
        return { leg, input, bits, local, onchain: verdictOf(out) };
      } catch (e) {
        return { leg, input, bits, local, onchain: null, onchainError: (e as Error).message?.split("\n")[0] };
      }
    }),
  );
  return { receipt, block, markets, circuit, trade, legs, basket: basketAddr, basketName: meta.name, basketSymbol: meta.symbol };
}

export function ProofView({ hash }: { hash: string }) {
  return <RequireDeployment>{isHash(hash) ? <Inner hash={hash} /> : <ErrorBox title="Not a transaction hash" error={hash} />}</RequireDeployment>;
}

function Inner({ hash }: { hash: Hash }) {
  const q = useQuery(`proof:${hash}`, () => loadProof(hash), { staleMs: 600_000 });
  if (q.error) return <ErrorBox title="Could not load this transaction" error={q.error} retry={q.refresh} />;
  if (!q.data)
    return (
      <div className="stack">
        <Skeleton w={360} h={40} />
        <Skeleton h={120} />
        <Skeleton h={260} />
      </div>
    );
  const p = q.data;
  const d = DEPLOYMENT!;
  const kind = p.trade.bought ? "Buy" : p.trade.sold ? "Sell" : "Transaction";
  const allMatch = p.legs.every((l) => l.onchain && sameVerdict(l.local, l.onchain) && l.local.severity === l.leg.severity && l.local.allow === 1);

  return (
    <div className="stack-l">
      <div className="stack">
        <span className="eyebrow">Proof of a trade</span>
        <h1 className="h1">
          {kind}
          {p.basketName ? ` of ${p.basketName}` : ""}
        </h1>
        <div className="row-wrap small">
          <span className="mono muted break">{hash}</span>
          {!IS_LOCAL && (
            <a className="link" href={explorerTx(hash)} target="_blank" rel="noreferrer">
              OKLink ↗
            </a>
          )}
        </div>
      </div>

      {p.legs.length === 0 ? (
        <div className="notice notice-warn">This transaction has no Darwin trade legs (it is not a router buy or sell of this deployment).</div>
      ) : (
        <div className={`notice ${allMatch ? "notice-pos" : "notice-neg"}`} data-testid="proof-summary">
          <strong>
            {allMatch
              ? `All ${p.legs.length} legs verified.`
              : "Mismatch: a re-evaluation disagrees with the recorded verdict."}
          </strong>{" "}
          Each leg&apos;s inputs were re-run through the trade-policy circuit #{d.policyCircuit.toString()} twice: in this browser, on the netlist read from
          the processor, and on chain with processor.eval().{" "}
          {allMatch ? "Both agree with the verdict the router emitted." : "See the rows marked in red below."}
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <span className="label">Block</span>
          <div className="v">{int(p.receipt.blockNumber)}</div>
        </div>
        <div className="stat">
          <span className="label">Time</span>
          <div className="v" style={{ fontSize: 16 }}>
            {utc(Number(p.block.timestamp))}
          </div>
        </div>
        <div className="stat">
          <span className="label">{p.trade.bought ? "Shares minted" : "Shares sold"}</span>
          <div className="v">
            {qty(Number(formatUnits((p.trade.bought?.shares ?? p.trade.sold?.shares) || 0n, 18)))}
            <span className="small muted"> {p.basketSymbol}</span>
          </div>
        </div>
        <div className="stat">
          <span className="label">Gas used</span>
          <div className="v">{int(p.receipt.gasUsed)}</div>
        </div>
      </div>

      <section className="card">
        <div className="card-title">
          <div>
            <h2 className="h3">The circuit that judged it</h2>
            <p className="xsmall muted">Darwin&apos;s trade policy, a combinational TapeOut circuit, called once per leg in the same transaction.</p>
          </div>
        </div>
        <dl className="kv small">
          <dt>Processor</dt>
          <dd>
            <a className="mono link" href={explorerAddress(d.processor)} target="_blank" rel="noreferrer">
              {d.processor}
            </a>
          </dd>
          <dt>Circuit</dt>
          <dd>
            <a className="link" href={explorerToken(d.processor, d.policyCircuit)} target="_blank" rel="noreferrer">
              #{d.policyCircuit.toString()} (NFT)
            </a>{" "}
            · {p.circuit.nIn} inputs, {p.circuit.nOut} outputs, {p.circuit.gates} gates
          </dd>
          <dt>Netlist keccak256</dt>
          <dd className="mono xsmall">{p.circuit.hash}</dd>
          {p.basket && (
            <>
              <dt>Basket</dt>
              <dd>
                <Link className="link" href={`/basket/${p.basket}`}>
                  {p.basketName} ({short(p.basket)})
                </Link>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="stack">
        <h2 className="h3">Legs ({p.legs.length})</h2>
        {p.legs.map((l, i) => (
          <LegCard key={l.leg.logIndex} l={l} i={i} markets={p.markets} />
        ))}
      </section>
    </div>
  );
}

const sameVerdict = (a: Verdict, b: Verdict) => a.allow === b.allow && a.severity === b.severity;

function LegCard({ l, i, markets }: { l: LegProof; i: number; markets: Markets }) {
  const coin = markets.byAddress.get(l.leg.coin.toLowerCase());
  const quote = markets.list.find((m) => m.symbol === "USDG");
  // a buy leg spends the quote for the coin; a sell leg (or a pay-token conversion) the reverse
  const inTok = l.leg.isBuy ? quote : coin;
  const outTok = l.leg.isBuy ? coin : quote;
  const match = l.onchain ? sameVerdict(l.local, l.onchain) : false;
  const matchesEvent = l.local.severity === l.leg.severity;
  const inputs: [string, string, string][] = [
    ["dev", `${l.input.dev}`, `|execution − ${l.input.pool ? "pool's price" : "Chainlink"}| = ${(l.input.dev * 0.25).toFixed(2)}%${l.input.dev >= 15 ? "+" : ""} (0.25% steps)`],
    ["age", `${l.input.age}`, `oracle age class: ${AGE[l.input.age]}`],
    ["seqUp", `${l.input.seqUp}`, l.input.seqUp ? "X Layer sequencer up" : "sequencer down"],
    ["isBuy", `${l.input.isBuy}`, l.input.isBuy ? "buy leg (stablecoin → coin)" : "sell leg (coin → stablecoin)"],
    ["drift", `${l.input.drift}`, `|weight after − target| = ${l.input.drift} pp`],
    ["better", `${l.input.better}`, l.input.better ? "moves the coin towards its target" : "moves it further away"],
    ["open", `${l.input.open}`, l.input.open ? "market in session" : "market closed"],
    ["pool", `${l.input.pool}`, l.input.pool ? "priced by its own Uniswap pool (spot, within 1% of its 1-hour TWAP): Chainlink is frozen" : "priced by Chainlink"],
  ];
  return (
    <div className="card" data-testid="leg">
      <div className="card-title">
        <div className="row">
          {coin && <AssetLogo meta={coin.meta} size={30} />}
          <div>
            <strong>
              Leg {i + 1} · {l.leg.isBuy ? "Buy" : "Sell"} {coin?.meta.ticker ?? short(l.leg.coin)}
            </strong>
            <div className="xsmall muted num">
              {inTok ? qty(Number(formatUnits(l.leg.amountIn, inTok.decimals))) : l.leg.amountIn.toString()} {inTok?.symbol} →{" "}
              {outTok ? qty(Number(formatUnits(l.leg.amountOut, outTok.decimals))) : l.leg.amountOut.toString()} {outTok?.symbol}
            </div>
          </div>
        </div>
        <span className={`tag ${l.local.allow ? (l.local.severity === 0 ? "tag-pos" : "tag-warn") : "tag-neg"}`}>
          {l.local.allow ? "allowed" : "refused"} · {severityLabel(l.leg.severity)}
        </span>
      </div>
      <div className="grid-2">
        <div>
          <span className="eyebrow">Inputs given to the circuit</span>
          <table className="table" style={{ marginTop: 6 }}>
            <tbody>
              {inputs.map(([k, v, hint]) => (
                <tr key={k}>
                  <td className="mono small" style={{ width: 70 }}>
                    {k}
                  </td>
                  <td className="mono small" style={{ width: 30, fontWeight: 600 }}>
                    {v}
                  </td>
                  <td className="xsmall muted">{hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="xsmall muted" style={{ marginTop: 8 }}>
            14 input bits (MSB → LSB): <Bits value={l.bits.reduce((a, b, k) => a | (b << k), 0)} n={14} />
          </div>
        </div>
        <div className="stack">
          <span className="eyebrow">Verdict, three ways</span>
          <VerdictRow label="Emitted by the router (Leg event)" allow={1} severity={l.leg.severity} />
          <VerdictRow label="Re-evaluated in this browser (circuits/src simulator)" allow={l.local.allow} severity={l.local.severity} ok={matchesEvent} />
          {l.onchain ? (
            <VerdictRow label="Re-evaluated on chain: processor.eval() via eth_call" allow={l.onchain.allow} severity={l.onchain.severity} ok={match} />
          ) : (
            <div className="notice notice-neg xsmall">On-chain eval failed: {l.onchainError}</div>
          )}
          <div className={`notice ${match && matchesEvent ? "notice-pos" : "notice-neg"} xsmall`} data-testid="leg-match">
            {match && matchesEvent ? "Match: browser, chain and event agree." : "Mismatch."}
          </div>
        </div>
      </div>
    </div>
  );
}

function VerdictRow({ label, allow, severity, ok }: { label: string; allow: number; severity: number; ok?: boolean }) {
  return (
    <div className="between card-flat" style={{ padding: "10px 12px" }}>
      <span className="xsmall">{label}</span>
      <span className="row nowrap">
        <span className="mono small">
          allow={allow} sev={severity}
        </span>
        {ok !== undefined && <Check ok={ok} />}
      </span>
    </div>
  );
}
