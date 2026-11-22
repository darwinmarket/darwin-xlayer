import type { Metadata } from "next";
import { Studio } from "./Studio";

export const metadata: Metadata = { title: "Studio" };

export default function Page() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Studio</span>
          <h1 className="h1" style={{ marginTop: 6 }}>
            Design your strategy
          </h1>
          <p className="lead">
            Pick tokenized stocks and crypto, set the weights, and tape your rules out as a TapeOut circuit. One transaction launches it as a
            basket anyone can buy.
          </p>
        </div>
      </div>
      <Studio />
    </div>
  );
}
