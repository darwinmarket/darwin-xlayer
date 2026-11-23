"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, numberToHex, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { RPC_URL, xLayer } from "./deployment";

/**
 * Injected wallets through EIP-6963 (every modern wallet announces itself), with OKX Wallet first.
 * No connector library: one provider at a time, its accounts and chain.
 */
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Discovered = { info: WalletInfo; provider: EIP1193Provider };

const OKX_RDNS = "com.okex.wallet";
const STORAGE_KEY = "darwin.wallet";

type Ctx = {
  wallets: Discovered[];
  account: Address | null;
  chainId: number | null;
  active: Discovered | null;
  connecting: boolean;
  error: string | null;
  connect: (w?: Discovered) => Promise<void>;
  disconnect: () => void;
  ensureChain: () => Promise<void>;
  walletClient: () => WalletClient;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
};

const WalletContext = createContext<Ctx | null>(null);

type AnnounceEvent = CustomEvent<{ info: WalletInfo; provider: EIP1193Provider }>;

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isOkxWallet?: boolean; isMetaMask?: boolean };
    okxwallet?: EIP1193Provider;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Discovered[]>([]);
  const [active, setActive] = useState<Discovered | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const walletsRef = useRef<Discovered[]>([]);

  // ---- discovery -------------------------------------------------------------------------------
  useEffect(() => {
    const add = (d: Discovered) => {
      if (walletsRef.current.some((w) => w.info.uuid === d.info.uuid || w.provider === d.provider)) return;
      walletsRef.current = [...walletsRef.current, d].sort(
        (a, b) => Number(b.info.rdns === OKX_RDNS) - Number(a.info.rdns === OKX_RDNS),
      );
      setWallets(walletsRef.current);
    };
    const onAnnounce = (e: Event) => add((e as AnnounceEvent).detail);
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // wallets that predate EIP-6963
    const legacy = setTimeout(() => {
      if (window.okxwallet) add({ info: { uuid: "legacy-okx", name: "OKX Wallet", icon: "", rdns: OKX_RDNS }, provider: window.okxwallet });
      else if (window.ethereum && walletsRef.current.length === 0)
        add({
          info: { uuid: "legacy-injected", name: window.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: "", rdns: "injected" },
          provider: window.ethereum,
        });
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(legacy);
    };
  }, []);

  // ---- events of the active provider ---------------------------------------------------------
  useEffect(() => {
    if (!active) return;
    const p = active.provider as EIP1193Provider & {
      on?: (e: string, cb: (...a: never[]) => void) => void;
      removeListener?: (e: string, cb: (...a: never[]) => void) => void;
    };
    const onAccounts = (accs: string[]) => setAccount(accs[0] ? getAddress(accs[0]) : null);
    const onChain = (id: string) => setChainId(Number(id));
    p.on?.("accountsChanged", onAccounts as never);
    p.on?.("chainChanged", onChain as never);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts as never);
      p.removeListener?.("chainChanged", onChain as never);
    };
  }, [active]);

  const attach = useCallback(async (w: Discovered, request: boolean) => {
    const accs = (await w.provider.request({ method: request ? "eth_requestAccounts" : "eth_accounts" } as never)) as string[];
    if (!accs?.length) return false;
    const id = (await w.provider.request({ method: "eth_chainId" } as never)) as string;
    setActive(w);
    setAccount(getAddress(accs[0]));
    setChainId(Number(id));
    localStorage.setItem(STORAGE_KEY, w.info.rdns);
    return true;
  }, []);

  // reconnect silently to the last wallet
  useEffect(() => {
    if (active) return;
    const last = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!last) return;
    const w = wallets.find((x) => x.info.rdns === last);
    if (w) attach(w, false).catch(() => {});
  }, [wallets, active, attach]);

  const connect = useCallback(
    async (w?: Discovered) => {
      const target = w ?? walletsRef.current[0];
      if (!target) {
        setError("No wallet found. Install OKX Wallet, then reload this page.");
        return;
      }
      setConnecting(true);
      setError(null);
      try {
        await attach(target, true);
        setPickerOpen(false);
      } catch (e) {
        setError((e as Error).message?.split("\n")[0] ?? "Connection failed");
      } finally {
        setConnecting(false);
      }
    },
    [attach],
  );

  const disconnect = useCallback(() => {
    setActive(null);
    setAccount(null);
    setChainId(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const ensureChain = useCallback(async () => {
    if (!active) throw new Error("Connect a wallet first");
    const id = Number((await active.provider.request({ method: "eth_chainId" } as never)) as string);
    if (id === xLayer.id) return;
    const hex = numberToHex(xLayer.id);
    try {
      await active.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] } as never);
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await active.provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: xLayer.name,
            nativeCurrency: xLayer.nativeCurrency,
            // never hand a visitor's wallet a local RPC
            rpcUrls: [/127\.0\.0\.1|localhost/.test(RPC_URL) ? "https://rpc.xlayer.tech" : RPC_URL],
            blockExplorerUrls: ["https://www.oklink.com/xlayer"],
          },
        ],
      } as never);
    }
    const now = Number((await active.provider.request({ method: "eth_chainId" } as never)) as string);
    if (now !== xLayer.id) throw new Error("Switch your wallet to X Layer (chain 196) to continue");
    setChainId(xLayer.id);
  }, [active]);

  const walletClient = useCallback(() => {
    if (!active || !account) throw new Error("Connect a wallet first");
    return createWalletClient({ chain: xLayer, transport: custom(active.provider), account });
  }, [active, account]);

  const value = useMemo<Ctx>(
    () => ({ wallets, account, chainId, active, connecting, error, connect, disconnect, ensureChain, walletClient, pickerOpen, setPickerOpen }),
    [wallets, account, chainId, active, connecting, error, connect, disconnect, ensureChain, walletClient, pickerOpen],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): Ctx {
  const c = useContext(WalletContext);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
