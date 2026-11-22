import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Footer, Header } from "@/components/Shell";
import { WalletProvider } from "@/lib/wallet";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Darwin on X Layer | Index baskets of tokenized stocks and crypto", template: "%s | Darwin on X Layer" },
  description:
    "One token, a whole strategy: index baskets of tokenized US stocks and crypto on X Layer, every trade governed by public TapeOut circuits.",
};

export const viewport: Viewport = { themeColor: "#f6f3ea" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <WalletProvider>
          <Header />
          <main>{children}</main>
          <Footer />
        </WalletProvider>
      </body>
    </html>
  );
}
