import type { Address } from "viem";
import { darwinBasketAbi } from "@/abi/DarwinBasket";
import { darwinGuardAbi } from "@/abi/DarwinGuard";
import { darwinOracleAbi } from "@/abi/DarwinOracle";
import { darwinRouterAbi } from "@/abi/DarwinRouter";
import { darwinStudioAbi } from "@/abi/DarwinStudio";
import { erc20Abi } from "@/abi/ERC20";
import { assetMeta, basketKind, type AssetMeta } from "./assets";
import { publicClient } from "./client";
import { DEPLOYMENT, type Deployment } from "./deployment";

export type Market = {
  address: Address;
  symbol: string;
  decimals: number;
  session: number;
  meta: AssetMeta;
  /** USD per whole token (Chainlink, 18 decimals). */
  price: bigint;
  priceUsd: number;
  updatedAt: number;
  ageClass: number;
  open: boolean;
  /** A stock priced by its own pool's 1-hour TWAP while its Chainlink feed is frozen. */
  poolPriced: boolean;
  /** Has a live price (in session, or pool-priced): it can be bought and sold. */
  tradable: boolean;
};

export type Markets = { list: Market[]; byAddress: Map<string, Market>; chainTime: number; block: bigint; sequencerUp: boolean };

const ZERO = "0x0000000000000000000000000000000000000000";

const D = (): Deployment => {
  if (!DEPLOYMENT) throw new Error("No deployment configured");
  return DEPLOYMENT;
};

export async function loadMarkets(): Promise<Markets> {
  const d = D();
  const [tokens, block, sequencerUp] = await Promise.all([
    publicClient.readContract({ address: d.oracle, abi: darwinOracleAbi, functionName: "allTokens" }),
    publicClient.getBlock(),
    publicClient.readContract({ address: d.oracle, abi: darwinOracleAbi, functionName: "sequencerUp" }).catch(() => false),
  ]);
  const per = await Promise.all(
    tokens.map(async (t) => {
      const [symbol, decimals, market, price, age, open, poolPriced, tradable] = await publicClient.multicall({
        allowFailure: true,
        contracts: [
          { address: t, abi: erc20Abi, functionName: "symbol" },
          { address: t, abi: erc20Abi, functionName: "decimals" },
          { address: d.oracle, abi: darwinOracleAbi, functionName: "market", args: [t] },
          { address: d.oracle, abi: darwinOracleAbi, functionName: "price", args: [t] },
          { address: d.oracle, abi: darwinOracleAbi, functionName: "ageClass", args: [t] },
          { address: d.oracle, abi: darwinOracleAbi, functionName: "sessionOpen", args: [t] },
          { address: d.oracle, abi: darwinOracleAbi, functionName: "poolPriced", args: [t] },
          { address: d.oracle, abi: darwinOracleAbi, functionName: "tradable", args: [t] },
        ],
      });
      const sym = symbol.status === "success" ? symbol.result : t.slice(0, 8);
      const session = market.status === "success" ? Number(market.result.session) : 0;
      const p = price.status === "success" ? price.result[0] : 0n;
      const m: Market = {
        address: t,
        symbol: sym,
        // never guess decimals (a wrong guess turns into a 10^12x approval): -1 marks it unusable
        decimals: decimals.status === "success" ? Number(decimals.result) : -1,
        session,
        meta: assetMeta(sym, session),
        price: p,
        priceUsd: Number(p) / 1e18,
        updatedAt: price.status === "success" ? Number(price.result[1]) : 0,
        ageClass: age.status === "success" ? Number(age.result) : 3,
        open: open.status === "success" ? open.result : false,
        poolPriced: poolPriced.status === "success" ? poolPriced.result : false,
        tradable: tradable.status === "success" ? tradable.result : false,
      };
      return m;
    }),
  );
  return {
    list: per,
    byAddress: new Map(per.map((m) => [m.address.toLowerCase(), m])),
    chainTime: Number(block.timestamp),
    block: block.number,
    sequencerUp,
  };
}

export type Holding = {
  coin: Address;
  market?: Market;
  symbol: string;
  meta: AssetMeta;
  balance: bigint;
  valueUsd: number;
  /** Actual weight, 0..1 of NAV. */
  weight: number;
  /** Target weight from the methodology circuit, 0..1 (0 if ineligible now). */
  target: number;
  eligible: boolean;
};

export type BasketInfo = {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
  nav: bigint;
  navUsd: number;
  /** USD per share (18-decimal shares). */
  navPerShare: number;
  band: number;
  creator: Address;
  owner: Address;
  methodologyId: bigint;
  methodologyHash: `0x${string}`;
  pendingEta: number;
  /** Launched by Darwin's studio (studio.isBasket). A page for any other address must not trade. */
  genuine: boolean;
  /** Launched by Darwin itself rather than by a community creator. */
  official: boolean;
  holdings: Holding[];
  kind: "stocks" | "crypto" | "mixed";
  breaker: { state: number; tripped: boolean; counter: number; lastBeat: number };
  preview: { next: number; tripped: boolean; facts: number } | null;
  buyOpen: boolean;
  /** Some coin is a US stock. */
  hasStocks: boolean;
  /** A held coin without a live price (router.closedHolding): no buy until it has one. */
  closedHolding: Address | null;
};

export async function loadBasketAddresses(): Promise<Address[]> {
  const d = D();
  const list = await publicClient.readContract({ address: d.studio, abi: darwinStudioAbi, functionName: "allBaskets" });
  return [...list];
}

export async function loadBasket(address: Address, markets: Markets): Promise<BasketInfo> {
  const d = D();
  const b = { address, abi: darwinBasketAbi } as const;
  const g = { address: d.guard, abi: darwinGuardAbi } as const;
  const r = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { ...b, functionName: "name" },
      { ...b, functionName: "symbol" },
      { ...b, functionName: "totalSupply" },
      { ...b, functionName: "nav" },
      { ...b, functionName: "coinList" },
      { ...b, functionName: "balances" },
      { ...b, functionName: "targets" },
      { ...b, functionName: "creator" },
      { ...b, functionName: "owner" },
      { ...b, functionName: "methodologyId" },
      { ...b, functionName: "methodologyHash" },
      { ...b, functionName: "pendingEta" },
      { ...g, functionName: "breakers", args: [address] },
      { ...g, functionName: "preview", args: [address] },
      { ...g, functionName: "buyOpen", args: [address] },
      { address: d.studio, abi: darwinStudioAbi, functionName: "isBasket", args: [address] },
      { address: d.router, abi: darwinRouterAbi, functionName: "closedHolding", args: [address] },
    ],
  });
  const ok = <T,>(x: { status: string; result?: unknown }, fallback: T): T => (x.status === "success" ? (x.result as T) : fallback);
  const coins = ok<readonly Address[]>(r[4], []);
  const balances = ok<readonly bigint[]>(r[5], []);
  const [targetBps, band] = ok<readonly [readonly bigint[], number]>(r[6], [[], 0]);
  const values = await publicClient.multicall({
    allowFailure: true,
    contracts: coins.flatMap((c, i) => [
      { address: d.oracle, abi: darwinOracleAbi, functionName: "value", args: [c, balances[i] ?? 0n] } as const,
      { address: d.guard, abi: darwinGuardAbi, functionName: "eligible", args: [c] } as const,
    ]),
  });
  const nav = ok<bigint>(r[3], 0n);
  const navUsd = Number(nav) / 1e18;
  const supply = ok<bigint>(r[2], 0n);
  const holdings: Holding[] = coins.map((c, i) => {
    const m = markets.byAddress.get(c.toLowerCase());
    const v = values[2 * i]?.status === "success" ? (values[2 * i].result as bigint) : 0n;
    const valueUsd = Number(v) / 1e18;
    return {
      coin: c,
      market: m,
      symbol: m?.symbol ?? c.slice(0, 8),
      meta: m?.meta ?? assetMeta(c.slice(0, 8)),
      balance: balances[i] ?? 0n,
      valueUsd,
      weight: navUsd > 0 ? valueUsd / navUsd : 0,
      target: Number(targetBps[i] ?? 0n) / 10_000,
      eligible: values[2 * i + 1]?.status === "success" ? (values[2 * i + 1].result as boolean) : false,
    };
  });
  const [state, lastBeat] = ok<readonly [number, bigint]>(r[12], [0, 0n]);
  const pv = r[13].status === "success" ? (r[13].result as readonly [number, boolean, number]) : null;
  return {
    address,
    name: ok(r[0], "Basket"),
    symbol: ok(r[1], "?"),
    decimals: 18,
    supply,
    nav,
    navUsd,
    navPerShare: supply > 0n ? navUsd / (Number(supply) / 1e18) : 1,
    band: Number(band),
    creator: ok(r[7], "0x0000000000000000000000000000000000000000"),
    owner: ok(r[8], "0x0000000000000000000000000000000000000000"),
    methodologyId: ok(r[9], 0n),
    methodologyHash: ok(r[10], "0x"),
    pendingEta: Number(ok(r[11], 0n)),
    holdings,
    kind: basketKind(holdings.map((h) => h.meta.kind)),
    breaker: { state: Number(state), tripped: (Number(state) & 1) === 1, counter: (Number(state) >> 1) & 7, lastBeat: Number(lastBeat) },
    preview: pv ? { next: Number(pv[0]), tripped: pv[1], facts: Number(pv[2]) } : null,
    buyOpen: ok(r[14], false),
    // launched by Darwin's studio: anything else at this address is not a Darwin basket
    genuine: ok(r[15], false),
    // official = launched by the deployment's treasury (Darwin); anyone else's is a community strategy
    official: Boolean(d.treasury) && ok<string>(r[7], "").toLowerCase() === (d.treasury ?? "").toLowerCase(),
    hasStocks: holdings.some((h) => h.meta.kind === "stock"),
    closedHolding: (() => {
      const c = ok<string>(r[16], ZERO);
      return c.toLowerCase() === ZERO ? null : (c as Address);
    })(),
  };
}

export async function loadBaskets(): Promise<{ markets: Markets; baskets: BasketInfo[] }> {
  const [markets, addresses] = await Promise.all([loadMarkets(), loadBasketAddresses()]);
  const baskets = await Promise.all(addresses.map((a) => loadBasket(a, markets)));
  return { markets, baskets };
}

/** The five breaker facts, as the guard packs them (DarwinGuard.facts). */
export const FACTS = [
  { bit: 0, label: "Feeds alive", hint: "the quote's feed under an hour old, every crypto feed within heartbeat + grace (a stock's resting feed is not an incident)" },
  { bit: 1, label: "Sequencer up", hint: "X Layer's sequencer is up and past its grace period (Chainlink uptime feed)" },
  { bit: 2, label: "Quote on peg", hint: "USDG within 1% of $1 by its Chainlink feed" },
  { bit: 3, label: "Pools on oracle", hint: "no pool more than 10% away from its oracle (30-minute TWAP)" },
  { bit: 4, label: "Reserves backed", hint: "every wrapped coin at least 99.5% backed (xBTC/BTC)" },
] as const;
