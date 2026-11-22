"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { KindTag } from "@/components/Status";
import { AssetLogo, ErrorBox, LogoStack, RequireDeployment, Skeleton } from "@/components/ui";
import { balance, int, pct, qty, short, usd } from "@/lib/format";
import { useBalances, useBaskets } from "@/lib/hooks";
import { recentTrades } from "@/lib/trade";
import { useQuery } from "@/lib/useQuery";
import { useWallet } from "@/lib/wallet";

export function PortfolioView() {
  return (
    <RequireDeployment>
      <Inner />
    </RequireDeployment>
  );
}

function Inner() {
  const w = useWallet();
  const q = useBaskets();
  const baskets = q.data?.baskets ?? [];
  const stables = q.data?.markets.list.filter((m) => m.meta.kind === "stable") ?? [];
  const tokens = [...baskets.map((b) => b.address), ...stables.map((s) => s.address)];
  const bal = useBalances(w.account, tokens);
  const trades = useQuery(w.account ? `trades:acct:${w.account}` : null, () => recentTrades({ account: w.account! }), { refreshMs: 30_000 });

  if (!w.account)
    return (
      <div className="card stack" style={{ maxWidth: 520 }}>
        <h2 className="h2">Connect to see your positions</h2>
        <p className="muted">Your baskets, their value at Chainlink prices, and every trade with its circuit proof.</p>
        <button className="btn btn-l" onClick={() => w.setPickerOpen(true)} style={{ alignSelf: "flex-start" }}>
          Connect wallet
        </button>
      </div>
    );
  if (q.error) return <ErrorBox error={q.error} retry={q.refresh} />;
  if (!q.data || !bal.data) return <Skeleton h={280} />;

  const positions = baskets
    .map((b) => {
      const shares = bal.data![b.address.toLowerCase()]?.balance ?? 0n;
      const n = Number(formatUnits(shares, 18));
      return { b, shares, n, value: n * b.navPerShare };
    })
    .filter((p) => p.shares > 0n)
    .sort((x, y) => y.value - x.value);
  const total = positions.reduce((s, p) => s + p.value, 0);
  const cash = stables.map((s) => ({ s, amount: Number(formatUnits(bal.data![s.address.toLowerCase()]?.balance ?? 0n, s.decimals)) }));
  const cashTotal = cash.reduce((s, c) => s + c.amount * c.s.priceUsd, 0);

  return (
    <div className="stack-l">
      <div className="stats">
        <div className="stat">
          <span className="label">Invested</span>
          <div className="v" data-testid="portfolio-total">
            {usd(total)}
          </div>
        </div>
        <div className="stat">
          <span className="label">Baskets held</span>
          <div className="v">{positions.length}</div>
        </div>
        <div className="stat">
          <span className="label">Stablecoins</span>
          <div className="v">{usd(cashTotal)}</div>
        </div>
        <div className="stat">
          <span className="label">Account</span>
          <div className="v mono" style={{ fontSize: 16 }}>
            {short(w.account)}
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-title">
          <h2 className="h3">Positions</h2>
          <span className="xsmall muted">valued at NAV (Chainlink)</span>
        </div>
        {positions.length === 0 ? (
          <div className="stack-s">
            <p className="muted">No basket yet.</p>
            <Link className="btn btn-gold" href="/" style={{ alignSelf: "flex-start" }}>
              Explore baskets
            </Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="positions">
              <thead>
                <tr>
                  <th>Basket</th>
                  <th className="r">Shares</th>
                  <th className="r">NAV / share</th>
                  <th className="r">Value</th>
                  <th className="r">Allocation</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.b.address}>
                    <td>
                      <Link href={`/basket/${p.b.address}`} className="row">
                        <LogoStack metas={p.b.holdings.map((h) => h.meta)} size={22} max={4} />
                        <span>
                          <strong>{p.b.name}</strong> <KindTag kind={p.b.kind} />
                          <span className="xsmall muted mono" style={{ display: "block" }}>
                            {p.b.symbol}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="r num">{balance(p.n)}</td>
                    <td className="r num">{usd(p.b.navPerShare)}</td>
                    <td className="r num" style={{ fontWeight: 600 }}>
                      {usd(p.value)}
                    </td>
                    <td className="r num">{total > 0 ? pct(p.value / total) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card-title">
            <h2 className="h3">Stablecoins</h2>
          </div>
          <table className="table">
            <tbody>
              {cash.map(({ s, amount }) => (
                <tr key={s.address}>
                  <td>
                    <div className="row">
                      <AssetLogo meta={s.meta} size={22} />
                      <strong>{s.symbol}</strong>
                    </div>
                  </td>
                  <td className="r num">{qty(amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="card-title">
            <h2 className="h3">Your trades</h2>
          </div>
          {trades.error ? (
            <ErrorBox error={trades.error} retry={trades.refresh} />
          ) : !trades.data ? (
            <Skeleton h={80} />
          ) : trades.data.length === 0 ? (
            <p className="small muted">No trade yet.</p>
          ) : (
            <table className="table">
              <tbody>
                {trades.data.slice(0, 10).map((t) => {
                  const b = baskets.find((x) => x.address.toLowerCase() === t.basket.toLowerCase());
                  return (
                    <tr key={t.hash}>
                      <td>
                        <span className={`tag ${t.kind === "buy" ? "tag-pos" : "tag-neg"}`}>{t.kind}</span>
                      </td>
                      <td className="r num small">
                        {qty(Number(formatUnits(t.shares, 18)))} {b?.symbol ?? "shares"}
                      </td>
                      <td className="r xsmall muted num">#{int(t.block)}</td>
                      <td className="r">
                        <Link className="link small" href={`/tx/${t.hash}`}>
                          Proof →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
