"use client";

import Link from "next/link";
import { BasketCard, BasketCardSkeleton } from "@/components/BasketCard";
import { SessionBadge } from "@/components/Status";
import { ErrorBox, NotDeployed } from "@/components/ui";
import { DEPLOYMENT } from "@/lib/deployment";
import { usd } from "@/lib/format";
import { useBaskets } from "@/lib/hooks";
import styles from "./Home.module.css";

export function Home() {
  const q = useBaskets();
  const data = q.data;
  const stocks = data?.baskets.filter((b) => b.kind !== "crypto") ?? [];
  const crypto = data?.baskets.filter((b) => b.kind === "crypto") ?? [];
  const tvl = data?.baskets.reduce((s, b) => s + b.navUsd, 0) ?? 0;
  const stockCount = data?.markets.list.filter((m) => m.meta.kind === "stock").length ?? 0;

  return (
    <>
      <section className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <span className={styles.kicker}>
            <span className="dot" /> Darwin on X Layer
          </span>
          <h1 className={styles.title}>
            Index baskets of <em>tokenized stocks</em> and crypto on X Layer, governed by TapeOut circuits.
          </h1>
          <p className={styles.sub}>
            One token, a whole strategy. Buy NVIDIA, the S&amp;P 500, Tesla and Bitcoin in one transaction with USDG, USDC or USD₮0.
            Every leg of every trade is judged on chain by a public circuit; nobody ever holds your funds.
          </p>
          <div className={styles.ctas}>
            <a href="#stocks" className="btn btn-gold btn-l">
              Explore baskets
            </a>
            <Link href="/studio" className={`btn btn-l ${styles.ghost}`}>
              Design your strategy
            </Link>
          </div>
          <div className={styles.strip}>
            <div>
              <span>Total value locked</span>
              <strong className="num">{data ? usd(tvl, { compact: true }) : "—"}</strong>
            </div>
            <div>
              <span>Baskets</span>
              <strong className="num">{data ? data.baskets.length : "—"}</strong>
            </div>
            <div>
              <span>Tokenized US stocks</span>
              <strong className="num">{data ? stockCount : "—"}</strong>
            </div>
            <div>
              <span>Market</span>
              <strong>
                <SessionBadge chainTime={data?.markets.chainTime} />
              </strong>
            </div>
          </div>
        </div>
      </section>

      <div className="container page">
        {!DEPLOYMENT ? (
          <NotDeployed />
        ) : q.error ? (
          <ErrorBox error={q.error} retry={q.refresh} />
        ) : (
          <div className="stack-l">
            <section id="stocks" className="stack">
              <div className="between">
                <div>
                  <span className="eyebrow">Headline</span>
                  <h2 className="h2">Tokenized stock baskets</h2>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    xStocks trade 24/5 with Chainlink equity feeds. Buys close with the US session; selling and redeeming in kind never close.
                  </p>
                </div>
              </div>
              <div className="grid-3">
                {!data && [0, 1, 2].map((i) => <BasketCardSkeleton key={i} />)}
                {stocks.map((b) => (
                  <BasketCard key={b.address} b={b} chainTime={data!.markets.chainTime} />
                ))}
              </div>
              {data && stocks.length === 0 && <p className="muted">No stock basket yet. Be the first in the Studio.</p>}
            </section>

            <section id="crypto" className="stack">
              <div>
                <span className="eyebrow">24/7</span>
                <h2 className="h2">Crypto baskets</h2>
              </div>
              <div className="grid-3">
                {!data && [0, 1, 2].map((i) => <BasketCardSkeleton key={i} />)}
                {crypto.map((b) => (
                  <BasketCard key={b.address} b={b} chainTime={data!.markets.chainTime} />
                ))}
              </div>
              {data && crypto.length === 0 && <p className="muted">No crypto basket yet.</p>}
            </section>

            <section className={styles.how}>
              <div>
                <span className="eyebrow">How a trade works</span>
                <h2 className="h2" style={{ marginTop: 6 }}>
                  Circuits decide. Solidity only carries the facts.
                </h2>
              </div>
              <ol className={styles.steps}>
                <li>
                  <strong>One transaction</strong>
                  <p>Your stablecoin goes in, the router buys every coin on Uniswap v3, the coins land in the basket vault, shares are minted to you.</p>
                </li>
                <li>
                  <strong>Every leg judged by TapeOut</strong>
                  <p>
                    The trade-policy circuit sees the real execution price against Chainlink, the feed&apos;s age, the sequencer, the market session and
                    the basket&apos;s drift. One refused leg reverts the whole trade.
                  </p>
                </li>
                <li>
                  <strong>A breaker nobody can reset by hand</strong>
                  <p>A stateful LATCH circuit trips the basket to sell-only on stale feeds, depegs or broken pools, and only reopens after eight healthy beats.</p>
                </li>
                <li>
                  <strong>Replay any decision</strong>
                  <p>
                    Each trade links to a proof page that re-runs every verdict in your browser and on chain.{" "}
                    <Link className="link" href="/circuits">
                      See the circuits
                    </Link>
                  </p>
                </li>
              </ol>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
