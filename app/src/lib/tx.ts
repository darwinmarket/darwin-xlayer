import type { Abi, Address, Hash, TransactionReceipt, WalletClient } from "viem";
import { darwinBasketAbi } from "@/abi/DarwinBasket";
import { darwinGuardAbi } from "@/abi/DarwinGuard";
import { darwinOracleAbi } from "@/abi/DarwinOracle";
import { darwinRouterAbi } from "@/abi/DarwinRouter";
import { darwinStudioAbi } from "@/abi/DarwinStudio";
import { publicClient } from "./client";

/** OpenZeppelin v5 ERC-20 errors, thrown by the basket share and by most tokens. */
const ozErrors = [
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
] as const;

/** Every custom error of Darwin's contracts, so a revert anywhere in a call decodes by name. */
export const errorsAbi = [
  ...ozErrors,
  ...[darwinRouterAbi, darwinGuardAbi, darwinBasketAbi, darwinOracleAbi, darwinStudioAbi].flatMap((a) =>
    (a as Abi).filter((x) => x.type === "error"),
  ),
].filter((e, i, all) => all.findIndex((x) => (x as { name: string }).name === (e as { name: string }).name) === i) as Abi;

export const withErrors = <T extends Abi>(abi: T) => [...abi, ...errorsAbi] as unknown as T;

export type WriteArgs = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

/** Simulate (so reverts surface with their reason before the wallet opens), send, wait. */
export async function send(wallet: WalletClient, w: WriteArgs, onHash?: (h: Hash) => void): Promise<TransactionReceipt> {
  const account = wallet.account!;
  const { request } = await publicClient.simulateContract({
    ...w,
    abi: withErrors(w.abi),
    account,
  } as never);
  // Darwin's calls hold try/catch around oracle reads and give each circuit call a fixed gas
  // budget: a binary-searched estimate can land where an inner call silently runs short, so
  // send with a wide margin (X Layer gas is a fraction of a cent).
  const estimate = await publicClient.estimateContractGas({ ...w, abi: withErrors(w.abi), account } as never);
  const gas = (estimate * 3n) / 2n + 300_000n;
  const hash = await wallet.writeContract({ ...(request as object), gas } as never);
  onHash?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
  if (receipt.status !== "success") throw new Error(`Transaction reverted (${hash})`);
  return receipt;
}
