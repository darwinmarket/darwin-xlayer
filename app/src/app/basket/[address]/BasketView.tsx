"use client";

import Link from "next/link";
import { formatUnits, isAddress, type Address } from "viem";
import { AllocationBar } from "@/components/BasketCard";
import { BreakerBadge, KindTag, OriginTag, SessionBadge } from "@/components/Status";
import { TradePanel } from "@/components/TradePanel";
import { AssetLogo, ErrorBox, LogoStack, RequireDeployment, Skeleton } from "@/components/ui";
import { FACTS, type BasketInfo } from "@/lib/data";
import { DEPLOYMENT, explorerAddress } from "@/lib/deployment";
import { ago, balance, int, qty, short, usd, utc } from "@/lib/format";
import { useBalances, useBasket } from "@/lib/hooks";
import { recentTrades } from "@/lib/trade";
import { useQuery } from "@/lib/useQuery";
import { useWallet } from "@/lib/wallet";

export function BasketView({ address }: { address: string }) {
  return <RequireDeployment>{isAddress(address) ? <Inner address={address} /> : <ErrorBox title="Not a basket address" error={address} />}</RequireDeployment>;
}

function Inner({ address }: { address: Address }) {
  const q = useBasket(address);
  if (q.error) return <ErrorBox error={q.error} retry={q.refresh} />;
  if (!q.data) return <BasketSkeleton />;
  const { basket: b, markets } = q.data;
  if (!b.genuine)
    return (
      <ErrorBox
        title="Not a Darwin basket"
        error={`${address} was not launched by Darwin's studio (${DEPLOYMENT?.studio}). Do not send it funds: a look-alike contract could keep them.`}
      />
    );
  return (
    <div className="stack-l">
      <Header b={b} chainTime={markets.chainTime} />
      <div className="grid-main">
        <div className="stack-l" style={{ minWidth: 0 }}>
          <Stats b={b} />
          <Composition b={b} />
          <Position b={b} />
          <Rules b={b} />
          <Trades b={b} />
        </div>
        <div className="sticky">
          <TradePanel b={b} markets={markets} onTraded={q.refresh} />
        </div>
      </div>
    </div>
  );
}

function Header({ b, chainTime }: { b: BasketInfo; chainTime: number }) {
  return (
    <div className="stack">
      <Link href="/" className="xsmall muted">
        ← All baskets
      </Link>
      <div className="row-wrap" style={{ gap: 16 }}>
        <LogoStack metas={[...b.holdings].sort((x, y) => y.target - x.target).map((h) => h.meta)} size={40} max={5} />
        <div>
          <h1 className="h1" data-testid="basket-name">
            {b.name}
          </h1>
          <div className="row-wrap" style={{ marginTop: 6 }}>
            <span className="mono small muted">{b.symbol}</span>
            <KindTag kind={b.kind} />
            <OriginTag b={b} />
            {b.hasStocks && <SessionBadge chainTime={chainTime} />}
            <BreakerBadge b={b} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stats({ b }: { b: BasketInfo }) {
  return (
    <div className="stats">
      <div className="stat">
        <span className="label">NAV per share</span>
        <div className="v" data-testid="nav">
          {b.supply > 0n ? usd(b.navPerShare) : "—"}
        </div>
      </div>
      <div className="stat">
        <span className="label">TVL (Chainlink)</span>
        <div className="v">{usd(b.navUsd)}</div>
      </div>
      <div className="stat">
        <span className="label">Shares outstanding</span>
        <div className="v">{qty(Number(formatUnits(b.supply, 18)))}</div>
      </div>
      <div className="stat">
        <span className="label">Rebalancing band</span>
        <div className="v">±{b.band} pp</div>
      </div>
    </div>
  );
}

function Composition({ b }: { b: BasketInfo }) {
  const empty = b.navUsd === 0;
  return (
    <section className="card">
      <div className="card-title">
        <div>
          <h2 className="h3">Composition</h2>
          <p className="xsmall muted">Targets come from the basket&apos;s methodology circuit, evaluated on chain (basket.targets()).</p>
        </div>
      </div>
      <AllocationBar b={b} height={12} />
      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table className="table" data-testid="composition">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="r">Price</th>
              <th className="r">Holdings</th>
              <th className="r">Value</th>
              <th style={{ width: "28%" }}>Actual vs target</th>
              <th className="r">Target</th>
            </tr>
          </thead>
          <tbody>
            {b.holdings.map((h) => {
              const drift = (h.weight - h.target) * 100;
              const lo = Math.max(0, h.target * 100 - b.band);
              const hi = Math.min(100, h.target * 100 + b.band);
              return (
                <tr key={h.coin}>
                  <td>
                    <div className="row">
                      <AssetLogo meta={h.meta} size={28} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {h.meta.ticker}{" "}
                          {!h.eligible && (
                            <span className="tag tag-warn" title="No new money until its market opens and its feed and pool are healthy">
                              paused
                            </span>
                          )}
                        </div>
                        <div className="xsmall muted">
                          {h.meta.name} · <span className="mono">{h.symbol}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="r num">{h.market ? usd(h.market.priceUsd) : "—"}</td>
                  <td className="r num">{qty(Number(formatUnits(h.balance, h.market?.decimals ?? 18)))}</td>
                  <td className="r num">{usd(h.valueUsd)}</td>
                  <td>
                    <div className="wbar" title={`band ${lo.toFixed(0)}–${hi.toFixed(0)}%`}>
                      <span className="band" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
                      <span className="fill" style={{ width: `${(empty ? 0 : h.weight) * 100}%`, background: h.meta.color }} />
                      <span className="target" style={{ left: `calc(${h.target * 100}% - 1px)` }} />
                    </div>
                    <div className="xsmall muted num" style={{ marginTop: 4 }}>
                      {empty ? "no holdings yet" : `${(h.weight * 100).toFixed(1)}% (${drift >= 0 ? "+" : ""}${drift.toFixed(1)} pp)`}
                    </div>
                  </td>
                  <td className="r num" style={{ fontWeight: 600 }}>
                    {(h.target * 100).toFixed(h.target * 100 % 1 ? 2 : 0)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="xsmall muted" style={{ marginTop: 10 }}>
        No keeper trades the vault: every buy sends new money to the coins furthest under target, every sell exits pro rata. A paused coin gets a
        0% target until its market is in session and its feed and pool are healthy.
      </p>
    </section>
  );
}

function Position({ b }: { b: BasketInfo }) {
  const w = useWallet();
  const bal = useBalances(w.account, [b.address]);
  const shares = bal.data?.[b.address.toLowerCase()]?.balance ?? 0n;
  if (!w.account || shares === 0n) return null;
  const n = Number(formatUnits(shares, 18));
  const supply = Number(formatUnits(b.supply, 18));
  return (
    <section className="card" data-testid="position">
      <div className="card-title">
        <h2 className="h3">Your position</h2>
        <strong className="num" style={{ fontSize: 20 }}>
          {usd(n * b.navPerShare)}
        </strong>
      </div>
      <dl className="kv">
        <dt>Shares</dt>
        <dd>
          {balance(n)} {b.symbol}
        </dd>
        <dt>Share of the basket</dt>
        <dd>{supply > 0 ? ((100 * n) / supply).toFixed(3) : "0"}%</dd>
        {b.holdings.map((h) => (
          <FragmentRow key={h.coin} label={`Backed by ${h.meta.ticker}`} value={`${qty((Number(formatUnits(h.balance, h.market?.decimals ?? 18)) * n) / (supply || 1))} ${h.symbol}`} />
        ))}
      </dl>
    </section>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </>
  );
}

function Rules({ b }: { b: BasketInfo }) {
  const facts = b.preview?.facts ?? 0;
  return (
    <section className="card">
      <div className="card-title">
        <h2 className="h3">Rules, on TapeOut</h2>
        <Link href="/circuits" className="link small">
          All circuits →
        </Link>
      </div>
      <div className="grid-2">
        <div className="card-flat stack-s">
          <span className="eyebrow">Methodology circuit</span>
          <div className="row">
            <strong className="num" style={{ fontSize: 18 }}>
              #{b.methodologyId.toString()}
            </strong>
            <a className="link xsmall" href={explorerAddress(DEPLOYMENT!.processor)} target="_blank" rel="noreferrer">
              processor {short(DEPLOYMENT!.processor)}
            </a>
          </div>
          <p className="xsmall muted">
            Weights and band are a NAND netlist pinned by hash (<span className="mono">{short(b.methodologyHash, 6)}</span>). The creator can
            propose a new one; it applies only after a public 3-day timelock.
          </p>
          {b.pendingEta > 0 && <div className="notice notice-warn xsmall">A new methodology is pending, applicable from {utc(b.pendingEta)}.</div>}
          <p className="xsmall">
            Creator <a className="mono link" href={explorerAddress(b.creator)} target="_blank" rel="noreferrer">{short(b.creator)}</a> earns a
            third of the 0.30% fees.
          </p>
        </div>
        <div className="card-flat stack-s">
          <span className="eyebrow">Market-risk breaker</span>
          <div className="row">
            <BreakerBadge b={b} />
            <span className="xsmall muted">
              {b.breaker.lastBeat ? `last beat ${ago(b.breaker.lastBeat)}` : "never beaten"}
              {b.breaker.tripped ? ` · ${b.breaker.counter}/8 healthy beats` : ""}
            </span>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="xsmall stack-s">
            {FACTS.map((f) => {
              const ok = ((facts >> f.bit) & 1) === 1;
              return (
                <li key={f.bit} className="row" title={f.hint}>
                  <span className={`check ${ok ? "ok" : "ko"}`}>{ok ? "✓" : "✕"}</span>
                  {f.label}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Trades({ b }: { b: BasketInfo }) {
  const q = useQuery(`trades:${b.address.toLowerCase()}`, () => recentTrades({ basket: b.address }), { refreshMs: 20_000 });
  return (
    <section className="card">
      <div className="card-title">
        <h2 className="h3">Recent trades</h2>
        <span className="xsmall muted">each one links to its circuit proof</span>
      </div>
      {q.error ? (
        <ErrorBox error={q.error} retry={q.refresh} />
      ) : !q.data ? (
        <Skeleton h={60} />
      ) : q.data.length === 0 ? (
        <p className="small muted">No trade yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Side</th>
                <th>Account</th>
                <th className="r">Shares</th>
                <th className="r">Block</th>
                <th className="r">Proof</th>
              </tr>
            </thead>
            <tbody>
              {q.data.slice(0, 12).map((t) => (
                <tr key={`${t.block}-${t.shares}-${t.kind}`}>
                  <td>
                    <span className={`tag ${t.kind === "buy" ? "tag-pos" : "tag-neg"}`}>{t.kind}</span>
                  </td>
                  <td className="mono xsmall">{short(t.who)}</td>
                  <td className="r num">{qty(Number(formatUnits(t.shares, 18)))}</td>
                  <td className="r num xsmall muted">{int(t.block)}</td>
                  <td className="r">
                    {t.hash !== "0x" && <Link className="link small" href={`/tx/${t.hash}`}>
                      Verdicts →
                    </Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BasketSkeleton() {
  return (
    <div className="stack-l" aria-busy>
      <Skeleton w={320} h={44} />
      <div className="grid-main">
        <div className="stack">
          <Skeleton h={84} />
          <Skeleton h={320} />
        </div>
        <Skeleton h={460} />
      </div>
    </div>
  );
}
