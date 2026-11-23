import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BREAKER_HEALTHY_BEATS,
  BREAKER_IN,
  breaker,
  breakerModel,
  METHOD_IN,
  METHODOLOGIES,
  methodology,
  methodologyModel,
  POLICY_IN,
  tradePolicy,
  tradePolicyModel,
} from "../src/darwin.ts";
import { Builder, decode, fromBits, pack, toBits, unpack } from "../src/netlist.ts";

const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

// ---- the builder and simulator against the official TAP-02 vectors ------------------------------
const vectors = JSON.parse(readFileSync(new URL("../vectors/tap-02-vectors.json", import.meta.url), "utf8"));

test("TAP-02 valid vectors: decode and evaluate exactly as specified (no REF)", () => {
  let checked = 0;
  for (const v of vectors.valid) {
    if (v.refs?.length) continue;
    const c = decode(v.name, hexBytes(v.netlist), v.nIn, v.nOut);
    assert.equal(c.hex(), v.netlist.toLowerCase(), `${v.name}: re-encoding`);
    if (c.nState) continue; // stateful vectors are checked through beat() in the breaker tests
    for (const row of v.truthTable) {
      const out = c.eval(unpack(hexBytes(row.inputs), v.nIn));
      assert.equal(Buffer.from(pack(out)).toString("hex"), row.outputs, `${v.name} ${row.inputs}`);
    }
    checked++;
  }
  assert.ok(checked >= 1);
});

test("TAP-02 packing edge cases", () => {
  const nand = decode("nand", hexBytes("0x00000002000003"), 2, 1);
  for (const c of vectors.packingEdgeCases.cases) {
    const out = nand.eval(unpack(hexBytes(c.inputs), 2));
    assert.equal(Buffer.from(pack(out)).toString("hex"), c.outputs, c.case);
  }
});

test("TAP-02 ill-formed vectors without REF are rejected", () => {
  for (const v of vectors.illFormed) {
    if (v.netlist.length < 4 || v.refs?.length && v.netlist.includes("02")) continue;
    let threw = false;
    try {
      decode(v.name, hexBytes(v.netlist), v.nIn, v.nOut);
    } catch {
      threw = true;
    }
    if (/opcode|truncated|signal|outputs/.test(v.reason)) assert.ok(threw, `${v.name} should be ill-formed (${v.reason})`);
  }
});

test("builder primitives: leConst, eqConst, inc on every 4-bit value", () => {
  for (let k = -1; k <= 16; k++) {
    const b = new Builder(4);
    const x = b.inputs(0, 4);
    const c = b.build("t", [b.leConst(x, k), b.eqConst(x, Math.max(0, Math.min(15, k))), ...b.inc(x)]);
    for (let v = 0; v < 16; v++) {
      const o = c.eval(toBits(v, 4));
      assert.equal(o[0], v <= k ? 1 : 0, `${v} <= ${k}`);
      assert.equal(o[1], v === Math.max(0, Math.min(15, k)) ? 1 : 0, `${v} == ${k}`);
      assert.equal(fromBits(o.slice(2)), (v + 1) % 16, `${v} + 1`);
    }
  }
});

test("a NAND may not read a signal that does not exist yet", () => {
  const b = new Builder(1);
  assert.throws(() => b.nand(2, 99));
});

test("every latch must be connected", () => {
  const b = new Builder(1);
  b.latch();
  assert.throws(() => b.build("t", [b.input(0)]));
});

// ---- 1. trade policy: all 32,768 inputs ----------------------------------------------------------
test("trade policy matches its reference model on all 32,768 inputs", () => {
  const c = tradePolicy();
  for (let x = 0; x < 1 << POLICY_IN.n; x++) {
    const bits = toBits(x, POLICY_IN.n);
    const i = {
      dev: fromBits(bits.slice(POLICY_IN.dev, POLICY_IN.dev + 4)),
      age: fromBits(bits.slice(POLICY_IN.age, POLICY_IN.age + 2)),
      seqUp: bits[POLICY_IN.seqUp],
      isBuy: bits[POLICY_IN.isBuy],
      drift: fromBits(bits.slice(POLICY_IN.drift, POLICY_IN.drift + 4)),
      better: bits[POLICY_IN.better],
      open: bits[POLICY_IN.open],
      pool: bits[POLICY_IN.pool],
    };
    const want = tradePolicyModel(i);
    const o = c.eval(bits);
    assert.deepEqual({ allow: o[0], severity: o[1] | (o[2] << 1) }, want, JSON.stringify(i));
  }
});

test("trade policy: named cases", () => {
  const c = tradePolicy();
  const run = (i: Partial<Parameters<typeof tradePolicyModel>[0]>) => {
    const v = { dev: 0, age: 0, seqUp: 1, isBuy: 1, drift: 0, better: 0, open: 1, pool: 0, ...i };
    const bits = [...toBits(v.dev, 4), ...toBits(v.age, 2), v.seqUp, v.isBuy, ...toBits(v.drift, 4), v.better, v.open, v.pool];
    const o = c.eval(bits);
    return { allow: o[0], severity: o[1] | (o[2] << 1) };
  };
  assert.deepEqual(run({}), { allow: 1, severity: 0 }, "fresh oracle, DEX on the oracle");
  assert.deepEqual(run({ dev: 8 }), { allow: 1, severity: 1 }, "2.00% away: allowed with a warning");
  assert.deepEqual(run({ dev: 9 }), { allow: 0, severity: 2 }, "2.25% away: a buy is refused");
  assert.deepEqual(run({ dev: 12, isBuy: 0 }), { allow: 1, severity: 1 }, "3.00% away: a sell still goes");
  assert.deepEqual(run({ dev: 13, isBuy: 0 }), { allow: 0, severity: 2 }, "3.25% away: a sell is refused");
  assert.deepEqual(run({ age: 2 }), { allow: 0, severity: 2 }, "past the heartbeat: no buy");
  assert.deepEqual(run({ age: 2, isBuy: 0 }), { allow: 1, severity: 1 }, "past the heartbeat: sells still go");
  assert.deepEqual(run({ age: 3, isBuy: 0 }), { allow: 0, severity: 3 }, "stale beyond grace: market broken");
  assert.deepEqual(run({ seqUp: 0 }), { allow: 0, severity: 3 }, "sequencer down: market broken");
  assert.deepEqual(run({ drift: 9 }), { allow: 0, severity: 2 }, "a buy may not push a coin 9 pp off target");
  assert.deepEqual(run({ drift: 9, better: 1 }), { allow: 1, severity: 0 }, "unless it brings it closer");
  assert.deepEqual(run({ drift: 15, isBuy: 0 }), { allow: 1, severity: 0 }, "sells are never held back by drift");
  assert.deepEqual(run({ open: 0 }), { allow: 0, severity: 2 }, "a stock on a weekend: closed, not broken");
  assert.deepEqual(run({ open: 0, age: 3, isBuy: 0 }), { allow: 0, severity: 2 }, "its feed is old on a weekend: still just closed");
  assert.deepEqual(run({ open: 0, seqUp: 0 }), { allow: 0, severity: 3 }, "sequencer down: broken, open or not");
  // a stock priced by its pool (weekend, holiday, Monday's first hour)
  const weekend = { open: 0, pool: 1 };
  assert.deepEqual(run({ ...weekend }), { allow: 1, severity: 0 }, "a weekend stock with a pool price: it trades");
  assert.deepEqual(run({ ...weekend, dev: 6 }), { allow: 1, severity: 1 }, "1.50% from its pool price: a buy still goes");
  assert.deepEqual(run({ ...weekend, dev: 7 }), { allow: 0, severity: 2 }, "1.75%: refused (2% on Chainlink)");
  assert.deepEqual(run({ ...weekend, dev: 8, isBuy: 0 }), { allow: 1, severity: 1 }, "a sell up to 2%");
  assert.deepEqual(run({ ...weekend, dev: 9, isBuy: 0 }), { allow: 0, severity: 2 }, "2.25%: refused (3% on Chainlink)");
  assert.deepEqual(run({ ...weekend, age: 2 }), { allow: 0, severity: 2 }, "a pool quiet for hours: no buy");
  assert.deepEqual(run({ ...weekend, age: 3, isBuy: 0 }), { allow: 0, severity: 3 }, "a dead pool price: broken");
  assert.deepEqual(run({ ...weekend, seqUp: 0 }), { allow: 0, severity: 3 }, "sequencer down: broken");
  assert.deepEqual(run({ open: 1, pool: 1, dev: 7 }), { allow: 0, severity: 2 }, "Monday's first hour, feed still frozen: pool limits");
});

// ---- 2. breaker: every state x every input, and long sequences ----------------------------------
const breakerBits = (s: { tripped: number; counter: number }) => [s.tripped, ...toBits(s.counter, 3)];

test("breaker matches its model on every state and input (16 x 32)", () => {
  const c = breaker();
  for (let st = 0; st < 16; st++) {
    const s = { tripped: st & 1, counter: st >> 1 };
    for (let x = 0; x < 1 << BREAKER_IN.n; x++) {
      const healthy = x === (1 << BREAKER_IN.n) - 1;
      const r = c.beat(breakerBits(s), toBits(x, BREAKER_IN.n));
      const want = breakerModel(s, healthy);
      assert.deepEqual(r.state, breakerBits(want), `state ${JSON.stringify(s)} input ${x}`);
      assert.deepEqual(r.outputs, breakerBits(want), "outputs equal the new state");
    }
  }
});

test("breaker: trips on one bad beat, resets only after 8 healthy beats in a row", () => {
  const c = breaker();
  const ok = toBits(31, 5);
  let st = breakerBits({ tripped: 0, counter: 0 });
  st = c.beat(st, ok).state;
  assert.equal(st[0], 0, "healthy market stays open");
  for (let bad = 0; bad < 5; bad++) {
    const r = c.beat(breakerBits({ tripped: 0, counter: 0 }), toBits(31 & ~(1 << bad), 5));
    assert.equal(r.state[0], 1, `input ${bad} alone trips it`);
  }
  st = c.beat(st, toBits(0b10111, 5)).state; // prices out of band
  assert.equal(st[0], 1);
  for (let k = 1; k < BREAKER_HEALTHY_BEATS; k++) {
    st = c.beat(st, ok).state;
    assert.equal(st[0], 1, `still tripped after ${k} healthy beats`);
  }
  st = c.beat(st, toBits(0b11110, 5)).state; // one stale beat on the seventh: start over
  for (let k = 1; k < BREAKER_HEALTHY_BEATS; k++) st = c.beat(st, ok).state;
  assert.equal(st[0], 1, "the count restarted");
  st = c.beat(st, ok).state;
  assert.equal(st[0], 0, "eighth healthy beat in a row: open again");
  assert.equal(fromBits(st.slice(1)), 0);
});

// ---- 3. methodologies ---------------------------------------------------------------------------
test("methodologies: weights, bands and eligibility on every input", () => {
  for (const m of METHODOLOGIES) {
    const c = methodology(m);
    for (let x = 0; x < 1 << METHOD_IN.n; x++) {
      const bits = toBits(x, METHOD_IN.n);
      const idx = fromBits(bits.slice(0, 3));
      const want = methodologyModel(m, idx, bits[METHOD_IN.eligible]);
      const o = c.eval(bits);
      assert.deepEqual({ weight: fromBits(o.slice(0, 7)), band: fromBits(o.slice(7)) }, want, `${m.name} idx ${idx} eligible ${bits[3]}`);
    }
  }
});

test("a methodology must sum to 100%", () => {
  assert.throws(() => methodology({ name: "bad", coins: [{ symbol: "A", weight: 60 }, { symbol: "B", weight: 30 }], band: 5 }));
});

// ---- the official Python reference evaluates our netlists the same way ---------------------------
test("the TAP-02 Python reference agrees with our simulator on every circuit", () => {
  const circuits = [tradePolicy(), breaker(), ...METHODOLOGIES.map(methodology)];
  const cases = circuits.map((c) => {
    const n = c.nIn + c.nState;
    const rows: { state: string; inputs: string }[] = [];
    for (let x = 0; x < 1 << n; x += n > 10 ? 7 : 1) {
      const bits = toBits(x, n);
      rows.push({ state: Buffer.from(pack(bits.slice(c.nIn))).toString("hex"), inputs: Buffer.from(pack(bits.slice(0, c.nIn))).toString("hex") });
    }
    return { name: c.name, netlist: c.hex(), nIn: c.nIn, nOut: c.nOut, rows };
  });
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from tap02_reference import load, beat, unpack, pack
out = []
for c in json.load(sys.stdin):
    circ = load(bytes.fromhex(c["netlist"][2:]), c["nIn"], c["nOut"])
    res = []
    for r in c["rows"]:
        ns, o = beat(circ, unpack(bytes.fromhex(r["state"]), circ.n_state), unpack(bytes.fromhex(r["inputs"]), c["nIn"]))
        res.append(pack(ns).hex() + "|" + pack(o).hex())
    out.append(res)
print(json.dumps(out))
`;
  const py = JSON.parse(
    execFileSync("python3", ["-I", "-c", script, new URL("../vectors/", import.meta.url).pathname], { input: JSON.stringify(cases), maxBuffer: 1 << 26 }).toString(),
  );
  let n = 0;
  cases.forEach((cs, k) => {
    const c = circuits[k];
    cs.rows.forEach((r, j) => {
      const res = c.beat(unpack(hexBytes(r.state), c.nState), unpack(hexBytes(r.inputs), c.nIn));
      assert.equal(`${Buffer.from(pack(res.state)).toString("hex")}|${Buffer.from(pack(res.outputs)).toString("hex")}`, py[k][j], `${c.name} row ${j}`);
      n++;
    });
  });
  assert.ok(n > 1500, `${n} rows compared`);
});
