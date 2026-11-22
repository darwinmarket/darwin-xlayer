import { parseEventLogs, type Address, type Hash, type TransactionReceipt } from "viem";
import { darwinRouterAbi } from "@/abi/DarwinRouter";
import { publicClient } from "./client";
import type { BasketInfo, Market } from "./data";
import { DEPLOYMENT } from "./deployment";
import { withErrors } from "./tx";

export const FEE = 0.003;

export type Quote = {
  /** Shares (buy) or pay-token base units (sell). */
  out: bigint;
  /** true: router.buy / router.sell simulated with eth_call from the user's account; false: NAV estimate. */
  simulated: boolean;
  error?: unknown;
};

/** NAV-based estimate: 0.30% fee, no DEX cost. */
export function estimateBuy(b: BasketInfo, pay: Market, amountIn: bigint): bigint {
  const usdIn = (Number(amountIn) / 10 ** pay.decimals) * pay.priceUsd * (1 - FEE);
  const shares = b.supply === 0n ? Math.max(0, usdIn - 1) : usdIn / b.navPerShare;
  return BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
}

export function estimateSell(b: BasketInfo, pay: Market, shares: bigint): bigint {
  const usdOut = (Number(shares) / 1e18) * b.navPerShare * (1 - FEE);
  return BigInt(Math.floor((usdOut / pay.priceUsd) * 10 ** pay.decimals));
}

export async function chainDeadline(minutes = 20): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp + BigInt(minutes * 60);
}

export async function simulateBuy(account: Address, basket: Address, pay: Address, amountIn: bigint): Promise<bigint> {
  const deadline = await chainDeadline();
  const { result } = await publicClient.simulateContract({
    address: DEPLOYMENT!.router,
    abi: withErrors(darwinRouterAbi),
    functionName: "buy",
    args: [basket, pay, amountIn, 0n, deadline, account],
    account,
  });
  return result as bigint;
}

export async function simulateSell(account: Address, basket: Address, shares: bigint, pay: Address): Promise<bigint> {
  const deadline = await chainDeadline();
  const { result } = await publicClient.simulateContract({
    address: DEPLOYMENT!.router,
    abi: withErrors(darwinRouterAbi),
    functionName: "sell",
    args: [basket, shares, pay, 0n, deadline, account],
    account,
  });
  return result as bigint;
}

export const applySlippage = (v: bigint, slippagePct: number) => (v * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

export type LegEvent = {
  basket: Address;
  coin: Address;
  isBuy: boolean;
  amountIn: bigint;
  amountOut: bigint;
  dev: number;
  age: number;
  drift: number;
  better: boolean;
  open: boolean;
  severity: number;
  logIndex: number;
};

export type Bought = { basket: Address; buyer: Address; payToken: Address; amountIn: bigint; shares: bigint; fee: bigint };
export type Sold = { basket: Address; seller: Address; payToken: Address; shares: bigint; amountOut: bigint; fee: bigint };

export function decodeTrade(receipt: TransactionReceipt) {
  const logs = parseEventLogs({ abi: darwinRouterAbi, logs: receipt.logs, strict: false });
  const legs: LegEvent[] = [];
  let bought = null as Bought | null;
  let sold = null as Sold | null;
  for (const l of logs) {
    if (l.address.toLowerCase() !== DEPLOYMENT?.router.toLowerCase()) continue;
    if (l.eventName === "Leg") {
      const a = l.args as Record<string, unknown>;
      legs.push({
        basket: a.basket as Address,
        coin: a.coin as Address,
        isBuy: a.isBuy as boolean,
        amountIn: a.amountIn as bigint,
        amountOut: a.amountOut as bigint,
        dev: Number(a.dev),
        age: Number(a.age),
        drift: Number(a.drift),
        better: a.better as boolean,
        open: a.open as boolean,
        severity: Number(a.severity),
        logIndex: l.logIndex ?? 0,
      });
    } else if (l.eventName === "Bought") bought = l.args as unknown as Bought;
    else if (l.eventName === "Sold") sold = l.args as unknown as Sold;
  }
  return { legs, bought, sold };
}

export type TradeRow = { hash: Hash; block: bigint; kind: "buy" | "sell"; who: Address; payToken: Address; amount: bigint; shares: bigint };

/** Recent buys and sells of a basket (or of everything, or of one account), newest first. */
export async function recentTrades(opts: { basket?: Address; account?: Address; span?: bigint } = {}): Promise<TradeRow[]> {
  const d = DEPLOYMENT!;
  const latest = await publicClient.getBlockNumber();
  const span = opts.span ?? 50_000n;
  const from = latest - span > d.block ? latest - span : d.block;
  const ev = darwinRouterAbi.filter((x) => x.type === "event" && (x.name === "Bought" || x.name === "Sold"));
  const logs = await publicClient.getLogs({ address: d.router, events: ev as never, fromBlock: from, toBlock: latest });
  const rows: TradeRow[] = [];
  for (const l of logs as unknown as { eventName: string; args: Record<string, unknown>; transactionHash: Hash; blockNumber: bigint }[]) {
    const a = l.args;
    if (opts.basket && (a.basket as string).toLowerCase() !== opts.basket.toLowerCase()) continue;
    const who = (l.eventName === "Bought" ? a.buyer : a.seller) as Address;
    if (opts.account && who.toLowerCase() !== opts.account.toLowerCase()) continue;
    rows.push({
      hash: l.transactionHash,
      block: l.blockNumber,
      kind: l.eventName === "Bought" ? "buy" : "sell",
      who,
      payToken: a.payToken as Address,
      amount: (l.eventName === "Bought" ? a.amountIn : a.amountOut) as bigint,
      shares: a.shares as bigint,
    });
  }
  return rows.reverse();
}
