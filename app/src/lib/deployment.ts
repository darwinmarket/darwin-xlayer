import { defineChain, type Address } from "viem";
import { DEPLOYMENTS } from "@/config/deployments";

/** Which deployment the app reads: NEXT_PUBLIC_DEPLOYMENT=local (anvil fork) or xlayer (mainnet). */
export const DEPLOYMENT_NAME = (process.env.NEXT_PUBLIC_DEPLOYMENT || "local") as "local" | "xlayer" | string;
/** Anything but mainnet is a local fork (local, or a developer's own). */
export const IS_LOCAL = DEPLOYMENT_NAME !== "xlayer";

const file = DEPLOYMENTS[DEPLOYMENT_NAME];

export type Deployment = {
  name: string;
  chainId: number;
  /** Block of the deployment: logs are searched from here. */
  block: bigint;
  processor: Address;
  policyCircuit: bigint;
  breakerCircuit: bigint;
  oracle: Address;
  guard: Address;
  router: Address;
  studio: Address;
  treasury?: Address;
};

/** null when the selected deployment has not been synced into the app yet. */
export const DEPLOYMENT: Deployment | null = file
  ? {
      name: DEPLOYMENT_NAME,
      chainId: file.chainId,
      block: BigInt(file.block ?? 0),
      processor: file.processor,
      policyCircuit: BigInt(file.policyCircuit),
      breakerCircuit: BigInt(file.breakerCircuit),
      oracle: file.oracle,
      guard: file.guard,
      router: file.router,
      studio: file.studio,
      treasury: file.treasury,
    }
  : null;

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || (IS_LOCAL ? "http://127.0.0.1:8546" : "https://rpc.xlayer.tech");

// A production build that would ship a local fork's addresses or RPC is a mistake: refuse it.
if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_ALLOW_LOCAL_BUILD !== "1") {
  if (IS_LOCAL || !file) throw new Error(`production build needs NEXT_PUBLIC_DEPLOYMENT=xlayer and deployments/xlayer.json (got "${DEPLOYMENT_NAME}")`);
  if (/127\.0\.0\.1|localhost/.test(RPC_URL)) throw new Error(`production build with a local RPC: ${RPC_URL}`);
}

/** X Layer mainnet. The local deployment is an anvil fork of it, so it keeps chain id 196. */
export const xLayer = defineChain({
  id: 196,
  name: IS_LOCAL ? "X Layer (local fork)" : "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/xlayer" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const EXPLORER = "https://www.oklink.com/xlayer";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerToken = (a: string, id?: bigint | number) =>
  id === undefined ? `${EXPLORER}/token/${a}` : `${EXPLORER}/token/${a}?tokenID=${id}`;
