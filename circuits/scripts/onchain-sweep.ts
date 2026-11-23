/**
 * Evaluates the trade-policy circuit on a TapeOut processor for every one of its 32,768 inputs
 * (eth_call to processor.eval) and compares each answer with the reference model.
 *
 *   node scripts/onchain-sweep.ts [deployment.json] [rpc]
 *   node scripts/onchain-sweep.ts ../deployments/xlayer.json https://rpc.xlayer.tech
 *
 * Public X Layer RPCs accept 10 calls per batch: expect a few minutes there, a second on a fork.
 */
import { readFileSync } from "node:fs";
import { POLICY_IN, tradePolicyModel } from "../src/darwin.ts";
import { fromBits, pack, toBits, unpack } from "../src/netlist.ts";

const file = process.argv[2] ?? "../deployments/local.json";
const rpc = process.argv[3] ?? "http://127.0.0.1:8546";
const d = JSON.parse(readFileSync(file, "utf8"));
const batch = rpc.includes("127.0.0.1") || rpc.includes("localhost") ? 500 : 10;

const EVAL = "0x934d06ea"; // eval(uint256,bytes)
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
function calldata(bits: number[]): string {
  const b = Buffer.from(pack(bits)).toString("hex");
  return EVAL + word(BigInt(d.policyCircuit)) + word(64) + word(b.length / 2) + b.padEnd(64, "0");
}
function outputs(ret: string): number[] {
  const len = parseInt(ret.slice(2 + 64, 2 + 128), 16);
  return unpack(Uint8Array.from(Buffer.from(ret.slice(2 + 128, 2 + 128 + 2 * len), "hex")), 3);
}

const N = 1 << POLICY_IN.n;
let bad = 0;
for (let s = 0; s < N; s += batch) {
  const body = [];
  for (let x = s; x < Math.min(N, s + batch); x++) {
    body.push({ jsonrpc: "2.0", id: x, method: "eth_call", params: [{ to: d.processor, data: calldata(toBits(x, POLICY_IN.n)) }, "latest"] });
  }
  const res = (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as {
    id: number;
    result?: string;
    error?: unknown;
  }[];
  for (const r of res) {
    if (!r.result) throw new Error(`input ${r.id}: ${JSON.stringify(r.error)}`);
    const bits = toBits(r.id, POLICY_IN.n);
    const want = tradePolicyModel({
      dev: fromBits(bits.slice(POLICY_IN.dev, POLICY_IN.dev + 4)),
      age: fromBits(bits.slice(POLICY_IN.age, POLICY_IN.age + 2)),
      seqUp: bits[POLICY_IN.seqUp],
      isBuy: bits[POLICY_IN.isBuy],
      drift: fromBits(bits.slice(POLICY_IN.drift, POLICY_IN.drift + 4)),
      better: bits[POLICY_IN.better],
      open: bits[POLICY_IN.open],
      pool: bits[POLICY_IN.pool],
    });
    const o = outputs(r.result);
    if (o[0] !== want.allow || (o[1] | (o[2] << 1)) !== want.severity) bad++;
  }
}
console.log(`policy circuit #${d.policyCircuit} on ${d.processor}: ${N} inputs evaluated on chain, ${bad} mismatches`);
process.exit(bad === 0 ? 0 : 1);
