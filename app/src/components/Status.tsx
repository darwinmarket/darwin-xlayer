"use client";

import { useEffect, useRef } from "react";
import type { BasketInfo } from "@/lib/data";
import { countdown, nextChange, usOpen, utcMoment } from "@/lib/session";
import { useNow } from "./ui";

/**
 * Chain time, ticking: the last block's timestamp plus the wall-clock seconds since it was read.
 * On a local fork the chain clock can be far from the wall clock, and the contracts only know it.
 */
export function useChainNow(chainTime: number | undefined): number {
  const now = useNow();
  const ref = useRef<{ chain: number; wall: number } | null>(null);
  useEffect(() => {
    if (chainTime) ref.current = { chain: chainTime, wall: Math.floor(Date.now() / 1000) };
  }, [chainTime]);
  if (!chainTime) return now;
  const base = ref.current ?? { chain: chainTime, wall: now };
  return base.chain + Math.max(0, now - base.wall);
}

export function SessionBadge({ chainTime, compact = false }: { chainTime: number | undefined; compact?: boolean }) {
  const t = useChainNow(chainTime);
  if (!chainTime) return <span className="tag">US market</span>;
  const open = usOpen(t);
  const left = nextChange(t) - t;
  return (
    <span className={`tag ${open ? "tag-pos" : "tag-warn"}`} title={`Next change ${utcMoment(nextChange(t))}`} data-testid="session">
      <span className={`dot${open ? " dot-live" : ""}`} />
      {open ? "US stocks open" : "US stocks closed"}
      {!compact && <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>· {open ? "closes" : "opens"} in {countdown(left)}</span>}
    </span>
  );
}

export function BreakerBadge({ b }: { b: BasketInfo }) {
  const tripped = b.breaker.tripped || b.preview?.tripped;
  if (tripped)
    return (
      <span className="tag tag-neg" title="Breaker tripped: sell and redeem only" data-testid="breaker">
        <span className="dot" /> Breaker tripped
      </span>
    );
  return (
    <span className="tag tag-pos" title="Market-risk breaker healthy" data-testid="breaker">
      <span className="dot" /> Breaker armed
    </span>
  );
}

export function KindTag({ kind }: { kind: BasketInfo["kind"] }) {
  return <span className={`tag tag-${kind}`}>{kind === "stocks" ? "Stocks" : kind === "crypto" ? "Crypto" : "Mixed"}</span>;
}
