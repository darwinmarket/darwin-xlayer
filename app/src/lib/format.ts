import { formatUnits } from "viem";

export const LOCALE = "en-US";

export const toNum = (v: bigint, decimals = 18) => Number(formatUnits(v, decimals));

export function usd(n: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (opts.compact && Math.abs(n) >= 1e5)
    return `$${n.toLocaleString(LOCALE, { notation: "compact", maximumFractionDigits: 2 })}`;
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return n > 0 ? "<$0.01" : ">-$0.01";
}

export function qty(n: number, max = 6): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return n.toLocaleString(LOCALE, { maximumFractionDigits: 0 });
  if (abs >= 1e3) return n.toLocaleString(LOCALE, { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString(LOCALE, { maximumFractionDigits: 4 });
  if (abs >= 1e-6) return n.toLocaleString(LOCALE, { maximumSignificantDigits: 4, maximumFractionDigits: max + 4 });
  return n > 0 ? "<0.000001" : ">-0.000001";
}

/** A balance truncated (never rounded up) to 4 decimals. */
export function balance(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) < 1e-4) return n > 0 ? "<0.0001" : ">-0.0001";
  return (Math.trunc(n * 1e4) / 1e4).toLocaleString(LOCALE, { maximumFractionDigits: 4 });
}

export const pct = (n: number, digits = 1) => `${(100 * n).toFixed(digits)}%`;
export const bps = (n: bigint | number) => `${(Number(n) / 100).toFixed(Number(n) % 100 === 0 ? 0 : 2)}%`;

export const short = (a: string, n = 4) => `${a.slice(0, 2 + n)}…${a.slice(-n)}`;

export const gas = (n: number) => `${Math.round(n / 100) / 10}k gas`;

export const int = (n: number | bigint) => Number(n).toLocaleString(LOCALE);

const dt = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
export const utc = (seconds: number) => `${dt.format(seconds * 1000)} UTC`;

export function ago(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - seconds);
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Decode a revert into one human sentence. */
export function errorText(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string; args?: unknown[] } } };
  const name = findErrorName(e);
  if (name) {
    const msg = KNOWN_ERRORS[name.name];
    if (msg) return msg(name.args ?? []);
    return `${name.name}${name.args?.length ? `(${name.args.map(String).join(", ")})` : ""}`;
  }
  const s = any?.shortMessage || any?.message || String(e);
  if (/User rejected|denied/i.test(s)) return "Request rejected in the wallet.";
  // Uniswap's own minimum-out check: the router sets it from the oracle, so a route more than 2%
  // (buys) or 3% (sells) from its price stops there, before the circuit even sees it
  if (/Too little received/i.test(s))
    return "A pool on this basket's routes is too far from its oracle price right now (more than 2% on a buy, 3% on a sell): the swap stopped to protect you. Try again in a few minutes, or a smaller amount.";
  return s.split("\n")[0].slice(0, 220);
}

function findErrorName(e: unknown): { name: string; args?: readonly unknown[] } | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const c = cur as { data?: { errorName?: string; args?: readonly unknown[] }; cause?: unknown };
    if (c.data && typeof c.data === "object" && c.data.errorName) return { name: c.data.errorName, args: c.data.args };
    cur = c.cause;
  }
  return null;
}

const SEVERITY = ["clean", "allowed with a warning", "refused", "refused: market broken"];
export const severityLabel = (s: number) => SEVERITY[s] ?? `severity ${s}`;

const KNOWN_ERRORS: Record<string, (args: readonly unknown[]) => string> = {
  BuyingClosed: () => "Buying is closed for this basket: its breaker is tripped. Selling and redeeming stay open.",
  MarketClosed: () =>
    "A stock in this basket has no live price right now (US market closed and its pool not trading steadily near its last price): buying waits. Redeeming in kind stays open.",
  NotABasket: () => "This address is not a basket launched by Darwin's studio.",
  TooManyGates: () => "The methodology circuit is too large (at most 400 gates).",
  Refused: (a) =>
    `The TapeOut trade-policy circuit refused a leg (${severityLabel(Number(a[1]))}, price deviation ${Number(a[2]) * 0.25}%, drift ${a[3]} pp).`,
  Slippage: (a) => `Price moved beyond your slippage limit (got ${a[0]}, minimum ${a[1]}).`,
  Expired: () => "The transaction deadline passed.",
  FirstBuyTooSmall: () => "The first buy of a basket must bring at least $5.",
  NoEligibleCoin: () => "No coin of this basket is eligible for new money right now (markets closed or feeds stale).",
  ZeroAmount: () => "Enter an amount.",
  UnknownPayToken: () => "This token cannot be used to pay.",
  TooSoon: () => "A healthy beat counts once per 15 minutes: this breaker was beaten recently.",
  FeeTooLow: () => "The launch fee sent is too low.",
  BadWeights: () => "The methodology circuit's weights were rejected on chain.",
  BadBand: () => "The methodology circuit's band was rejected on chain.",
  BadCoins: () => "These coins cannot form a basket (1 to 8 distinct listed coins).",
  BadNetlist: () => "The netlist was rejected (NAND gates only, at most 400).",
  ProcessorUpgraded: () => "The TapeOut processor was upgraded: Darwin fails closed until a new guard is deployed.",
  CircuitMismatch: () => "A circuit's netlist does not match the pinned hash.",
  CircuitCallFailed: () => "A circuit call failed.",
  ERC20InsufficientBalance: () => "Insufficient balance.",
  ERC20InsufficientAllowance: () => "Allowance too low: approve first.",
  TimelockActive: () => "The methodology timelock has not passed yet.",
};
