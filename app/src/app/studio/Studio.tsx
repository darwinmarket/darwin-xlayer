"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatEther, keccak256, parseEventLogs, type Address, type Hash } from "viem";
import { darwinStudioAbi } from "@/abi/DarwinStudio";
import { methodology, methodologyModel, type Methodology } from "@/circuits/darwin.ts";
import { CircuitDiagram } from "@/components/CircuitDiagram";
import { AssetLogo, ErrorBox, RequireDeployment, Skeleton } from "@/components/ui";
import { KIND_LABEL, type AssetKind } from "@/lib/assets";
import { publicClient } from "@/lib/client";
import type { Market } from "@/lib/data";
import { DEPLOYMENT, explorerToken } from "@/lib/deployment";
import { errorText, int, toHex, usd } from "@/lib/format";
import { useMarkets } from "@/lib/hooks";
import { send } from "@/lib/tx";
import { invalidate, useQuery } from "@/lib/useQuery";
import { useWallet } from "@/lib/wallet";
import styles from "./Studio.module.css";

type Pick = { address: Address; weight: number };

const PRESETS: { name: string; symbol: string; tickers: [string, number][]; band: number }[] = [
  { name: "AI Leaders", symbol: "AIdw", tickers: [["wNVDAx", 40], ["wGOOGLx", 30], ["wAAPLx", 30]], band: 5 },
  { name: "Stocks and Bitcoin", symbol: "SBTCdw", tickers: [["wSPYx", 50], ["wQQQx", 25], ["xBTC", 25]], band: 4 },
  { name: "Bitcoin Treasury", symbol: "BTCTdw", tickers: [["wMSTRx", 40], ["xBTC", 40], ["wCRCLx", 20]], band: 6 },
];

/** TapeOut cost model (measured on X Layer): ~22.6k gas per call plus ~2.4k gas per gate. */
const CALL_GAS = 22_600;
const GATE_GAS = 2_400;
const GAS_PRICE_GWEI = 0.02;

export function Studio() {
  return (
    <RequireDeployment>
      <Inner />
    </RequireDeployment>
  );
}

function Inner() {
  const mq = useMarkets();
  const w = useWallet();
  const [picks, setPicks] = useState<Pick[]>([]);
  const [band, setBand] = useState(5);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [row, setRow] = useState(8); // index 0, eligible: the first coin's weight lights up
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ basket: Address; circuitId: bigint; hash: Hash } | null>(null);

  const markets = mq.data;
  const byAddr = markets?.byAddress;
  const selected = picks.map((p) => ({ ...p, market: byAddr?.get(p.address.toLowerCase()) })).filter((p) => p.market) as (Pick & { market: Market })[];
  const sum = picks.reduce((s, p) => s + p.weight, 0);

  const toggle = (m: Market) => {
    setLaunched(null);
    setPicks((ps) => {
      if (ps.some((p) => p.address === m.address)) return rebalance(ps.filter((p) => p.address !== m.address));
      if (ps.length >= 8) return ps;
      return rebalance([...ps, { address: m.address, weight: 0 }]);
    });
  };
  const setWeight = (a: Address, v: number) => setPicks((ps) => ps.map((p) => (p.address === a ? { ...p, weight: Math.max(0, Math.min(100, Math.round(v))) } : p)));

  const applyPreset = (pr: (typeof PRESETS)[number]) => {
    if (!markets) return;
    const ps = pr.tickers
      .map(([sym, wt]) => ({ m: markets.list.find((x) => x.symbol === sym), wt }))
      .filter((x) => x.m)
      .map((x) => ({ address: x.m!.address, weight: x.wt }));
    setPicks(ps);
    setBand(pr.band);
    setName(pr.name);
    setSymbol(pr.symbol);
    setLaunched(null);
  };

  // ---- the methodology circuit, built in the browser -------------------------------------------
  const spec: Methodology | null = useMemo(() => {
    if (selected.length === 0) return null;
    return { name: name.trim() || "my-strategy", coins: selected.map((p) => ({ symbol: p.market.symbol, weight: p.weight })), band };
  }, [selected, name, band]);
  const built = useMemo(() => {
    if (!spec) return null;
    try {
      const c = methodology(spec);
      const bytes = c.encode();
      const hex = toHex(bytes);
      return { circuit: c, hex, hash: keccak256(hex), bytes: bytes.length, error: null as string | null };
    } catch (e) {
      return { circuit: null, hex: null, hash: null, bytes: 0, error: (e as Error).message };
    }
  }, [spec]);
  // the launch fee depends on the circuit's size (tape-out fee + a fee per gate)
  const gates = built?.circuit?.gates ?? 0;
  const fee = useQuery(DEPLOYMENT && gates ? `studio:fee:${gates}` : null, () =>
    publicClient.readContract({ address: DEPLOYMENT!.studio, abi: darwinStudioAbi, functionName: "launchFee", args: [BigInt(gates)] }),
  );
  const table = useMemo(() => {
    if (!built?.circuit || !spec) return [];
    const rows = [];
    for (let eligible = 0; eligible < 2; eligible++)
      for (let index = 0; index < 8; index++) {
        const bits = [index & 1, (index >> 1) & 1, (index >> 2) & 1, eligible];
        const out = built.circuit.eval(bits);
        const weight = out.slice(0, 7).reduce((a, b, k) => a | (b << k), 0);
        const bnd = out.slice(7, 11).reduce((a, b, k) => a | (b << k), 0);
        const model = methodologyModel(spec, index, eligible);
        rows.push({ index, eligible, bits, weight, band: bnd, ok: model.weight === weight && model.band === bnd });
      }
    return rows;
  }, [built, spec]);

  const perEval = CALL_GAS + GATE_GAS * gates;
  const perBuy = perEval * selected.length;
  const okb = markets?.list.find((m) => m.symbol === "WOKB")?.priceUsd ?? 0;
  const perBuyUsd = perBuy * GAS_PRICE_GWEI * 1e-9 * okb;

  const nameOk = name.trim().length >= 3 && name.trim().length <= 40;
  const symbolOk = /^[A-Za-z0-9]{2,12}$/.test(symbol);
  const valid = !!built?.circuit && sum === 100 && selected.every((p) => p.weight > 0) && nameOk && symbolOk && gates <= 400;

  async function launch() {
    if (!built?.hex || !fee.data) return;
    setBusy(true);
    setError(null);
    try {
      await w.ensureChain();
      const receipt = await send(w.walletClient(), {
        address: DEPLOYMENT!.studio,
        abi: darwinStudioAbi,
        functionName: "createStrategy",
        args: [name.trim(), symbol, selected.map((p) => p.address), built.hex],
        value: fee.data,
      });
      const ev = parseEventLogs({ abi: darwinStudioAbi, logs: receipt.logs, eventName: "StrategyCreated" })[0];
      if (!ev) throw new Error("No StrategyCreated event in the receipt");
      setLaunched({ basket: ev.args.basket, circuitId: ev.args.circuitId, hash: receipt.transactionHash });
      invalidate("baskets");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (mq.error) return <ErrorBox error={mq.error} retry={mq.refresh} />;

  const groups: AssetKind[] = ["stock", "crypto", "stable"];
  return (
    <div className={styles.layout}>
      <div className="stack-l" style={{ minWidth: 0 }}>
        <section className="card stack">
          <div className="between">
            <h2 className="h3">1 · Pick 1 to 8 assets</h2>
            <span className="xsmall muted">{picks.length}/8 selected</span>
          </div>
          <div className="row-wrap">
            <span className="xsmall muted">Start from</span>
            {PRESETS.map((p) => (
              <button key={p.name} className="btn btn-ghost btn-s" onClick={() => applyPreset(p)} disabled={!markets}>
                {p.name}
              </button>
            ))}
          </div>
          {!markets
            ? [0, 1].map((i) => <Skeleton key={i} h={88} />)
            : groups.map((g) => {
                const list = markets.list.filter((m) => m.meta.kind === g);
                if (!list.length) return null;
                return (
                  <div key={g}>
                    <div className="eyebrow" style={{ marginBottom: 8 }}>
                      {KIND_LABEL[g]}
                    </div>
                    <div className={styles.assets}>
                      {list.map((m) => {
                        const on = picks.some((p) => p.address === m.address);
                        return (
                          <button
                            key={m.address}
                            className={`${styles.asset} ${on ? styles.on : ""}`}
                            onClick={() => toggle(m)}
                            aria-pressed={on}
                            disabled={!on && picks.length >= 8}
                            data-testid={`asset-${m.symbol}`}
                          >
                            <AssetLogo meta={m.meta} size={28} />
                            <span className={styles.assetText}>
                              <strong>{m.meta.ticker}</strong>
                              <span>{m.meta.name}</span>
                            </span>
                            <span className="xsmall muted num">{usd(m.priceUsd)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
        </section>

        <section className="card stack">
          <div className="between">
            <h2 className="h3">2 · Weights and band</h2>
            <div className="row">
              <span className={`tag ${sum === 100 ? "tag-pos" : "tag-warn"}`} data-testid="weight-sum">
                Σ {sum}%
              </span>
              <button className="btn btn-ghost btn-s" onClick={() => setPicks((ps) => rebalance(ps.map((p) => ({ ...p, weight: 0 }))))} disabled={!picks.length}>
                Equal weights
              </button>
            </div>
          </div>
          {selected.length === 0 ? (
            <p className="small muted">Pick assets above. Weights must be whole percents summing to 100.</p>
          ) : (
            <div className="stack-s">
              {selected.map((p, i) => (
                <div key={p.address} className={styles.weightRow}>
                  <span className="mono xsmall muted">#{i}</span>
                  <AssetLogo meta={p.market.meta} size={24} />
                  <strong style={{ width: 64 }}>{p.market.meta.ticker}</strong>
                  <input type="range" min={0} max={100} value={p.weight} onChange={(e) => setWeight(p.address, Number(e.target.value))} aria-label={`${p.market.meta.ticker} weight`} />
                  <span className="row" style={{ gap: 4 }}>
                    <input
                      className="input num"
                      style={{ width: 64, height: 34, textAlign: "right" }}
                      value={p.weight}
                      inputMode="numeric"
                      onChange={(e) => setWeight(p.address, Number(e.target.value.replace(/\D/g, "") || 0))}
                      aria-label={`${p.market.meta.ticker} weight percent`}
                      data-testid={`weight-${p.market.symbol}`}
                    />
                    %
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className={styles.weightRow} style={{ marginTop: 8 }}>
            <span />
            <span />
            <strong style={{ width: 64 }}>Band</strong>
            <input type="range" min={1} max={15} value={band} onChange={(e) => setBand(Number(e.target.value))} aria-label="Band" />
            <span className="num" style={{ width: 92, textAlign: "right" }}>
              ±{band} pp
            </span>
          </div>
          <p className="xsmall muted">
            The band is how far a coin may drift from its target before buys that push it further are refused by the trade-policy circuit.
          </p>
        </section>

        <section className="card stack">
          <h2 className="h3">3 · Name it</h2>
          <div className="grid-2">
            <label className="field">
              <span className="label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="AI Leaders" maxLength={40} data-testid="name" />
            </label>
            <label className="field">
              <span className="label">Symbol</span>
              <input className="input mono" value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} placeholder="AIdw" maxLength={12} data-testid="symbol" />
            </label>
          </div>
        </section>
      </div>

      <aside className="stack-l" style={{ minWidth: 0 }}>
        <section className="card stack" data-testid="circuit-panel">
          <div className="between">
            <div>
              <span className="eyebrow">Live</span>
              <h2 className="h3">Your methodology circuit</h2>
            </div>
            {built?.circuit && (
              <span className="tag tag-crypto" data-testid="gate-count">
                {gates} gates
              </span>
            )}
          </div>
          {!spec ? (
            <p className="small muted">Pick assets to build the circuit. It is compiled in this browser with the same TypeScript builder the contracts were tested against.</p>
          ) : built?.error ? (
            <div className="notice notice-warn small">{sum !== 100 ? `Weights sum to ${sum}%: they must sum to 100% before the circuit can be built.` : built.error}</div>
          ) : built?.circuit ? (
            <>
              <dl className="kv small">
                <dt>Inputs → outputs</dt>
                <dd>4 → 11 bits (index, eligible → weight, band)</dd>
                <dt>Gates</dt>
                <dd>
                  {built.circuit.nNand} NAND · {built.bytes} bytes {gates > 400 && <span className="neg">(over the 400-gate limit)</span>}
                </dd>
                <dt>keccak256</dt>
                <dd className="mono xsmall break">{built.hash}</dd>
                <dt>Gas per buy</dt>
                <dd>
                  ≈ {int(perBuy)} gas for targets ({selected.length} × {int(perEval)})
                  {perBuyUsd > 0 && <span className="muted"> ≈ {usd(perBuyUsd)}</span>}
                </dd>
              </dl>
              <CircuitDiagram
                circuit={built.circuit}
                inputs={table[row]?.bits}
                inputLabels={["idx0", "idx1", "idx2", "elig"]}
                outputLabels={["w0", "w1", "w2", "w3", "w4", "w5", "w6", "b0", "b1", "b2", "b3"]}
                height={220}
              />
              <p className="xsmall muted">Click a row of the truth table to light the wires carrying a 1.</p>
              <div className="table-wrap" style={{ maxHeight: 340 }}>
                <table className="table" data-testid="truth-table">
                  <thead>
                    <tr>
                      <th>Index</th>
                      <th>Eligible</th>
                      <th>Coin</th>
                      <th className="r">Weight</th>
                      <th className="r">Band</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {table.map((r, i) => (
                      <tr key={i} onClick={() => setRow(i)} style={{ cursor: "pointer", background: i === row ? "var(--gold-wash)" : undefined }}>
                        <td className="mono">
                          {r.index} <span className="dim">({r.index.toString(2).padStart(3, "0")})</span>
                        </td>
                        <td className="mono">{r.eligible}</td>
                        <td className="small">{selected[r.index]?.market.meta.ticker ?? <span className="dim">—</span>}</td>
                        <td className="r num">{r.weight}%</td>
                        <td className="r num">{r.band ? `±${r.band}` : "0"}</td>
                        <td>{r.ok ? <span className="check ok">✓</span> : <span className="check ko">✕</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary className="small" style={{ cursor: "pointer" }}>
                  Netlist (TAP-02 hex)
                </summary>
                <div className="hex" style={{ marginTop: 8 }} data-testid="netlist-hex">
                  {built.hex}
                </div>
              </details>
            </>
          ) : null}
        </section>

        <section className="card stack">
          <h2 className="h3">4 · Tape out and launch</h2>
          <p className="small muted">
            One transaction: the studio tapes your netlist out on Darwin&apos;s TapeOut processor, checks on chain that it really gives these weights
            (summing to 100, one band, nothing for missing coins), deploys the basket and sends you the circuit&apos;s NFT.
          </p>
          <ul className={styles.perks}>
            <li>
              <strong>You earn a third of the fees.</strong> Every buy and sell pays 0.30%; 0.10% goes to the strategy&apos;s creator.
            </li>
            <li>
              <strong>You own the rules.</strong> You can propose a new methodology circuit; it applies only after a public 3-day timelock, so holders can
              always leave first.
            </li>
          </ul>
          <dl className="kv small">
            <dt>Launch fee (tape-out fee + {gates} gates)</dt>
            <dd>{fee.data !== undefined ? `${formatEther(fee.data)} OKB` : "…"}</dd>
          </dl>
          {!w.account ? (
            <button className="btn btn-l btn-block" onClick={() => w.setPickerOpen(true)}>
              Connect wallet
            </button>
          ) : (
            <button className="btn btn-l btn-block btn-gold" disabled={!valid || busy || fee.data === undefined} onClick={launch} data-testid="launch">
              {busy && <span className="spin" />}
              Tape out &amp; launch
            </button>
          )}
          {!valid && spec && (
            <p className="xsmall muted">
              {sum !== 100 ? "Weights must sum to 100%. " : ""}
              {selected.some((p) => p.weight === 0) ? "Every asset needs a weight. " : ""}
              {!nameOk ? "Name: 3 to 40 characters. " : ""}
              {!symbolOk ? "Symbol: 2 to 12 letters or digits." : ""}
            </p>
          )}
          {error && (
            <div className="notice notice-neg small" role="alert">
              {error}
            </div>
          )}
          {launched && (
            <div className="notice notice-pos small stack-s" data-testid="launched">
              <strong>Launched.</strong>
              <div>
                Basket{" "}
                <Link className="link mono" href={`/basket/${launched.basket}`}>
                  {launched.basket}
                </Link>
              </div>
              <div>
                Methodology circuit NFT{" "}
                <a className="link" href={explorerToken(DEPLOYMENT!.processor, launched.circuitId)} target="_blank" rel="noreferrer">
                  #{launched.circuitId.toString()}
                </a>{" "}
                is in your wallet.
              </div>
              <Link className="btn btn-s" href={`/basket/${launched.basket}`} style={{ alignSelf: "flex-start" }}>
                Open the basket →
              </Link>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

/** Spread 100% over the picks: whole percents, the remainder to the first ones. */
function rebalance(ps: Pick[]): Pick[] {
  if (!ps.length) return ps;
  const base = Math.floor(100 / ps.length);
  let rest = 100 - base * ps.length;
  return ps.map((p) => ({ ...p, weight: base + (rest-- > 0 ? 1 : 0) }));
}
