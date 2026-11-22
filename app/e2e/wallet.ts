import type { Page } from "@playwright/test";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * A test wallet for the browser: an EIP-1193 provider announced through EIP-6963 whose requests
 * are answered in Node, signing with an anvil-funded private key (viem). Read calls go straight to
 * the fork. Only for a local fork: it uses anvil_* cheat codes to fund itself.
 */
export const RPC = process.env.E2E_RPC || "http://127.0.0.1:8546";
const chain = defineChain({
  id: 196,
  name: "X Layer (fork)",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
export const pub = createPublicClient({ chain, transport: http(RPC) });

export function testAccount(seed = "darwin-e2e") {
  return privateKeyToAccount(keccak256(toHex(seed)));
}

/** Give `who` OKB for gas and `amount` of an ERC-20, by finding its balance slot. */
export async function fund(who: Address, token?: Address, amount?: bigint) {
  await pub.request({ method: "anvil_setBalance" as never, params: [who, toHex(10n ** 20n)] as never });
  if (!token || amount === undefined) return;
  const balanceOf = async () =>
    BigInt(
      await pub.call({ to: token, data: (`0x70a08231${pad(who).slice(2)}`) as Hex }).then((r) => r.data ?? "0x0"),
    );
  try {
    await pub.request({ method: "anvil_dealERC20" as never, params: [token, who, toHex(amount)] as never });
    if ((await balanceOf()) >= amount) return;
  } catch {}
  for (let slot = 0n; slot < 200n; slot++) {
    const key = keccak256(`${pad(who)}${pad(toHex(slot)).slice(2)}` as Hex);
    const prev = await pub.getStorageAt({ address: token, slot: key });
    await pub.request({ method: "anvil_setStorageAt" as never, params: [token, key, pad(toHex(amount))] as never });
    if ((await balanceOf()) === amount) return;
    await pub.request({ method: "anvil_setStorageAt" as never, params: [token, key, prev ?? pad("0x0")] as never });
  }
  throw new Error(`no balance slot found for ${token}`);
}

export async function injectWallet(page: Page, seed = "darwin-e2e") {
  const account = testAccount(seed);
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  await page.exposeFunction("__darwinTestRpc", async (method: string, params: unknown[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return toHex(196);
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction": {
        const tx = (params as { to: Address; data?: Hex; value?: Hex; gas?: Hex }[])[0];
        return wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });
      }
      default:
        return pub.request({ method: method as never, params: params as never });
    }
  });
  await page.addInitScript(() => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        try {
          return await (window as unknown as { __darwinTestRpc: (m: string, p: unknown[]) => Promise<unknown> }).__darwinTestRpc(method, params ?? []);
        } catch (e) {
          throw Object.assign(new Error((e as Error).message), { code: -32603 });
        }
      },
      on: (e: string, cb: (...a: unknown[]) => void) => ((listeners[e] ??= []).push(cb), provider),
      removeListener: (e: string, cb: (...a: unknown[]) => void) => {
        listeners[e] = (listeners[e] ?? []).filter((x) => x !== cb);
        return provider;
      },
    };
    const info = {
      uuid: "6f0c4a4e-0000-4000-8000-00000000e2e0",
      name: "Test Wallet",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='8' fill='%23b8892b'/%3E%3C/svg%3E",
      rdns: "market.darwin.test",
    };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  return account;
}
