"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { TickerInput } from "@/components/TickerInput";
import { api } from "@/lib/api";
import {
  drawdown, equityCurve, histogram, relativeReport, riskReport, rollingVol,
} from "@/lib/riskMetrics";
import { fmtNum } from "@/lib/utils";

/**
 * Risk lab — the full statistical profile of one name against a benchmark.
 *
 * Everything is computed in the browser from the same history the charts use,
 * so changing the window or the benchmark is instant. The maths lives in
 * lib/riskMetrics.ts and is unit-tested; this file only presents it.
 */

const PERIODS = ["1Y", "2Y", "3Y", "5Y", "10Y"] as const;
const BENCHES = [
  { sym: "^NSEI", label: "NIFTY 50" },
  { sym: "^BSESN", label: "SENSEX" },
  { sym: "^GSPC", label: "S&P 500" },
  { sym: "^IXIC", label: "Nasdaq" },
];

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

type Series = { dates: string[]; closes: number[] };

async function fetchSeries(ticker: string, period: string): Promise<Series | null> {
  const h = await api.history(ticker, period);
  const dates: string[] = [], closes: number[] = [];
  for (const c of h.candles ?? []) {
    const d = pick(c as Record<string, unknown>, ["time", "Date", "Datetime", "date", "datetime"]);
    const cl = pick(c as Record<string, unknown>, ["close", "Close"]);
    if (d != null && typeof cl === "number" && cl > 0) {
      dates.push(String(d).slice(0, 10)); closes.push(cl);
    }
  }
  return closes.length > 25 ? { dates, closes } : null;
}

/** Simple returns from closes. */
function rets(s: Series): number[] {
  const out: number[] = [];
  for (let i = 1; i < s.closes.length; i++) out.push(s.closes[i] / s.closes[i - 1] - 1);
  return out;
}

/** Returns for two series on the dates they share. */
function aligned(a: Series, b: Series): { a: number[]; b: number[] } {
  const bm = new Map(b.dates.map((d, i) => [d, b.closes[i]]));
  const ra: number[] = [], rb: number[] = [];
  let pa: number | null = null, pb: number | null = null;
  for (let i = 0; i < a.dates.length; i++) {
    const cb = bm.get(a.dates[i]), ca = a.closes[i];
    if (cb == null || !(ca > 0) || !(cb > 0)) continue;
    if (pa != null && pb != null) { ra.push(ca / pa - 1); rb.push(cb / pb - 1); }
    pa = ca; pb = cb;
  }
  return { a: ra, b: rb };
}

const yearsBetween = (a: string, b: string) => {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0
    ? (t1 - t0) / (365.2425 * 864e5) : 0;
};

// ── presentation ──────────────────────────────────────────────────────────

const n2 = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : fmtNum(v, d);
const pct = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${fmtNum(v, d)}%`;

function Metric({ label, value, tone, hint }: {
  label: string; value: string; tone?: "up" | "down" | null; hint?: string;
}) {
  return (
    <div className="hud mb-lift px-3 py-2" title={hint}>
      <div className="label-xs">{label}</div>
      <div className={`num text-[15px] mt-0.5 ${
        tone === "up" ? "text-green" : tone === "down" ? "text-red" : "text-txt"}`}>
        {value}
      </div>
    </div>
  );
}

const tone = (v: number | null | undefined, good: "high" | "low" = "high") => {
  if (v == null || !Number.isFinite(v) || Math.abs(v) < 1e-9) return null;
  const positive = good === "high" ? v > 0 : v < 0;
  return positive ? ("up" as const) : ("down" as const);
};

/** Return distribution, with the VaR threshold marked. */
function Distribution({ returns, var95 }: { returns: number[]; var95: number | null }) {
  const bins = useMemo(() => histogram(returns, 31), [returns]);
  if (!bins.length) return null;
  const W = 720, H = 150, PAD = 4;
  const maxN = Math.max(...bins.map((b) => b.count));
  const lo = bins[0].from, hi = bins[bins.length - 1].to;
  const x = (v: number) => PAD + ((v - lo) / (hi - lo || 1)) * (W - PAD * 2);
  const bw = (W - PAD * 2) / bins.length;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[150px]" preserveAspectRatio="none">
        {bins.map((b, i) => {
          const h = (b.count / maxN) * (H - 18);
          return (
            <rect key={i} x={PAD + i * bw + 0.5} width={Math.max(1, bw - 1)}
                  y={H - 14 - h} height={h}
                  fill={b.mid >= 0 ? "rgb(var(--c-green) / 0.55)" : "rgb(var(--c-red) / 0.55)"}>
              <title>{`${fmtNum(b.from * 100, 2)}% to ${fmtNum(b.to * 100, 2)}% — ${b.count} periods`}</title>
            </rect>
          );
        })}
        <line x1={x(0)} x2={x(0)} y1={0} y2={H - 14} stroke="var(--c-mut)" strokeWidth={0.8} />
        {var95 != null && (
          <>
            <line x1={x(var95 / 100)} x2={x(var95 / 100)} y1={0} y2={H - 14}
                  stroke="var(--c-red)" strokeWidth={1} strokeDasharray="3 3" />
            <text x={x(var95 / 100) + 3} y={11} fontSize="9" fill="var(--c-red)">
              VaR 95%
            </text>
          </>
        )}
      </svg>
      <div className="flex justify-between num text-[9.5px] text-mut">
        <span>{fmtNum(lo * 100, 1)}%</span>
        <span>{fmtNum(hi * 100, 1)}%</span>
      </div>
    </div>
  );
}

/** Underwater plot — how far below the prior peak, over time. */
function Underwater({ returns }: { returns: number[] }) {
  const path = useMemo(() => {
    const eq = equityCurve(returns);
    let peak = -Infinity;
    const dd = eq.map((v) => {
      peak = Math.max(peak, v);
      return peak > 0 ? (v / peak - 1) * 100 : 0;
    });
    const W = 720, H = 120;
    const worst = Math.min(-1, ...dd);
    const x = (i: number) => (i / Math.max(1, dd.length - 1)) * W;
    const y = (v: number) => 2 + (v / worst) * (H - 6);
    return {
      d: `M0,2${dd.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("")}L${W},2Z`,
      worst,
    };
  }, [returns]);

  return (
    <div>
      <svg viewBox="0 0 720 120" className="w-full h-[120px]" preserveAspectRatio="none">
        <path d={path.d} fill="rgb(var(--c-red) / 0.28)" stroke="rgb(var(--c-red) / 0.8)"
              strokeWidth={1} />
      </svg>
      <div className="text-[9.5px] text-mut num">worst {fmtNum(path.worst, 1)}%</div>
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────

export function RiskLab({ seedTicker }: { seedTicker?: string }) {
  const [ticker, setTicker] = useState(seedTicker || "RELIANCE.NS");
  const [bench, setBench] = useState("^NSEI");
  const [period, setPeriod] = useState<string>("3Y");
  const [rf, setRf] = useState(6);

  const [asset, setAsset] = useState<Series | null>(null);
  const [benchS, setBenchS] = useState<Series | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async (t: string, b: string, p: string) => {
    const sym = t.trim().toUpperCase();
    if (!sym) return;
    const req = ++reqRef.current;
    setBusy(true); setErr(null);
    try {
      const [a, bs] = await Promise.all([fetchSeries(sym, p), fetchSeries(b, p)]);
      if (req !== reqRef.current) return;
      setAsset(a); setBenchS(bs);
      if (!a) setErr(`Not enough price history for ${sym} over ${p}.`);
    } catch (e: any) {
      if (req === reqRef.current) { setAsset(null); setErr(e?.detail || "History failed to load."); }
    } finally {
      if (req === reqRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(ticker, bench, period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const r = useMemo(() => (asset ? rets(asset) : []), [asset]);
  // Inferred, never hardcoded: this feed serves WEEKLY bars on 3Y+ windows,
  // and annualising those at 252 would roughly double every risk figure.
  const ppy = useMemo(() => {
    if (!asset) return 252;
    const y = yearsBetween(asset.dates[0], asset.dates[asset.dates.length - 1]);
    return y > 0 ? Math.min(252, Math.max(4, asset.closes.length / y)) : 252;
  }, [asset]);

  const rep = useMemo(() => riskReport(r, ppy, rf / 100), [r, ppy, rf]);
  const rel = useMemo(() => {
    if (!asset || !benchS) return null;
    const al = aligned(asset, benchS);
    return relativeReport(al.a, al.b, ppy, rf / 100);
  }, [asset, benchS, ppy, rf]);
  const rvol = useMemo(
    () => rollingVol(r, Math.min(60, Math.floor(r.length / 3)), ppy), [r, ppy]);

  const benchLabel = BENCHES.find((b) => b.sym === bench)?.label ?? bench;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Activity size={14} className="text-amber" />
        <h2 className="heading">RISK LAB</h2>
      </div>

      <div className="hud p-3 mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 min-w-[180px]">
          <span className="label-xs">Instrument</span>
          <TickerInput value={ticker}
                       onCommit={(t) => { setTicker(t); load(t, bench, period); }}
                       placeholder="Search a ticker…" className="input-bare !py-1 text-xs w-full" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Benchmark</span>
          <select value={bench}
                  onChange={(e) => { setBench(e.target.value); load(ticker, e.target.value, period); }}
                  className="input-bare !py-1 text-xs">
            {BENCHES.map((b) => <option key={b.sym} value={b.sym}>{b.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Window</span>
          <select value={period}
                  onChange={(e) => { setPeriod(e.target.value); load(ticker, bench, e.target.value); }}
                  className="input-bare !py-1 text-xs">
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 w-[92px]"
               title="Annual risk-free rate, converted to a per-period rate before it's subtracted">
          <span className="label-xs">Risk-free %</span>
          <input type="number" value={rf} min={0} max={30} step={0.25}
                 onChange={(e) => setRf(Math.max(0, parseFloat(e.target.value) || 0))}
                 className="input-bare !py-1 text-xs num w-full" />
        </label>
      </div>

      {err && <PanelError error={err} retry={() => load(ticker, bench, period)} />}
      {busy && (
        <div className="hud mb-loading p-6 text-center text-xs text-mut">
          Loading history for {ticker} and {benchLabel}…
        </div>
      )}

      {!busy && !err && rep.n >= 20 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3 mb-stagger">
            <Metric label="Total return" value={pct(rep.totalPct, 1)} tone={tone(rep.totalPct)} />
            <Metric label="CAGR" value={pct(rep.cagrPct, 1)} tone={tone(rep.cagrPct)} />
            <Metric label="Ann. volatility" value={`${n2(rep.annVolPct, 1)}%`} />
            <Metric label="Sharpe" value={n2(rep.sharpe)} tone={tone(rep.sharpe)}
                    hint={`Excess return over ${rf}% a year, per unit of total volatility`} />
            <Metric label="Sortino" value={n2(rep.sortino)} tone={tone(rep.sortino)}
                    hint="Like Sharpe, but only downside deviation is penalised" />
            <Metric label="Calmar" value={n2(rep.calmar)} tone={tone(rep.calmar)}
                    hint="CAGR divided by the maximum drawdown" />

            <Metric label="Max drawdown" value={pct(rep.maxDdPct, 1)} tone={tone(rep.maxDdPct)}
                    hint={`Longest stretch below a prior peak: ${rep.maxDdPeriods ?? "—"} periods`} />
            <Metric label="VaR 95%" value={pct(rep.var95Pct, 2)} tone="down"
                    hint="Historical 5th percentile — one period in twenty was at least this bad" />
            <Metric label="CVaR 95%" value={pct(rep.cvar95Pct, 2)} tone="down"
                    hint="Average loss across the worst 5% of periods" />
            <Metric label="Hit rate" value={`${n2(rep.hitRatePct, 0)}%`}
                    hint="Share of periods that finished positive" />
            <Metric label="Skew" value={n2(rep.skew)}
                    hint="Negative means the left tail is longer — losses are more extreme than gains" />
            <Metric label="Excess kurtosis" value={n2(rep.kurtosis)}
                    hint="Above 0 means fatter tails than a normal distribution" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
            <div className="hud p-3">
              <div className="label-xs mb-1.5">Return distribution</div>
              <Distribution returns={r} var95={rep.var95Pct} />
            </div>
            <div className="hud p-3">
              <div className="label-xs mb-1.5">Underwater (drawdown from peak)</div>
              <Underwater returns={r} />
            </div>
          </div>

          {rel && rel.beta != null && (
            <>
              <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-line2">
                <h3 className="heading">vs {benchLabel}</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3 mb-stagger">
                <Metric label="Beta" value={n2(rel.beta)}
                        hint="Sensitivity to the benchmark's moves" />
                <Metric label="Alpha (ann.)" value={pct(rel.alphaPct, 2)} tone={tone(rel.alphaPct)}
                        hint="Jensen's alpha — return beyond what beta alone explains" />
                <Metric label="R²" value={n2(rel.r2)}
                        hint="How much of the movement the benchmark explains" />
                <Metric label="Tracking error" value={`${n2(rel.trackingErrorPct, 2)}%`}
                        hint="Annualised volatility of the return difference" />
                <Metric label="Info ratio" value={n2(rel.informationRatio)}
                        tone={tone(rel.informationRatio)}
                        hint="Excess return over the benchmark per unit of tracking error" />
                <Metric label="Up / down capture"
                        value={`${n2(rel.upCapturePct, 0)} / ${n2(rel.downCapturePct, 0)}%`}
                        hint="Share of the benchmark's gain captured on its up periods, and of its loss on down ones" />
              </div>
            </>
          )}

          <div className="text-[10.5px] text-mut leading-relaxed">
            Computed from {rep.n} periods over {fmtNum(rep.years ?? 0, 1)} years,
            annualised at {fmtNum(ppy, 0)} periods per year — inferred from the
            data, because this feed serves <span className="text-txt">weekly</span> bars
            on 3Y and longer windows and annualising those at 252 would roughly
            double every figure here. VaR and CVaR are historical percentiles of
            what actually happened, not a fitted distribution, so they say nothing
            about a loss larger than the worst in this window. Past behaviour is a
            description, not a forecast.
            {rvol.filter((v) => v != null).length > 0 && (
              <> Rolling volatility over this window ranged{" "}
                {fmtNum(Math.min(...rvol.filter((v): v is number => v != null)), 1)}% to{" "}
                {fmtNum(Math.max(...rvol.filter((v): v is number => v != null)), 1)}%.</>
            )}
          </div>
        </>
      )}

      {!busy && !err && asset && rep.n < 20 && (
        <div className="hud p-5 text-mut text-sm">
          Only {rep.n} usable periods in this window — too few to report risk
          statistics that mean anything. Try a longer window.
        </div>
      )}
    </div>
  );
}
