import { createPublicClient, http, type PublicClient } from "viem";
import { RPC_URL, xLayer } from "./deployment";

/**
 * One read client for the whole app: Multicall3 for contract reads, plus JSON-RPC batching of at
 * most 10 calls (X Layer's public RPC refuses larger batches with -32014).
 */
export const publicClient: PublicClient = createPublicClient({
  chain: xLayer,
  transport: http(RPC_URL, { batch: { batchSize: 10, wait: 8 }, retryCount: 2 }),
  batch: { multicall: { wait: 8 } },
}) as PublicClient;
