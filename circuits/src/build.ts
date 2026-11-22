/** Build Darwin's circuits into circuits/build/<name>.json (netlist, sizes, hash). */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { breaker, METHODOLOGIES, methodology, tradePolicy } from "./darwin.ts";

const out = new URL("../build/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const all = [tradePolicy(), breaker(), ...METHODOLOGIES.map(methodology)];
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
