/** What Darwin knows about each market beyond the chain: display ticker, company name, kind, colour. */
export type AssetKind = "stock" | "crypto" | "stable";

export type AssetMeta = {
  /** The on-chain symbol (wNVDAx). */
  symbol: string;
  /** What it tracks (NVDA). */
  ticker: string;
  name: string;
  kind: AssetKind;
  color: string;
  /** /logos/<file>, when we ship a logo; otherwise a monogram in `color`. */
  logo?: string;
};

const A = (symbol: string, ticker: string, name: string, kind: AssetKind, color: string, logo?: string): AssetMeta => ({
  symbol,
  ticker,
  name,
  kind,
  color,
  logo,
});

const LIST: AssetMeta[] = [
  A("USDG", "USDG", "Global Dollar (Paxos)", "stable", "#1f6f5c", "USDG.png"),
  A("USD₮0", "USDT0", "Tether USD₮0", "stable", "#26a17b"),
  A("USDT0", "USDT0", "Tether USD₮0", "stable", "#26a17b"),
  A("USDC", "USDC", "USD Coin", "stable", "#2775ca", "USDC.svg"),
  A("xBTC", "BTC", "Bitcoin (OKX wrapped)", "crypto", "#f7931a", "BTC.png"),
  A("xETH", "ETH", "Ether (OKX wrapped)", "crypto", "#627eea", "ETH.png"),
  A("xSOL", "SOL", "Solana (OKX wrapped)", "crypto", "#9945ff"),
  A("WOKB", "OKB", "OKB (wrapped)", "crypto", "#111111"),
  A("wNVDAx", "NVDA", "NVIDIA", "stock", "#76b900", "NVDA.png"),
  A("wSPYx", "SPY", "S&P 500 ETF", "stock", "#1f36ff"),
  A("wQQQx", "QQQ", "Nasdaq-100 ETF", "stock", "#2b2bd0"),
  A("wTSLAx", "TSLA", "Tesla", "stock", "#e82127", "TSLA.png"),
  A("wSPCXx", "SPCX", "SpaceX", "stock", "#0b3550"),
  A("wAAPLx", "AAPL", "Apple", "stock", "#1d1d1f", "AAPL.png"),
  A("wGOOGLx", "GOOGL", "Alphabet", "stock", "#3086ff", "GOOGL.png"),
  A("wCRCLx", "CRCL", "Circle", "stock", "#3d5afe"),
  A("wMSTRx", "MSTR", "Strategy (MicroStrategy)", "stock", "#fa660f"),
];

const BY_SYMBOL = new Map(LIST.map((a) => [a.symbol.toLowerCase(), a]));

export function assetMeta(symbol: string, session?: number): AssetMeta {
  const known = BY_SYMBOL.get(symbol.toLowerCase());
  if (known) return known;
  // an unknown market: infer from its session and its name
  const isStock = session === 1 || /^w.+x$/.test(symbol);
  const ticker = isStock ? symbol.replace(/^w/, "").replace(/x$/, "") : symbol;
  return { symbol, ticker, name: symbol, kind: isStock ? "stock" : /usd/i.test(symbol) ? "stable" : "crypto", color: "#8a7a5a" };
}

export const KIND_LABEL: Record<AssetKind, string> = { stock: "Stocks", crypto: "Crypto", stable: "Stablecoins" };

/** A basket's tag from what it holds. */
export function basketKind(kinds: AssetKind[]): "stocks" | "crypto" | "mixed" {
  const stocks = kinds.filter((k) => k === "stock").length;
  if (stocks === kinds.length) return "stocks";
  if (stocks === 0) return "crypto";
  return "mixed";
}
