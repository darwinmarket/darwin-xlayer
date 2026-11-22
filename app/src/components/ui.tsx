"use client";

import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { AssetMeta } from "@/lib/assets";
import { DEPLOYMENT, DEPLOYMENT_NAME } from "@/lib/deployment";
import { errorText } from "@/lib/format";

export const AssetLogo = memo(function AssetLogo({ meta, size = 24 }: { meta: AssetMeta; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style: CSSProperties = { width: size, height: size };
  if (meta.logo && !failed) {
    return (
      <span className="logo" style={style} title={meta.name}>
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny local logos */}
        <img src={`/logos/${meta.logo}`} alt="" width={size} height={size} onError={() => setFailed(true)} />
      </span>
    );
  }
  const label = meta.ticker.slice(0, meta.ticker.length > 4 ? 3 : 4);
  return (
    <span
      className="logo"
      aria-hidden
      title={meta.name}
      style={{ ...style, background: meta.color, fontSize: Math.max(8, Math.round(size * (label.length > 3 ? 0.27 : 0.34))) }}
    >
      {label}
    </span>
  );
});

export function LogoStack({ metas, size = 26, max = 5 }: { metas: AssetMeta[]; size?: number; max?: number }) {
  const extra = metas.length - max;
  return (
    <span className="logo-stack" style={{ "--overlap": `${Math.round(size * 0.3)}px` } as CSSProperties}>
      {metas.slice(0, max).map((m, i) => (
        <AssetLogo key={`${m.symbol}-${i}`} meta={m} size={size} />
      ))}
      {extra > 0 && (
        <span className="logo" style={{ width: size, height: size, background: "var(--paper-2)", color: "var(--ink-2)", fontSize: size * 0.36 }}>
          +{extra}
        </span>
      )}
    </span>
  );
}

export function Skeleton({ w = "100%", h = 16, r, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) {
  return <span className="skel" style={{ display: "block", width: w, height: h, borderRadius: r, ...style }} aria-hidden />;
}

export function ErrorBox({ error, retry, title = "Could not read the chain" }: { error: unknown; retry?: () => void; title?: string }) {
  return (
    <div className="notice notice-neg" role="alert">
      <div className="between">
        <div>
          <strong>{title}.</strong> <span>{errorText(error)}</span>
        </div>
        {retry && (
          <button className="btn btn-ghost btn-s" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export function NotDeployed() {
  return (
    <div className="card stack-s" style={{ maxWidth: 640 }}>
      <span className="eyebrow">Deployment</span>
      <h2 className="h2">No “{DEPLOYMENT_NAME}” deployment synced yet</h2>
      <p className="muted">
        The app reads its contract addresses from <span className="mono">deployments/{DEPLOYMENT_NAME}.json</span>. Deploy, then run{" "}
        <span className="mono">npm run sync</span> in <span className="mono">app/</span> and reload.
      </p>
    </div>
  );
}

export function RequireDeployment({ children }: { children: ReactNode }) {
  if (!DEPLOYMENT) return <NotDeployed />;
  return <>{children}</>;
}

/** Wall-clock seconds, ticking. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Check({ ok }: { ok: boolean }) {
  return <span className={`check ${ok ? "ok" : "ko"}`}>{ok ? "✓" : "✕"}</span>;
}

export function Bits({ value, n, labels }: { value: number; n: number; labels?: string[] }) {
  return (
    <span className="bits" aria-label={value.toString(2).padStart(n, "0")}>
      {Array.from({ length: n }, (_, i) => n - 1 - i).map((i) => (
        <span key={i} className={`bit${(value >> i) & 1 ? " on" : ""}`} title={labels?.[i] ? `${labels[i]} (bit ${i})` : `bit ${i}`}>
          {(value >> i) & 1}
        </span>
      ))}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}
