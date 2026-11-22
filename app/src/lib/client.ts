import { createPublicClient, http, type PublicClient } from "viem";
import { RPC_URL, xLayer } from "./deployment";

/** One read client for the whole app: JSON-RPC batching plus Multicall3 for contract reads. */
export const publicClient: PublicClient = createPublicClient({
  chain: xLayer,
  transport: http(RPC_URL, { batch: { batchSize: 50, wait: 8 }, retryCount: 2 }),
  batch: { multicall: { wait: 8 } },
}) as PublicClient;
