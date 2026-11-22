"use client";

import type { Address } from "viem";
import { erc20Abi } from "@/abi/ERC20";
import { publicClient } from "./client";
import { loadBasket, loadBaskets, loadMarkets } from "./data";
import { DEPLOYMENT } from "./deployment";
import { useQuery } from "./useQuery";

export const useBaskets = () => useQuery(DEPLOYMENT ? "baskets" : null, loadBaskets, { refreshMs: 20_000, staleMs: 8_000 });
export const useMarkets = () => useQuery(DEPLOYMENT ? "markets" : null, loadMarkets, { refreshMs: 30_000 });

export function useBasket(address: Address | null) {
  return useQuery(
    DEPLOYMENT && address ? `basket:${address.toLowerCase()}` : null,
    async () => {
      const markets = await loadMarkets();
      return { markets, basket: await loadBasket(address!, markets) };
    },
    { refreshMs: 15_000, staleMs: 5_000 },
  );
}

/** Balances and allowances of `owner` for several tokens towards `spender`. */
export function useBalances(owner: Address | null, tokens: Address[], spender?: Address) {
  const key = owner && tokens.length ? `bal:${owner}:${spender ?? ""}:${tokens.join(",")}` : null;
  return useQuery(
    key,
    async () => {
      const r = await publicClient.multicall({
        allowFailure: true,
        contracts: tokens.flatMap((t) => [
          { address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner!] } as const,
          { address: t, abi: erc20Abi, functionName: "allowance", args: [owner!, spender ?? owner!] } as const,
        ]),
      });
      const out: Record<string, { balance: bigint; allowance: bigint }> = {};
      tokens.forEach((t, i) => {
        out[t.toLowerCase()] = {
          balance: r[2 * i].status === "success" ? (r[2 * i].result as bigint) : 0n,
          allowance: r[2 * i + 1].status === "success" ? (r[2 * i + 1].result as bigint) : 0n,
        };
      });
      return out;
    },
    { refreshMs: 15_000, staleMs: 3_000 },
  );
}
