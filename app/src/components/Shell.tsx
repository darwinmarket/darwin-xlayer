"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LogoFull } from "./Logo";
import { WalletButton, WalletPicker } from "./Wallet";
import { DEPLOYMENT, IS_LOCAL, RPC_URL, explorerAddress } from "@/lib/deployment";
import { short } from "@/lib/format";
import styles from "./Shell.module.css";

const LINKS = [
  { href: "/", label: "Baskets" },
  { href: "/studio", label: "Studio" },
  { href: "/circuits", label: "Circuits" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/basket") : path.startsWith(href));
  return (
    <header className={styles.header}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.brand} aria-label="Darwin home">
          <LogoFull className={styles.logo} />
          <span className={styles.chain}>on X Layer</span>
        </Link>
        <nav className={`${styles.nav} ${open ? styles.navOpen : ""}`} aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={active(l.href) ? styles.active : undefined} onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className={styles.right}>
          {IS_LOCAL && (
            <span className={styles.net} title={`Reading ${RPC_URL}`}>
              <span className="dot" /> Local fork
            </span>
          )}
          <WalletButton />
          <button className={styles.burger} aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <span />
            <span />
          </button>
        </div>
      </div>
      <WalletPicker />
    </header>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footInner}`}>
        <div className="stack-s">
          <LogoFull style={{ height: 18, width: "auto" }} />
          <p className="small muted" style={{ maxWidth: 420 }}>
            Index baskets of tokenized stocks and crypto on X Layer. Every trade is judged by public TapeOut circuits, in
            the same transaction. Nobody holds your funds: the DEX is the liquidity.
          </p>
        </div>
        {DEPLOYMENT && (
          <dl className={styles.addrs}>
            {(
              [
                ["Router", DEPLOYMENT.router],
                ["Studio", DEPLOYMENT.studio],
                ["Guard", DEPLOYMENT.guard],
                ["Oracle", DEPLOYMENT.oracle],
                ["TapeOut processor", DEPLOYMENT.processor],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  <a className="mono" href={explorerAddress(v)} target="_blank" rel="noreferrer">
                    {short(v)}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </footer>
  );
}
