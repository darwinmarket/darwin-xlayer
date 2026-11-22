"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address, type Hash } from "viem";
import { darwinBasketAbi } from "@/abi/DarwinBasket";
import { darwinRouterAbi } from "@/abi/DarwinRouter";
import { erc20Abi } from "@/abi/ERC20";
import type { BasketInfo, Markets } from "@/lib/data";
import { DEPLOYMENT, explorerTx, IS_LOCAL } from "@/lib/deployment";
import { balance, errorText, qty, usd } from "@/lib/format";
import { useBalances } from "@/lib/hooks";
import { countdown, nextChange, usOpen, utcMoment } from "@/lib/session";
import {
  applySlippage,
  chainDeadline,
  estimateBuy,
  estimateSell,
  FEE,
  simulateBuy,
  simulateSell,
  type Quote,
} from "@/lib/trade";
import { send } from "@/lib/tx";
import { invalidate } from "@/lib/useQuery";
import { useWallet } from "@/lib/wallet";
import { useChainNow } from "./Status";
import { AssetLogo } from "./ui";

const PAY_SYMBOLS = ["USDG", "USDC", "USD₮0", "USDT0"];
type Step = { label: string; hash?: Hash; done?: boolean };

export function TradePanel({ b, markets, onTraded }: { b: BasketInfo; markets: Markets; onTraded?: () => void }) {
  const w = useWallet();
  const router = DEPLOYMENT!.router;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const payTokens = useMemo(
    () => markets.list.filter((m) => m.meta.kind === "stable" && PAY_SYMBOLS.includes(m.symbol)),
    [markets.list],
  );
  const [payAddr, setPayAddr] = useState<Address | null>(null);
  const pay = payTokens.find((m) => m.address === payAddr) ?? payTokens[0];
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: Hash; kind: "buy" | "sell" | "redeem" } | null>(null);

  const bal = useBalances(w.account, pay ? [pay.address, b.address] : [b.address], router);
  const payBal = pay ? bal.data?.[pay.address.toLowerCase()] : undefined;
  const shareBal = bal.data?.[b.address.toLowerCase()];

  const decimals = side === "buy" ? (pay?.decimals ?? 6) : 18;
  const parsed = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? parseUnits(amount as `${number}`, decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, decimals]);

  // ---- market states -------------------------------------------------------------------------
  const t = useChainNow(markets.chainTime);
  const stocksClosed = b.hasStocks && !usOpen(t);
  const allStocks = b.kind === "stocks";
  const tripped = b.breaker.tripped || !!b.preview?.tripped || !b.buyOpen;
  const noEligible = b.holdings.every((h) => !h.eligible);
  const buyBlocked = tripped || noEligible;
  const sellBlocked = stocksClosed; // a closed stock cannot be sold on its pool: the policy refuses it

  // ---- quote ---------------------------------------------------------------------------------
  useEffect(() => {
    setQuote(null);
    if (!pay || parsed === 0n) return;
    const est = side === "buy" ? estimateBuy(b, pay, parsed) : estimateSell(b, pay, parsed);
    setQuote({ out: est, simulated: false });
    const allowance = side === "buy" ? payBal?.allowance : shareBal?.allowance;
    const have = side === "buy" ? payBal?.balance : shareBal?.balance;
    if (!w.account || allowance === undefined || have === undefined || allowance < parsed || have < parsed) return;
    if (side === "buy" && buyBlocked) return;
    let stale = false;
    setQuoting(true);
    const id = setTimeout(async () => {
      try {
        const out =
          side === "buy" ? await simulateBuy(w.account!, b.address, pay.address, parsed) : await simulateSell(w.account!, b.address, parsed, pay.address);
        if (!stale) setQuote({ out, simulated: true });
      } catch (e) {
        if (!stale) setQuote({ out: est, simulated: false, error: e });
      } finally {
        if (!stale) setQuoting(false);
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(id);
      setQuoting(false);
    };
  }, [side, pay, parsed, b, w.account, payBal?.allowance, payBal?.balance, shareBal?.allowance, shareBal?.balance, buyBlocked]);

  const needsApproval =
    !!w.account && parsed > 0n && (side === "buy" ? (payBal?.allowance ?? 0n) < parsed : (shareBal?.allowance ?? 0n) < parsed);
  const insufficient = !!w.account && parsed > 0n && (side === "buy" ? (payBal?.balance ?? 0n) < parsed : (shareBal?.balance ?? 0n) < parsed);

  const refresh = () => {
    bal.refresh();
    invalidate(`basket:${b.address.toLowerCase()}`);
    invalidate("baskets");
    onTraded?.();
  };

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await w.ensureChain();
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const approve = () =>
    run("approve", async () => {
      const token = side === "buy" ? pay!.address : b.address;
      setSteps([{ label: `Approve ${side === "buy" ? pay!.symbol : b.symbol}` }]);
      await send(w.walletClient(), { address: token, abi: erc20Abi, functionName: "approve", args: [router, parsed] }, (h) =>
        setSteps([{ label: `Approve ${side === "buy" ? pay!.symbol : b.symbol}`, hash: h }]),
      );
      setSteps((s) => s.map((x) => ({ ...x, done: true })));
      bal.refresh();
    });

  const trade = () =>
    run("trade", async () => {
      const deadline = await chainDeadline();
      const min = quote ? applySlippage(quote.out, slippage) : 0n;
      const label = side === "buy" ? `Buy ${b.symbol}` : `Sell ${b.symbol}`;
      setSteps([{ label }]);
      const receipt = await send(
        w.walletClient(),
        side === "buy"
          ? { address: router, abi: darwinRouterAbi, functionName: "buy", args: [b.address, pay!.address, parsed, min, deadline, w.account!] }
          : { address: router, abi: darwinRouterAbi, functionName: "sell", args: [b.address, parsed, pay!.address, min, deadline, w.account!] },
        (h) => setSteps([{ label, hash: h }]),
      );
      setSteps([{ label, hash: receipt.transactionHash, done: true }]);
      setDone({ hash: receipt.transactionHash, kind: side });
      setAmount("");
      refresh();
    });

  const redeem = () =>
    run("redeem", async () => {
      const shares = parsed > 0n && side === "sell" ? parsed : (shareBal?.balance ?? 0n);
      if (shares === 0n) throw new Error("No shares to redeem");
      setSteps([{ label: "Redeem in kind" }]);
      const receipt = await send(
        w.walletClient(),
        { address: b.address, abi: darwinBasketAbi, functionName: "redeem", args: [shares, w.account!] },
        (h) => setSteps([{ label: "Redeem in kind", hash: h }]),
      );
      setDone({ hash: receipt.transactionHash, kind: "redeem" });
      setAmount("");
      refresh();
    });

  const outLabel =
    quote && pay
      ? side === "buy"
        ? `${qty(Number(formatUnits(quote.out, 18)))} ${b.symbol}`
        : `${qty(Number(formatUnits(quote.out, pay.decimals)))} ${pay.symbol}`
      : "—";
  const outUsd = quote && pay ? (side === "buy" ? (Number(quote.out) / 1e18) * b.navPerShare : (Number(quote.out) / 10 ** pay.decimals) * pay.priceUsd) : 0;
  const inUsd = pay ? (side === "buy" ? (Number(parsed) / 10 ** pay.decimals) * pay.priceUsd : (Number(parsed) / 1e18) * b.navPerShare) : 0;
  const reopen = nextChange(t);

  return (
    <div className="card stack" data-testid="trade-panel">
      <div className="between">
        <div className="seg" role="group" aria-label="Side">
          <button aria-pressed={side === "buy"} onClick={() => (setSide("buy"), setAmount(""), setDone(null))}>
            Buy
          </button>
          <button aria-pressed={side === "sell"} onClick={() => (setSide("sell"), setAmount(""), setDone(null))}>
            Sell
          </button>
        </div>
        <span className="xsmall muted">Fee 0.30%</span>
      </div>

      {side === "buy" && tripped && (
        <div className="notice notice-neg" data-testid="state-tripped">
          <strong>Breaker tripped — sell only.</strong>{" "}
          {b.breaker.tripped
            ? "The market-risk circuit closed buying for this basket. It reopens by itself after eight healthy beats; selling and redeeming stay open."
            : "The market-risk circuit sees an unhealthy market now (see the breaker facts below): its next beat trips the basket, so buying is closed. Selling and redeeming stay open."}
        </div>
      )}
      {side === "buy" && stocksClosed && allStocks && (
        <div className="notice notice-warn" data-testid="state-closed">
          <strong>US market closed — buys reopen Monday 01:00 UTC</strong> (in {countdown(reopen - t)}). xStocks follow the US equities 24/5
          session.
        </div>
      )}
      {side === "buy" && !tripped && stocksClosed && !allStocks && !noEligible && (
        <div className="notice notice-info">
          <strong>US market closed.</strong> New money goes to the coins that trade now; the stocks catch up when the session reopens.
        </div>
      )}
      {side === "buy" && !tripped && noEligible && !(stocksClosed && allStocks) && (
        <div className="notice notice-warn">
          <strong>No coin is eligible for new money right now</strong> (stale feeds or pools away from their oracle).
        </div>
      )}
      {side === "sell" && sellBlocked && (
        <div className="notice notice-warn" data-testid="state-closed-sell">
          <strong>US market closed until {utcMoment(reopen)}.</strong> Stock pools cannot be sold into while the session is closed. You can
          always redeem in kind: your shares become the underlying xStocks, pro rata.
        </div>
      )}

      <div className="amount-box">
        <div className="between xsmall muted">
          <span>{side === "buy" ? "You pay" : "You sell"}</span>
          {w.account && (
            <button
              className="link xsmall"
              onClick={() => {
                const v = side === "buy" ? payBal?.balance : shareBal?.balance;
                if (v !== undefined) setAmount(formatUnits(v, decimals));
              }}
            >
              Balance {side === "buy" ? balance(Number(formatUnits(payBal?.balance ?? 0n, decimals))) : balance(Number(formatUnits(shareBal?.balance ?? 0n, 18)))}{" "}
              · Max
            </button>
          )}
        </div>
        <div className="row" style={{ marginTop: 4 }}>
          <input
            className="input input-big num"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              const v = e.target.value.replace(",", ".");
              if (/^\d*\.?\d*$/.test(v)) setAmount(v);
              setDone(null);
            }}
            aria-label="Amount"
            data-testid="amount"
          />
          {side === "buy" ? (
            <PaySelect payTokens={payTokens} value={pay?.address} onChange={setPayAddr} />
          ) : (
            <span className="tag" style={{ height: 32, fontSize: 13 }}>
              {b.symbol}
            </span>
          )}
        </div>
        <div className="xsmall muted num">{inUsd > 0 ? `≈ ${usd(inUsd)}` : " "}</div>
      </div>

      <div className="amount-box" style={{ background: "var(--card-2)" }}>
        <div className="between xsmall muted">
          <span>You receive</span>
          {side === "sell" && <PaySelect payTokens={payTokens} value={pay?.address} onChange={setPayAddr} small />}
        </div>
        <div className="between" style={{ marginTop: 6 }}>
          <strong className="num" style={{ fontSize: 20, letterSpacing: "-0.02em" }} data-testid="quote">
            {quoting ? <span className="spin" /> : outLabel}
          </strong>
          {quote && <span className="xsmall muted num">≈ {usd(outUsd)}</span>}
        </div>
        {quote && (
          <div className="xsmall" style={{ marginTop: 6 }}>
            {quote.simulated ? (
              <span className="pos">● Simulated on chain: router.{side}() via eth_call, every circuit verdict included</span>
            ) : quote.error ? (
              <span className="neg">Simulation reverted: {errorText(quote.error)}</span>
            ) : (
              <span className="muted">Estimate from NAV less 0.30%. {w.account ? "Approve to simulate the exact trade." : "Connect to simulate the exact trade."}</span>
            )}
          </div>
        )}
      </div>

      <div className="between small">
        <span className="muted">Slippage limit</span>
        <div className="seg">
          {[0.5, 1, 2].map((s) => (
            <button key={s} aria-pressed={slippage === s} onClick={() => setSlippage(s)} style={{ height: 26, padding: "0 10px" }}>
              {s}%
            </button>
          ))}
        </div>
      </div>
      {quote && (
        <dl className="kv xsmall">
          <dt>{side === "buy" ? "Minimum shares" : "Minimum out"}</dt>
          <dd className="num">
            {side === "buy"
              ? qty(Number(formatUnits(applySlippage(quote.out, slippage), 18)))
              : qty(Number(formatUnits(applySlippage(quote.out, slippage), pay?.decimals ?? 6)))}
          </dd>
          <dt>Protocol fee</dt>
          <dd className="num">{usd(inUsd * FEE)} (a third to the strategy&apos;s creator)</dd>
        </dl>
      )}

      {!w.account ? (
        <button className="btn btn-l btn-block" onClick={() => w.setPickerOpen(true)}>
          Connect wallet
        </button>
      ) : side === "buy" && buyBlocked ? (
        <button className="btn btn-l btn-block" disabled>
          {tripped ? "Buying closed" : stocksClosed ? "Market closed" : "No eligible coin"}
        </button>
      ) : parsed === 0n ? (
        <button className="btn btn-l btn-block" disabled>
          Enter an amount
        </button>
      ) : insufficient ? (
        <button className="btn btn-l btn-block" disabled>
          Insufficient {side === "buy" ? pay?.symbol : b.symbol}
        </button>
      ) : needsApproval ? (
        <button className="btn btn-l btn-block btn-gold" onClick={approve} disabled={!!busy} data-testid="approve">
          {busy === "approve" && <span className="spin" />} Approve {side === "buy" ? pay?.symbol : b.symbol}
        </button>
      ) : (
        <button
          className="btn btn-l btn-block btn-gold"
          onClick={trade}
          disabled={!!busy || quoting || (side === "sell" && sellBlocked) || !!quote?.error}
          data-testid="submit"
        >
          {busy === "trade" && <span className="spin" />}
          {side === "buy" ? `Buy ${b.symbol}` : `Sell for ${pay?.symbol}`}
        </button>
      )}

      {w.account && (shareBal?.balance ?? 0n) > 0n && (side === "sell" || tripped) && (
        <button className="btn btn-ghost btn-block" onClick={redeem} disabled={!!busy} data-testid="redeem">
          {busy === "redeem" && <span className="spin" />}
          Redeem in kind{side === "sell" && parsed > 0n ? "" : " (all shares)"}
        </button>
      )}

      {steps.length > 0 && busy && (
        <div className="notice notice-info small">
          {steps.map((s) => (
            <div key={s.label} className="row">
              {s.done ? "✓" : <span className="spin" />} {s.label}
              {s.hash ? <span className="mono xsmall muted">{s.hash.slice(0, 10)}…</span> : <span className="muted">confirm in your wallet</span>}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="notice notice-neg small" role="alert" data-testid="trade-error">
          {error}
        </div>
      )}
      {done && (
        <div className="notice notice-pos small" data-testid="trade-done">
          <strong>{done.kind === "buy" ? "Bought." : done.kind === "sell" ? "Sold." : "Redeemed in kind."}</strong>{" "}
          {done.kind !== "redeem" ? (
            <>
              Every leg was judged by the TapeOut trade-policy circuit.{" "}
              <Link className="link" href={`/tx/${done.hash}`} data-testid="proof-link">
                See the proof →
              </Link>
            </>
          ) : (
            <>The coins are in your wallet.</>
          )}
          {!IS_LOCAL && (
            <>
              {" "}
              <a className="link" href={explorerTx(done.hash)} target="_blank" rel="noreferrer">
                OKLink
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PaySelect({
  payTokens,
  value,
  onChange,
  small,
}: {
  payTokens: Markets["list"];
  value?: Address;
  onChange: (a: Address) => void;
  small?: boolean;
}) {
  const cur = payTokens.find((p) => p.address === value);
  return (
    <span className="row" style={{ gap: 6 }}>
      {cur && !small && <AssetLogo meta={cur.meta} size={22} />}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as Address)} aria-label="Pay token" data-testid="pay-token">
        {payTokens.map((p) => (
          <option key={p.address} value={p.address}>
            {p.symbol}
          </option>
        ))}
      </select>
    </span>
  );
}
