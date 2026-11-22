import type { Metadata } from "next";
import { CircuitsView } from "./CircuitsView";

export const metadata: Metadata = { title: "Circuits" };

export default function Page() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <span className="eyebrow">TapeOut</span>
          <h1 className="h1" style={{ marginTop: 6 }}>
            The circuits that govern every basket
          </h1>
          <p className="lead">
            NAND and LATCH netlists stored on X Layer, called by Darwin&apos;s contracts inside each trade. Everything below is read from the
            processor and re-evaluated live, in this browser and on chain.
          </p>
        </div>
      </div>
      <CircuitsView />
    </div>
  );
}
