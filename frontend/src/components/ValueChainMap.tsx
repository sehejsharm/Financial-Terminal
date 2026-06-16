"use client";

import { useEffect, useState } from "react";

import { api, type ChainNode, type ValueChain } from "@/lib/api";

/**
 * Bloomberg SPLC-style supply-chain node graph, rendered as an SVG.
 *   suppliers ──▶ [COMPANY] ──▶ customers
 *                    │
 *               competitors
 * No chart library needed — pure SVG so it stays crisp and themeable.
 */
const W = 1200;
const H = 780;
const CX = W / 2;
const CY = 340;

const COL = {
  company: "#ffb000",
  supplier: "#3b82f6",
  customer: "#22c55e",
  competitor: "#a78bfa",
};

function nodeRow(items: ChainNode[], x: number, yStart: number, yGap: number) {
  return items.map((it, i) => ({ ...it, x, y: yStart + i * yGap }));
}

function Node({ x, y, label, note, color, anchor }: {
  x: number; y: number; label: string; note?: string; color: string;
  anchor: "start" | "middle" | "end";
}) {
  return (
    <g>
      <rect x={x - 78} y={y - 16} width={156} height={32} rx={5}
            fill="#11151b" stroke={color} strokeWidth={1.4} />
      <text x={x} y={y - 1} textAnchor="middle" fontSize={12}
            fill="#e8ecf2" fontWeight={600} fontFamily="JetBrains Mono, monospace">
        {label.length > 20 ? label.slice(0, 19) + "…" : label}
      </text>
      {note && (
        <text x={x} y={y + 11} textAnchor="middle" fontSize={8.5}
              fill="#7d8694" fontFamily="JetBrains Mono, monospace">
          {note.length > 26 ? note.slice(0, 25) + "…" : note}
        </text>
      )}
    </g>
  );
}

export function ValueChainMap({ ticker }: { ticker: string }) {
  const [data, setData] = useState<ValueChain | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true); setErr(null); setData(null);
    api.valueChain(ticker)
      .then(setData)
      .catch((e) => setErr(e?.detail || "Value-chain mapping failed."))
      .finally(() => setBusy(false));
  }, [ticker]);

  if (busy) return <div className="text-mut text-xs">Mapping value chain (AI)…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;
  if (!data) return null;

  // Dynamic spacing based on how many items the AI returned.
  const supList = (data.suppliers ?? []).slice(0, 10);
  const cusList = (data.customers ?? []).slice(0, 12);
  const cmpList = (data.competitors ?? []).slice(0, 8);

  const sGap = Math.min(70, (H - 140) / Math.max(supList.length, 1));
  const cGap = Math.min(60, (H - 140) / Math.max(cusList.length, 1));

  const suppliers = supList.map((it, i) => ({ ...it, x: 170, y: 70 + i * sGap }));
  const customers = cusList.map((it, i) => ({ ...it, x: W - 170, y: 70 + i * cGap }));
  const competitors = cmpList.map((it, i, arr) => ({
    ...it,
    x: CX + (i - (arr.length - 1) / 2) * Math.min(180, (W - 200) / Math.max(arr.length, 1)),
    y: H - 60,
  }));

  return (
    <div>
      <div className="flex flex-wrap gap-4 mb-3 text-[11px] text-mut">
        <span><span style={{ color: COL.supplier }}>●</span> Suppliers</span>
        <span><span style={{ color: COL.company }}>●</span> {data.name}</span>
        <span><span style={{ color: COL.customer }}>●</span> Customers</span>
        <span><span style={{ color: COL.competitor }}>●</span> Competitors</span>
      </div>
      <div className="panel overflow-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 700 }}>
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3"
                    orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" fill="#4b5563" />
            </marker>
          </defs>

          {/* edges: supplier → company */}
          {suppliers.map((s, i) => (
            <line key={`se${i}`} x1={s.x + 78} y1={s.y} x2={CX - 90} y2={CY}
                  stroke={COL.supplier} strokeOpacity={0.35} strokeWidth={1.2} markerEnd="url(#arrow)" />
          ))}
          {/* edges: company → customer */}
          {customers.map((c, i) => (
            <line key={`ce${i}`} x1={CX + 90} y1={CY} x2={c.x - 78} y2={c.y}
                  stroke={COL.customer} strokeOpacity={0.35} strokeWidth={1.2} markerEnd="url(#arrow)" />
          ))}
          {/* edges: company ↔ competitor (dashed) */}
          {competitors.map((c, i) => (
            <line key={`ke${i}`} x1={CX} y1={CY + 26} x2={c.x} y2={c.y - 18}
                  stroke={COL.competitor} strokeOpacity={0.3} strokeWidth={1.1} strokeDasharray="4 3" />
          ))}

          {/* company node (larger) */}
          <g>
            <rect x={CX - 90} y={CY - 26} width={180} height={52} rx={7}
                  fill="#1a1206" stroke={COL.company} strokeWidth={2} />
            <text x={CX} y={CY - 4} textAnchor="middle" fontSize={15} fill={COL.company}
                  fontWeight={700} fontFamily="JetBrains Mono, monospace">{data.ticker}</text>
            <text x={CX} y={CY + 14} textAnchor="middle" fontSize={9} fill="#c9a25a"
                  fontFamily="JetBrains Mono, monospace">
              {data.name.length > 24 ? data.name.slice(0, 23) + "…" : data.name}
            </text>
          </g>

          {suppliers.map((s, i) => (
            <Node key={`s${i}`} x={s.x} y={s.y} label={s.name} note={s.note} color={COL.supplier} anchor="middle" />
          ))}
          {customers.map((c, i) => (
            <Node key={`c${i}`} x={c.x} y={c.y} label={c.name} note={c.note} color={COL.customer} anchor="middle" />
          ))}
          {competitors.map((c, i) => (
            <Node key={`k${i}`} x={c.x} y={c.y} label={c.name} note={c.note} color={COL.competitor} anchor="middle" />
          ))}
        </svg>
      </div>
      <div className="text-[10.5px] text-mut mt-2">
        AI-generated educational mapping — verify before use in research.
      </div>
    </div>
  );
}
