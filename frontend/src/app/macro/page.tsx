"use client";

import { useEffect, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { api, type Indicator, type YieldPoint } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

function YieldCurveChart({ points }: { points: YieldPoint[] }) {
  if (!points.length) return null;
  const W = 760;
  const H = 280;
  const padX = 40, padY = 24;
  const xs = points.map((p) => p.years);
  const ys = points.map((p) => p.yield);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys) - 0.5, yMax = Math.max(...ys) + 0.5;
  const sx = (x: number) => padX + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * padX);
  const sy = (y: number) => H - padY - ((y - yMin) / (yMax - yMin || 1)) * (H - 2 * padY);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.years)} ${sy(p.yield)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 600 }}>
      {[0, 1, 2, 3, 4].map((i) => {
        const y = padY + (i * (H - 2 * padY)) / 4;
        const v = yMax - (i * (yMax - yMin)) / 4;
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={W - padX} y2={y} stroke="#1c2129" strokeWidth={1} />
            <text x={padX - 6} y={y + 4} textAnchor="end" fontSize={10} fill="#7d8694"
                  fontFamily="JetBrains Mono, monospace">{v.toFixed(2)}%</text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke="#ffb000" strokeWidth={2} />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={sx(p.years)} cy={sy(p.yield)} r={3} fill="#ffb000" />
          <text x={sx(p.years)} y={H - 6} textAnchor="middle" fontSize={10} fill="#7d8694"
                fontFamily="JetBrains Mono, monospace">{p.maturity}</text>
        </g>
      ))}
    </svg>
  );
}

export default function MacroPage() {
  const [inds, setInds] = useState<Indicator[] | null>(null);
  const [curve, setCurve] = useState<YieldPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.macroIndicators().then(setInds).catch((e) => setErr(e?.detail || "Macro feed unavailable."));
    api.yieldCurve().then(setCurve).catch(() => setCurve([]));
  }, []);

  return (
    <Shell>
      <h1 className="heading mb-3">MACRO</h1>
      {err && (
        <div className="panel-2 p-4 text-sm text-mut mb-4">
          {err} Add <code className="text-amber">FRED_API_KEY</code> to the backend env to enable.
          Free key at <a className="text-amber underline" href="https://fredaccount.stlouisfed.org/apikeys" target="_blank" rel="noopener noreferrer">fredaccount.stlouisfed.org</a>.
        </div>
      )}
      {inds && (
        <>
          <div className="heading mb-2">Key indicators</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
            {inds.map((ind) => (
              <MetricCard
                key={ind.name}
                label={`${ind.name} (${ind.unit})`}
                value={ind.value != null ? fmtNum(ind.value, 2) : "—"}
                delta={ind.change != null ? `${ind.change >= 0 ? "+" : ""}${ind.change.toFixed(2)}` : null}
                tone={ind.change == null ? "neutral" : ind.change >= 0 ? "positive" : "negative"}
              />
            ))}
          </div>
        </>
      )}
      {curve && curve.length > 0 && (
        <>
          <div className="heading mb-2">US Treasury yield curve</div>
          <div className="panel-2 p-4 mb-4"><YieldCurveChart points={curve} /></div>
        </>
      )}
    </Shell>
  );
}
