"use client";

import { memo, useMemo } from "react";
import type { Circuit } from "@/circuits/netlist.ts";

/** Every signal's value for one beat (constants, inputs, then one per element), as the processor computes them. */
export function signalValues(c: Circuit, inputs: number[], state: number[] = []): number[] {
  const a: number[] = [0, 1, ...inputs];
  let k = 0;
  for (const e of c.els) {
    if (e.op === 0) a.push(1 - (a[e.a] & a[e.b]));
    else a.push(state[k++] ?? 0);
  }
  return a;
}

type Layout = { x: number[]; y: number[]; w: number; h: number; depth: number[] };

function layout(c: Circuit, colW: number, rowH: number): Layout {
  const nSig = 2 + c.nIn + c.els.length;
  const depth = new Array(nSig).fill(0);
  c.els.forEach((e, i) => {
    const s = 2 + c.nIn + i;
    depth[s] = e.op === 0 ? Math.max(depth[e.a], depth[e.b]) + 1 : 1;
  });
  const cols: number[][] = [];
  for (let s = 2; s < nSig; s++) (cols[depth[s]] ??= []).push(s);
  const maxRows = Math.max(...cols.map((c) => c?.length ?? 0));
  const x = new Array(nSig).fill(0);
  const y = new Array(nSig).fill(0);
  const h = maxRows * rowH + rowH;
  cols.forEach((col, d) => {
    if (!col) return;
    const off = (h - col.length * rowH) / 2;
    col.forEach((s, r) => {
      x[s] = 28 + d * colW;
      y[s] = off + r * rowH + rowH / 2;
    });
  });
  // constants sit at the top left
  x[0] = x[1] = 8;
  y[0] = 6;
  y[1] = 14;
  return { x, y, w: 56 + (cols.length - 1) * colW, h, depth };
}

/**
 * The netlist drawn as a layered graph: inputs on the left, each NAND in the column of its depth,
 * the outputs on the right. Given input values, the wires carrying a 1 light up in gold.
 */
export const CircuitDiagram = memo(function CircuitDiagram({
  circuit,
  inputs,
  state,
  inputLabels,
  outputLabels,
  height = 260,
}: {
  circuit: Circuit;
  inputs?: number[];
  state?: number[];
  inputLabels?: string[];
  outputLabels?: string[];
  height?: number;
}) {
  const colW = 34;
  const L = useMemo(() => layout(circuit, colW, Math.max(4, 7 - circuit.els.length / 100)), [circuit]);
  const values = useMemo(() => (inputs ? signalValues(circuit, inputs, state) : null), [circuit, inputs, state]);
  const firstOut = 2 + circuit.nIn + circuit.els.length - circuit.nOut;
  const edges = useMemo(() => {
    const out: { a: number; b: number; latch?: boolean }[] = [];
    circuit.els.forEach((e, i) => {
      const s = 2 + circuit.nIn + i;
      if (e.op === 0) {
        if (e.a > 1) out.push({ a: e.a, b: s });
        if (e.b > 1 && e.b !== e.a) out.push({ a: e.b, b: s });
      } else out.push({ a: e.d, b: s, latch: true });
    });
    return out;
  }, [circuit]);
  const scale = height / Math.max(L.h, 1);

  return (
    <div style={{ overflowX: "auto", background: "#17150f", borderRadius: 12, padding: 10 }}>
      <svg
        width={Math.max(L.w + 60, 300)}
        height={height}
        viewBox={`0 0 ${Math.max(L.w + 60, 300)} ${L.h}`}
        preserveAspectRatio="xMinYMid meet"
        role="img"
        aria-label={`${circuit.name}: ${circuit.gates} gates`}
        style={{ display: "block", height, width: "auto", minWidth: "100%" }}
      >
        <g strokeWidth={0.6 / Math.min(1, scale) / 2}>
          {edges.map((e, i) => {
            const on = values ? values[e.a] === 1 : false;
            return (
              <path
                key={i}
                d={`M${L.x[e.a]},${L.y[e.a]} C${(L.x[e.a] + L.x[e.b]) / 2},${L.y[e.a]} ${(L.x[e.a] + L.x[e.b]) / 2},${L.y[e.b]} ${L.x[e.b]},${L.y[e.b]}`}
                fill="none"
                stroke={on ? "#e2b85a" : "rgba(246,241,227,0.16)"}
                strokeDasharray={e.latch ? "2 2" : undefined}
                opacity={on ? 0.95 : 1}
              />
            );
          })}
        </g>
        {circuit.els.map((e, i) => {
          const s = 2 + circuit.nIn + i;
          const on = values ? values[s] === 1 : false;
          const isOut = s >= firstOut;
          return (
            <rect
              key={s}
              x={L.x[s] - 2.5}
              y={L.y[s] - 2.5}
              width={5}
              height={5}
              rx={e.op === 0 ? 1.2 : 2.5}
              fill={on ? "#f0c869" : isOut ? "#8a7a5a" : "rgba(246,241,227,0.45)"}
            >
              <title>{`${e.op === 0 ? "NAND" : "LATCH"} #${s}${isOut ? ` · output ${outputLabels?.[s - firstOut] ?? s - firstOut}` : ""}${values ? ` = ${values[s]}` : ""}`}</title>
            </rect>
          );
        })}
        {Array.from({ length: circuit.nIn }, (_, i) => {
          const s = 2 + i;
          const on = values ? values[s] === 1 : false;
          return (
            <g key={s}>
              <circle cx={L.x[s]} cy={L.y[s]} r={3.2} fill={on ? "#f0c869" : "#5d564a"} stroke="#f6f1e3" strokeWidth={0.5} />
              {inputLabels?.[i] && (
                <text x={L.x[s] - 6} y={L.y[s] + 1.5} textAnchor="end" fontSize={4} fill="rgba(246,241,227,0.7)" fontFamily="monospace">
                  {inputLabels[i]}
                </text>
              )}
            </g>
          );
        })}
        {outputLabels &&
          outputLabels.map((lab, k) => {
            const s = firstOut + k;
            return (
              <text key={k} x={L.x[s] + 6} y={L.y[s] + 1.5} fontSize={4} fill="rgba(246,241,227,0.7)" fontFamily="monospace">
                {lab}
                {values ? `=${values[s]}` : ""}
              </text>
            );
          })}
      </svg>
    </div>
  );
});
