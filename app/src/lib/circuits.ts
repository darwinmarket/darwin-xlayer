import { keccak256, type Hex } from "viem";
import { tapeoutProcessorAbi } from "@/abi/TapeoutProcessor";
import { BREAKER_IN, POLICY_IN, breaker, tradePolicy, tradePolicyModel } from "@/circuits/darwin.ts";
import { decode, fromBits, pack, toBits, unpack, type Circuit } from "@/circuits/netlist.ts";
import { publicClient } from "./client";
import { DEPLOYMENT } from "./deployment";
import { toHex } from "./format";

export type PolicyInput = { dev: number; age: number; seqUp: number; isBuy: number; drift: number; better: number; open: number };

/** The 14 input bits, LSB first, exactly as DarwinGuard.policyInputs packs them. */
export function policyBits(i: PolicyInput): number[] {
  const bits = new Array(POLICY_IN.n).fill(0);
  toBits(Math.min(i.dev, 15), 4).forEach((b, k) => (bits[POLICY_IN.dev + k] = b));
  toBits(Math.min(i.age, 3), 2).forEach((b, k) => (bits[POLICY_IN.age + k] = b));
  bits[POLICY_IN.seqUp] = i.seqUp;
  bits[POLICY_IN.isBuy] = i.isBuy;
  toBits(Math.min(i.drift, 15), 4).forEach((b, k) => (bits[POLICY_IN.drift + k] = b));
  bits[POLICY_IN.better] = i.better;
  bits[POLICY_IN.open] = i.open;
  return bits;
}

export const policyValue = (i: PolicyInput) => fromBits(policyBits(i));
export const packedHex = (bits: number[]): Hex => toHex(pack(bits));

export type Verdict = { allow: number; severity: number; bits: number[] };
export const verdictOf = (out: number[]): Verdict => ({ allow: out[0], severity: out[1] | (out[2] << 1), bits: out });

export type OnchainCircuit = { id: bigint; nIn: number; nOut: number; nState: number; gates: number; netlist: Hex; hash: Hex; circuit: Circuit };

const circuitCache = new Map<string, Promise<OnchainCircuit>>();

/** A circuit as stored on the processor: shape, netlist bytes, decoded for the local simulator. */
export function fetchCircuit(id: bigint, name = `circuit-${id}`): Promise<OnchainCircuit> {
  const key = `${DEPLOYMENT!.processor}:${id}`;
  let p = circuitCache.get(key);
  if (!p) {
    p = (async () => {
      const proc = { address: DEPLOYMENT!.processor, abi: tapeoutProcessorAbi } as const;
      const [info, nl] = await Promise.all([
        publicClient.readContract({ ...proc, functionName: "circuitInfo", args: [id] }),
        publicClient.readContract({ ...proc, functionName: "netlist", args: [id] }),
      ]);
      const [nIn, nOut, nState, gates] = info.map(Number);
      const bytes = hexToBytes(nl);
      return { id, nIn, nOut, nState, gates, netlist: nl, hash: keccak256(nl), circuit: decode(name, bytes, nIn, nOut) };
    })();
    p.catch(() => circuitCache.delete(key));
    circuitCache.set(key, p);
  }
  return p;
}

export function hexToBytes(h: Hex): Uint8Array {
  const s = h.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** processor.eval(id, inputs) by eth_call (optionally at a past block). */
export async function evalOnchain(id: bigint, bits: number[], nOut: number, blockNumber?: bigint): Promise<number[]> {
  const out = await publicClient.readContract({
    address: DEPLOYMENT!.processor,
    abi: tapeoutProcessorAbi,
    functionName: "eval",
    args: [id, packedHex(bits)],
    blockNumber,
  });
  return unpack(hexToBytes(out), nOut);
}

export async function stepOnchain(id: bigint, state: number[], bits: number[], nOut: number): Promise<{ state: number[]; outputs: number[] }> {
  const [s, o] = await publicClient.readContract({
    address: DEPLOYMENT!.processor,
    abi: tapeoutProcessorAbi,
    functionName: "step",
    args: [id, packedHex(state), packedHex(bits)],
  });
  return { state: unpack(hexToBytes(s), state.length), outputs: unpack(hexToBytes(o), nOut) };
}

/** The reference circuits as built from circuits/src, to compare with what is on chain. */
let built: { policy: Circuit; breaker: Circuit; policyHex: Hex; breakerHex: Hex } | null = null;
export function referenceCircuits() {
  if (!built) {
    const p = tradePolicy();
    const b = breaker();
    built = { policy: p, breaker: b, policyHex: toHex(p.encode()), breakerHex: toHex(b.encode()) };
  }
  return built;
}

export { BREAKER_IN, POLICY_IN, tradePolicyModel, unpack, toBits, fromBits };
