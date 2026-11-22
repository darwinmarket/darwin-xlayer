"use client";

import { useEffect, useRef, useState } from "react";
import { xLayer } from "@/lib/deployment";
import { short } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

export function WalletButton() {
  const w = useWallet();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  if (!w.account) {
    return (
      <button className="btn btn-s" onClick={() => w.setPickerOpen(true)} data-testid="connect">
        {w.connecting ? <span className="spin" /> : null}
        Connect wallet
      </button>
    );
  }
  const wrong = w.chainId !== xLayer.id;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {wrong ? (
        <button className="btn btn-s btn-gold" onClick={() => w.ensureChain().catch(() => {})}>
          Switch to X Layer
        </button>
      ) : (
        <button className="btn btn-ghost btn-s" onClick={() => setMenu((v) => !v)} data-testid="account">
          {w.active?.info.icon ? (
            // eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs
            <img src={w.active.info.icon} alt="" width={16} height={16} style={{ borderRadius: 4 }} />
          ) : (
            <span className="dot" style={{ color: "var(--pos)" }} />
          )}
          <span className="mono">{short(w.account)}</span>
        </button>
      )}
      {menu && (
        <div
          className="card"
          style={{ position: "absolute", right: 0, top: 40, width: 240, padding: 10, zIndex: 60 }}
          role="menu"
        >
          <div className="xsmall muted" style={{ padding: "4px 6px" }}>
            {w.active?.info.name}
          </div>
          <a className="wallet-row" style={{ border: 0 }} href="/portfolio" role="menuitem">
            Portfolio
          </a>
          <button
            className="wallet-row"
            style={{ border: 0 }}
            role="menuitem"
            onClick={() => {
              navigator.clipboard?.writeText(w.account!).catch(() => {});
              setMenu(false);
            }}
          >
            Copy address
          </button>
          <button
            className="wallet-row"
            style={{ border: 0, color: "var(--neg)" }}
            role="menuitem"
            onClick={() => {
              w.disconnect();
              setMenu(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function WalletPicker() {
  const w = useWallet();
  if (!w.pickerOpen) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && w.setPickerOpen(false)} role="dialog" aria-modal aria-label="Connect a wallet">
      <div className="modal stack">
        <div className="between">
          <h2 className="h3">Connect a wallet</h2>
          <button className="btn btn-ghost btn-s" onClick={() => w.setPickerOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="small muted">Darwin works with OKX Wallet first, and with any browser wallet on X Layer.</p>
        <div className="stack-s">
          {w.wallets.length === 0 && (
            <div className="notice notice-info">
              No wallet detected in this browser.{" "}
              <a className="link" href="https://web3.okx.com/download" target="_blank" rel="noreferrer">
                Install OKX Wallet
              </a>
              , then reload.
            </div>
          )}
          {w.wallets.map((d) => (
            <button key={d.info.uuid} className="wallet-row" onClick={() => w.connect(d)} disabled={w.connecting} data-testid={`wallet-${d.info.rdns}`}>
              {d.info.icon ? (
                // eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs
                <img src={d.info.icon} alt="" />
              ) : (
                <span className="logo" style={{ width: 28, height: 28, borderRadius: 8, background: "var(--ink)" }}>
                  {d.info.name.slice(0, 1)}
                </span>
              )}
              <span style={{ flex: 1 }}>
                <strong style={{ display: "block", fontSize: 14 }}>{d.info.name}</strong>
                {d.info.rdns === "com.okex.wallet" && <span className="xsmall gold">Recommended on X Layer</span>}
              </span>
              {w.connecting && <span className="spin" />}
            </button>
          ))}
        </div>
        {w.error && <div className="notice notice-neg">{w.error}</div>}
      </div>
    </div>
  );
}
