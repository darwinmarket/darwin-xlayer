"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { darwinGuardAbi } from "@/abi/DarwinGuard";
import { CircuitDiagram } from "@/components/CircuitDiagram";
import { BreakerBadge } from "@/components/Status";
import { Bits, Check, ErrorBox, LogoStack, RequireDeployment, Skeleton, Toggle } from "@/components/ui";
import {
  evalOnchain,
  fetchCircuit,
  policyBits,
  referenceCircuits,
  stepOnchain,
  toBits,
  tradePolicyModel,
  verdictOf,
  type OnchainCircuit,
  type PolicyInput,
} from "@/lib/circuits";
import { FACTS, type BasketInfo } from "@/lib/data";
import { DEPLOYMENT, explorerAddress, explorerToken } from "@/lib/deployment";
import { ago, errorText, int, severityLabel, short } from "@/lib/format";
import { useBaskets } from "@/lib/hooks";
import { send } from "@/lib/tx";
import { invalidate, useQuery } from "@/lib/useQuery";
import { useWallet } from "@/lib/wallet";

const POLICY_LABELS = ["dev0", "dev1", "dev2", "dev3", "age0", "age1", "seqUp", "isBuy", "drift0", "drift1", "drift2", "drift3", "better", "open"];
const BREAKER_LABELS = ["feeds", "seqUp", "peg", "prices", "reserves"];

export function CircuitsView() {
  return (
    <RequireDeployment>
      <Inner />
    </RequireDeployment>
  );
}

function Inner() {
  const d = DEPLOYMENT!;
  const q = useQuery("circuits:core", async () => {
    const [policy, breaker] = await Promise.all([fetchCircuit(d.policyCircuit, "darwin-trade-policy"), fetchCircuit(d.breakerCircuit, "darwin-breaker")]);
    return { policy, breaker };
  }, { staleMs: 600_000 });
  if (q.error) return <ErrorBox error={q.error} retry={q.refresh} />;
  if (!q.data)
    return (
      <div className="grid-2">
        <Skeleton h={260} />
        <Skeleton h={260} />
      </div>
    );
  const ref = referenceCircuits();
  return (
    <div className="stack-l">
      <div className="grid-2">
        <CircuitCard
          title="Trade policy"
          kind="combinational · eval()"
          c={q.data.policy}
          referenceHex={ref.policyHex}
          blurb="Called once per leg of every buy and sell. Judges the real execution price against Chainlink, the feed's age, the sequencer, the market session and the basket's drift. One refusal reverts the trade."
          inputLabels={POLICY_LABELS}
          outputLabels={["allow", "sev0", "sev1"]}
        />
        <CircuitCard
          title="Market-risk breaker"
          kind="stateful · step() · 4 LATCH"
          c={q.data.breaker}
          referenceHex={ref.breakerHex}
          blurb="One state per basket, beaten on every trade and by anyone through poke(). Any unhealthy beat trips the basket to sell-only; eight healthy beats in a row reopen it. Nobody can reset it by hand."
          inputLabels={BREAKER_LABELS}
          outputLabels={["tripped", "c0", "c1", "c2"]}
        />
      </div>
      <PolicyExplorer c={q.data.policy} />
      <Breakers breaker={q.data.breaker} />
    </div>
  );
}

function CircuitCard({
  title,
  kind,
  c,
  referenceHex,
  blurb,
  inputLabels,
  outputLabels,
}: {
  title: string;
  kind: string;
  c: OnchainCircuit;
  referenceHex: string;
  blurb: string;
  inputLabels: string[];
  outputLabels: string[];
}) {
  const d = DEPLOYMENT!;
  const same = c.netlist.toLowerCase() === referenceHex.toLowerCase();
  return (
    <section className="card stack" data-testid="circuit-card">
      <div className="between">
        <div>
          <span className="eyebrow">{kind}</span>
          <h2 className="h2" style={{ marginTop: 4 }}>
            {title}
          </h2>
        </div>
        <a className="tag tag-crypto" href={explorerToken(d.processor, c.id)} target="_blank" rel="noreferrer">
          Circuit #{c.id.toString()}
        </a>
      </div>
      <p className="small muted">{blurb}</p>
      <dl className="kv small">
        <dt>Shape</dt>
        <dd>
          {c.nIn} in · {c.nOut} out · {c.nState} state bits
        </dd>
        <dt>Gates</dt>
        <dd>
          {int(c.gates)} ({c.circuit.nNand} NAND, {c.circuit.nLatch} LATCH)
        </dd>
        <dt>Processor</dt>
        <dd>
          <a className="mono link" href={explorerAddress(d.processor)} target="_blank" rel="noreferrer">
            {short(d.processor)}
          </a>
        </dd>
        <dt>Netlist keccak256</dt>
        <dd className="mono xsmall break">{c.hash}</dd>
        <dt>Same as circuits/src</dt>
        <dd>
          <span className="row" style={{ justifyContent: "flex-end" }}>
            <Check ok={same} /> {same ? "byte for byte" : "differs"}
          </span>
        </dd>
      </dl>
      <CircuitDiagram circuit={c.circuit} inputLabels={inputLabels} outputLabels={outputLabels} height={180} />
      <details>
        <summary className="small" style={{ cursor: "pointer" }}>
          Netlist read from processor.netlist({c.id.toString()})
        </summary>
        <div className="hex" style={{ marginTop: 8 }}>
          {c.netlist}
        </div>
      </details>
    </section>
  );
}

function PolicyExplorer({ c }: { c: OnchainCircuit }) {
  const [i, setI] = useState<PolicyInput>({ dev: 2, age: 0, seqUp: 1, isBuy: 1, drift: 3, better: 1, open: 1, pool: 0 });
  const bits = useMemo(() => policyBits(i), [i]);
  const local = useMemo(() => verdictOf(c.circuit.eval(bits)), [c, bits]);
  const model = tradePolicyModel(i);
  const [chain, setChain] = useState<{ bits: string; v: ReturnType<typeof verdictOf> } | null>(null);
  const [chainErr, setChainErr] = useState<string | null>(null);
  const key = bits.join("");
  useEffect(() => {
    let stale = false;
    const id = setTimeout(() => {
      evalOnchain(c.id, bits, c.nOut)
        .then((out) => !stale && (setChain({ bits: key, v: verdictOf(out) }), setChainErr(null)))
        .catch((e) => !stale && setChainErr(errorText(e)));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [c, bits, key]);
  const chainNow = chain?.bits === key ? chain.v : null;

  const [sweep, setSweep] = useState<{ n: number; bad: number; ms: number } | null>(null);
  const runSweep = () => {
    const t0 = performance.now();
    let bad = 0;
    const n = 1 << 15;
    for (let v = 0; v < n; v++) {
      const b = toBits(v, 15);
      const inp = {
        dev: v & 15,
        age: (v >> 4) & 3,
        seqUp: (v >> 6) & 1,
        isBuy: (v >> 7) & 1,
        drift: (v >> 8) & 15,
        better: (v >> 12) & 1,
        open: (v >> 13) & 1,
        pool: (v >> 14) & 1,
      };
      const out = verdictOf(c.circuit.eval(b));
      const m = tradePolicyModel(inp);
      if (out.allow !== m.allow || out.severity !== m.severity) bad++;
    }
    setSweep({ n, bad, ms: Math.round(performance.now() - t0) });
  };

  const set = <K extends keyof PolicyInput>(k: K, v: PolicyInput[K]) => setI((x) => ({ ...x, [k]: v }));
  return (
    <section className="card stack" data-testid="policy-explorer">
      <div className="between">
        <div>
          <span className="eyebrow">Truth table explorer</span>
          <h2 className="h2" style={{ marginTop: 4 }}>
            Ask the trade-policy circuit
          </h2>
        </div>
        <span className={`tag ${local.allow ? (local.severity === 0 ? "tag-pos" : "tag-warn") : "tag-neg"}`} data-testid="policy-verdict">
          {local.allow ? "allow" : "refuse"} · {severityLabel(local.severity)}
        </span>
      </div>
      <div className="grid-2">
        <div className="stack">
          <label className="field">
            <span className="between label">
              <span>dev · |execution − Chainlink|</span>
              <span className="mono">
                {i.dev} = {(i.dev * 0.25).toFixed(2)}%
              </span>
            </span>
            <input type="range" min={0} max={15} value={i.dev} onChange={(e) => set("dev", Number(e.target.value))} aria-label="dev" />
          </label>
          <label className="field">
            <span className="between label">
              <span>drift · |weight after − target|</span>
              <span className="mono">{i.drift} pp</span>
            </span>
            <input type="range" min={0} max={15} value={i.drift} onChange={(e) => set("drift", Number(e.target.value))} aria-label="drift" />
          </label>
          <div className="field">
            <span className="label">age · oracle answer</span>
            <div className="seg">
              {["< 1 h", "< heartbeat", "+ grace", "stale"].map((l, k) => (
                <button key={k} aria-pressed={i.age === k} onClick={() => set("age", k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="grid-2">
            {(
              [
                ["isBuy", "Buy leg"],
                ["open", "Market in session"],
                ["pool", "Priced by its pool"],
                ["seqUp", "Sequencer up"],
                ["better", "Moves towards target"],
              ] as const
            ).map(([k, l]) => (
              <div key={k} className="row small">
                <Toggle checked={i[k] === 1} onChange={(v) => set(k, v ? 1 : 0)} label={l} /> {l}
              </div>
            ))}
          </div>
        </div>
        <div className="stack">
          <div className="small">
            Input bits (bit 13 → 0): <Bits value={bits.reduce((a, b, k) => a | (b << k), 0)} n={14} labels={POLICY_LABELS} />
          </div>
          <div className="stack-s">
            <Row label="In this browser (netlist from the processor)" v={local} />
            <Row label="On chain: processor.eval() by eth_call" v={chainNow} error={chainErr} testid="policy-onchain" />
            <Row label="Reference model (circuits/src)" v={{ allow: model.allow, severity: model.severity }} />
          </div>
          <div className={`notice ${chainNow && chainNow.allow === local.allow && chainNow.severity === local.severity ? "notice-pos" : "notice-info"} xsmall`} data-testid="policy-match">
            {chainNow
              ? chainNow.allow === local.allow && chainNow.severity === local.severity
                ? "Browser and chain agree."
                : "Browser and chain disagree."
              : "Evaluating on chain…"}
          </div>
          <div className="row-wrap">
            <button className="btn btn-ghost btn-s" onClick={runSweep} data-testid="sweep">
              Check all 16,384 inputs against the model
            </button>
            {sweep && (
              <span className={`small ${sweep.bad ? "neg" : "pos"}`} data-testid="sweep-result">
                {sweep.bad === 0 ? `All ${int(sweep.n)} match` : `${sweep.bad} mismatches`} ({sweep.ms} ms)
              </span>
            )}
          </div>
        </div>
      </div>
      <CircuitDiagram circuit={c.circuit} inputs={bits} inputLabels={POLICY_LABELS} outputLabels={["allow", "sev0", "sev1"]} height={240} />
    </section>
  );
}

function Row({ label, v, error, testid }: { label: string; v: { allow: number; severity: number } | null; error?: string | null; testid?: string }) {
  return (
    <div className="between card-flat" style={{ padding: "10px 12px" }} data-testid={testid}>
      <span className="xsmall">{label}</span>
      {error ? (
        <span className="xsmall neg">{error}</span>
      ) : v ? (
        <span className="mono small nowrap">
          allow={v.allow} sev={v.severity}
        </span>
      ) : (
        <span className="spin" />
      )}
    </div>
  );
}

function Breakers({ breaker }: { breaker: OnchainCircuit }) {
  const q = useBaskets();
  return (
    <section className="card stack">
      <div className="between">
        <div>
          <span className="eyebrow">Live state</span>
          <h2 className="h2" style={{ marginTop: 4 }}>
            Every basket&apos;s breaker
          </h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            guard.breakers() is the stored LATCH state; guard.preview() runs the five facts through the circuit now, without storing it. Anyone may
            poke a basket to store a beat.
          </p>
        </div>
      </div>
      {q.error ? (
        <ErrorBox error={q.error} retry={q.refresh} />
      ) : !q.data ? (
        <Skeleton h={200} />
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="breakers">
            <thead>
              <tr>
                <th>Basket</th>
                <th>State</th>
                {FACTS.map((f) => (
                  <th key={f.bit} title={f.hint}>
                    {f.label}
                  </th>
                ))}
                <th>Last beat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.baskets.map((b) => (
                <BreakerRow key={b.address} b={b} breaker={breaker} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BreakerRow({ b, breaker }: { b: BasketInfo; breaker: OnchainCircuit }) {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const facts = b.preview?.facts ?? 0;
  // the same beat, in this browser, from the stored state
  const local = useMemo(() => breaker.circuit.beat(toBits(b.breaker.state, 4), toBits(facts, 5)), [breaker, b.breaker.state, facts]);
  const [chainStep, setChainStep] = useState<number[] | null>(null);
  useEffect(() => {
    stepOnchain(breaker.id, toBits(b.breaker.state, 4), toBits(facts, 5), breaker.nOut)
      .then((r) => setChainStep(r.outputs))
      .catch(() => setChainStep(null));
  }, [breaker, b.breaker.state, facts]);
  const agree = chainStep ? chainStep.join("") === local.outputs.join("") : null;

  const poke = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await w.ensureChain();
      const r = await send(w.walletClient(), { address: DEPLOYMENT!.guard, abi: darwinGuardAbi, functionName: "poke", args: [b.address] });
      setMsg({ ok: true, text: `Beat stored in block ${int(r.blockNumber)}.` });
      invalidate("baskets");
      invalidate(`basket:${b.address.toLowerCase()}`);
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>
        <Link href={`/basket/${b.address}`} className="row" style={{ gap: 8 }}>
          <LogoStack metas={b.holdings.map((h) => h.meta)} size={20} max={3} />
          <span>
            <strong className="small">{b.name}</strong>
            <span className="xsmall muted mono" style={{ display: "block" }}>
              {b.symbol}
            </span>
          </span>
        </Link>
      </td>
      <td>
        <div className="stack-s">
          <BreakerBadge b={b} />
          <span className="xsmall muted mono nowrap" title="state bits c2 c1 c0 tripped; the same beat replayed in this browser and with processor.step()">
            state {b.breaker.state.toString(2).padStart(4, "0")}
            {agree === null ? "" : agree ? " · step() agrees" : " · step() differs"}
          </span>
        </div>
      </td>
      {FACTS.map((f) => (
        <td key={f.bit}>
          <Check ok={((facts >> f.bit) & 1) === 1} />
        </td>
      ))}
      <td className="xsmall muted nowrap">{b.breaker.lastBeat ? ago(b.breaker.lastBeat) : "never"}</td>
      <td className="r">
        {w.account ? (
          <button className="btn btn-ghost btn-s" onClick={poke} disabled={busy} data-testid="poke">
            {busy && <span className="spin" />}
            Poke
          </button>
        ) : (
          <button className="btn btn-ghost btn-s" onClick={() => w.setPickerOpen(true)}>
            Poke
          </button>
        )}
        {msg && (
          <div className={`xsmall ${msg.ok ? "pos" : "neg"}`} style={{ maxWidth: 220, marginTop: 4, whiteSpace: "normal" }}>
            {msg.text}
          </div>
        )}
      </td>
    </tr>
  );
}
