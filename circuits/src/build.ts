/** Build Darwin's circuits into circuits/build/<name>.json (netlist, sizes, hash). */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { breaker, METHODOLOGIES, methodology, tradePolicy } from "./darwin.ts";
import { Builder } from "./netlist.ts";

const out = new URL("../build/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
// test fixtures for the studio: a creator's strategy, and circuits it must refuse
const fixtures = [
  methodology({ name: "fixture-nvda-btc", coins: [{ symbol: "wNVDAx", weight: 50 }, { symbol: "xBTC", weight: 50 }], band: 4 }),
  (() => {
    // weights 60/30: does not sum to 100 (built by hand: methodology() refuses it)
    const b = new Builder(4);
    const idx = b.inputs(0, 3);
    const e = b.input(3);
    const s0 = b.and(b.eqConst(idx, 0), e);
    const s1 = b.and(b.eqConst(idx, 1), e);
    const w = [0, 1, 2, 3, 4, 5, 6].map((bit) => b.orAll([((60 >> bit) & 1) ? s0 : 0, ((30 >> bit) & 1) ? s1 : 0].filter((x) => x !== 0)));
    return b.build("fixture-bad-sum", [...w, ...b.constant(5, 4)]);
  })(),
  // a valid three-coin methodology used with two coins: index 2 gets weight it should not
  methodology({ name: "fixture-extra-index", coins: [{ symbol: "A", weight: 40 }, { symbol: "B", weight: 40 }, { symbol: "C", weight: 20 }], band: 5 }),
];
const all = [tradePolicy(), breaker(), ...METHODOLOGIES.map(methodology), ...fixtures];
for (const c of all) {
  const bytes = c.encode();
  const json = {
    name: c.name,
    nIn: c.nIn,
    nOut: c.nOut,
    nState: c.nState,
    nand: c.nNand,
    latch: c.nLatch,
    netlist: c.hex(),
    // the contracts pin keccak256(netlist); sha256 is listed for tools that prefer it
    sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
  };
  writeFileSync(`${out}${c.name}.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`${c.name.padEnd(22)} in ${String(c.nIn).padStart(2)} out ${String(c.nOut).padStart(2)} state ${c.nState} gates ${c.gates} (${c.nNand} NAND, ${c.nLatch} LATCH)`);
}
