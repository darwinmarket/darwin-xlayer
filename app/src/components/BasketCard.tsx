"use client";

import Link from "next/link";
import type { BasketInfo } from "@/lib/data";
import { usd } from "@/lib/format";
import { BreakerBadge, KindTag, SessionBadge } from "./Status";
import { AssetLogo, LogoStack, Skeleton } from "./ui";
import styles from "./BasketCard.module.css";

/** Target weights when the basket is empty or a coin is ineligible; actual weights otherwise. */
export function displayWeights(b: BasketInfo) {
  const hasValue = b.navUsd > 0;
  return b.holdings.map((h) => ({ ...h, shown: hasValue ? h.weight : h.target }));
}

export function AllocationBar({ b, height = 10 }: { b: BasketInfo; height?: number }) {
  const ws = displayWeights(b);
  return (
    <div className="alloc" style={{ height }} aria-hidden>
      {ws.map((h) => (
        <span key={h.coin} style={{ width: `${Math.max(h.shown * 100, 0.5)}%`, background: h.meta.color }} title={`${h.meta.ticker} ${(h.shown * 100).toFixed(1)}%`} />
      ))}
    </div>
  );
}

export function BasketCard({ b, chainTime }: { b: BasketInfo; chainTime: number }) {
  const ws = displayWeights(b).sort((x, y) => y.shown - x.shown);
  return (
    <Link href={`/basket/${b.address}`} className={styles.card} data-testid="basket-card" aria-label={`Open ${b.name} (${b.symbol})`}>
      <div className={styles.head}>
        <LogoStack metas={ws.map((h) => h.meta)} size={30} max={4} />
        <div className={styles.name}>
          <strong>{b.name}</strong>
          <span className="mono xsmall muted">{b.symbol}</span>
        </div>
        <KindTag kind={b.kind} />
      </div>

      <AllocationBar b={b} />
      <ul className={styles.legs}>
        {ws.slice(0, 5).map((h) => (
          <li key={h.coin}>
            <AssetLogo meta={h.meta} size={16} />
            <span className={styles.ticker}>{h.meta.ticker}</span>
            <span className="num muted">{(h.shown * 100).toFixed(h.shown * 100 >= 10 ? 0 : 1)}%</span>
          </li>
        ))}
        {ws.length > 5 && <li className="muted">+{ws.length - 5} more</li>}
      </ul>

      <div className={styles.figures}>
        <div>
          <span className="label">NAV / share</span>
          <strong className="num">{b.supply > 0n ? usd(b.navPerShare) : "—"}</strong>
        </div>
        <div>
          <span className="label">TVL</span>
          <strong className="num">{usd(b.navUsd, { compact: true })}</strong>
        </div>
      </div>

      <div className={styles.foot}>
        {b.hasStocks && <SessionBadge chainTime={chainTime} compact />}
        <BreakerBadge b={b} />
      </div>
    </Link>
  );
}

export function BasketCardSkeleton() {
  return (
    <div className={styles.card} aria-hidden>
      <div className={styles.head}>
        <Skeleton w={90} h={30} r={999} />
        <div className={styles.name} style={{ gap: 6 }}>
          <Skeleton w={140} h={16} />
          <Skeleton w={60} h={12} />
        </div>
      </div>
      <Skeleton h={10} r={999} />
      <Skeleton h={44} />
      <Skeleton h={40} />
    </div>
  );
}
