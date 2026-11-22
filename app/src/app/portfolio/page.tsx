import type { Metadata } from "next";
import { PortfolioView } from "./PortfolioView";

export const metadata: Metadata = { title: "Portfolio" };

export default function Page() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Portfolio</span>
          <h1 className="h1" style={{ marginTop: 6 }}>
            Your baskets
          </h1>
        </div>
      </div>
      <PortfolioView />
    </div>
  );
}
