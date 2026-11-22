import type { Address } from "viem";

/** deployments/<name>.json, written by contracts/script/Deploy.s.sol. */
export type DeploymentFile = {
  chainId: number;
  block?: number;
  processor: Address;
  policyCircuit: number | string;
  breakerCircuit: number | string;
  oracle: Address;
  guard: Address;
  router: Address;
  studio: Address;
  treasury?: Address;
  baskets?: (Address | { address: Address; [k: string]: unknown })[];
};
