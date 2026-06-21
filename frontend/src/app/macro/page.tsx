"use client";

import { useEffect, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { api, type Indicator, type YieldPoint } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

const COUNTRY_LABELS: Record<string, { label: string; flag: string }> = {
  US: { label: "United States", flag: "🇺🇸" },
  IN: { label: "India", flag: "🇮🇳" },
  EU: { label: "Eurozone", flag: "🇪🇺" },
  UK: { label: "United Kingdom", flag: "🇬🇧" },
  JP: { label: "Japan", flag: "🇯🇵" },
  CN: { label: "China", flag: "🇨🇳" },
};

function YieldCurveChart({ points }: { points: YieldPoint[] }) {
  if (!points.length) return null;
  const W = 760, H = 280, padX = 52, padY = 34;
  const ys = points.map((p) => p.yield);
  const yMin = Math.min(...ys) - 0.25, yMax = Math.max(...ys) + 0.25;
  // Even (categorical) spacing by maturity — a yield curve is read left→right by
  // tenor, not by absolute years, so 1M…3Y don't bunch up on the far left.
  const n = points.length;
  const sx = (i: number) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (W - 2 * padX);
  const sy = (y: number) => H - padY - ((y - yMin) / (yMax - yMin || 1)) * (H - 2 * padY);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(i).toFixed(1)} ${sy(p.yield).toFixed(1)}`).join(" ");
  const inverted = ys[0] > ys[ys.length - 1];
  const stroke = inverted ? "#ff4d4f" : "#ffb000";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet" style={{ minWidth: 600 }}>
      {[0, 1, 2, 3, 4].map((i) => {
        const y = padY + (i * (H - 2 * padY)) / 4;
        const v = yMax - (i * (yMax - yMin)) / 4;
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={W - padX} y2={y} stroke="#1c2129" strokeWidth={1} />
            <text x={padX - 8} y={y + 4} textAnchor="end" fontSize={10} fill="#7d8694"
                  fontFamily="JetBrains Mono, monospace">{v.toFixed(2)}%</text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke={stroke} strokeWidth={2.5} />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={sx(i)} cy={sy(p.yield)} r={3.5} fill={stroke} />
          <text x={sx(i)} y={sy(p.yield) - 10} textAnchor="middle" fontSize={9}
                fill="#cdd1d8" fontFamily="JetBrains Mono, monospace">{p.yield.toFixed(2)}</text>
          <text x={sx(i)} y={H - 10} textAnchor="middle" fontSize={10} fill="#7d8694"
                fontFamily="JetBrains Mono, monospace">{p.maturity}</text>
        </g>
      ))}
    </svg>
  );
}

export default function MacroPage() {
  const [countries, setCountries] = useState<string[]>(["US", "IN", "EU", "UK", "JP", "CN"]);
  const [country, setCountry] = useState("US");
  const [inds, setInds] = useState<Indicator[] | null>(null);
  const [curve, setCurve] = useState<YieldPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.macroCountries().then(setCountries).catch(() => {});
    api.yieldCurve().then(setCurve).catch(() => setCurve([]));
  }, []);

  useEffect(() => {
    setBusy(true); setErr(null); setInds(null);
    api.macroIndicators(country)
      .then(setInds)
      .catch((e) => setErr(e?.detail || "Macro feed unavailable."))
      .finally(() => setBusy(false));
  }, [country]);

  const inversion = curve && curve.length >= 2 ? curve[0].yield > curve[curve.length - 1].yield : false;
  const spread10y2y = (() => {
    if (!curve) return null;
    const y2 = curve.find((p) => p.maturity === "2Y")?.yield;
    const y10 = curve.find((p) => p.maturity === "10Y")?.yield;
    return y2 != null && y10 != null ? y10 - y2 : null;
  })();

  return (
    <Shell>
      <div className="flex items-end justify-between mb-4">
        <h1 className="heading">MACRO</h1>
        <div className="flex flex-wrap gap-1.5">
          {countries.map((c) => (
            <button key={c} onClick={() => setCountry(c)}
                    className={`btn ${country === c ? "btn-primary" : "btn-ghost"}`}>
              <span className="mr-1">{COUNTRY_LABELS[c]?.flag ?? ""}</span>
              {COUNTRY_LABELS[c]?.label ?? c}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="panel-2 p-4 text-sm text-mut mb-4">
          {err} Add <code className="text-amber">FRED_API_KEY</code> to the backend env.
          Free key at <a className="text-amber underline" href="https://fredaccount.stlouisfed.org/apikeys" target="_blank" rel="noopener noreferrer">fredaccount.stlouisfed.org</a>.
        </div>
      )}

      {busy && <div className="text-mut text-xs">Loading {COUNTRY_LABELS[country]?.label ?? country} indicators…</div>}

      {inds && (
        <>
          <div className="heading mb-2">Key indicators — {COUNTRY_LABELS[country]?.label ?? country}</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
            {inds.map((ind) => (
              <div key={ind.name} className="panel-2 p-3.5 flex flex-col gap-1">
                <div className="label-xs">{ind.name}</div>
                <div className="num text-xl text-white">
                  {ind.value != null ? `${fmtNum(ind.value, 2)}${ind.unit === "%" ? "%" : ""}` : "—"}
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className={ind.change == null ? "text-mut" : ind.change >= 0 ? "text-green" : "text-red"}>
                    {ind.change != null ? `${ind.change >= 0 ? "▲" : "▼"} ${Math.abs(ind.change).toFixed(2)}` : "—"}
                  </span>
                  <span className="text-mut">{ind.date ?? ""}</span>
                </div>
                <div className="text-[10px] text-mut">prior {ind.prior != null ? fmtNum(ind.prior, 2) : "—"} · {ind.unit}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {curve && curve.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="heading">US Treasury yield curve</div>
            <div className="flex gap-3 text-[11px]">
              {spread10y2y != null && (
                <span className={spread10y2y < 0 ? "text-red" : "text-mut"}>
                  10Y–2Y <span className="num">{spread10y2y >= 0 ? "+" : ""}{spread10y2y.toFixed(2)}%</span>
                </span>
              )}
              <span className={inversion ? "text-red" : "text-green"}>
                {inversion ? "INVERTED" : "NORMAL"}
              </span>
            </div>
          </div>
          <div className="panel-2 p-4 mb-4"><YieldCurveChart points={curve} /></div>
          <div className="text-[10.5px] text-mut">
            An inverted curve (short rates above long rates) has historically preceded recessions.
            10Y–2Y is the spread most often cited as a signal.
          </div>
        </>
      )}
    </Shell>
  );
}
