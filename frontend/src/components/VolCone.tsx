"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { ScrollX } from "@/components/ScrollX";
import { TickerInput } from "@/components/TickerInput";
import { api } from "@/lib/api";
import {
  expectedMove, rankLabel, termShape, volProfile,
  type ConePoint, type VolBar, type VolProfile,
} from "@/lib/vol";
import { fmtNum } from "@/lib/utils";

/**
 * BVOL — volatility workbench.
 *
 * Realized vol, not implied: an implied surface needs a live option chain and
 * the free data path has none (yfinance's option endpoint is IP-blocked from
 * cloud hosts, NSE F&O isn't wired in). The panel says that outright rather
 * than shipping an empty surface, and delivers what the price history CAN
 * support — a full vol cone showing where today's vol sits inside this name's
 * own distribution at every horizon.
 */

const PERIODS = ["2Y", "3Y", "5Y", "10Y"] as const;

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

async function fetchBars(ticker: string, period: string): Promise<VolBar[]> {
  const h = await api.history(ticker, period);
  const out: VolBar[] = [];
  for (const c of h.candles ?? []) {
    const d = pick(c as Record<string, unknown>, ["time", "Date", "Datetime", "date", "datetime"]);
    const cl = pick(c as Record<string, unknown>, ["close", "Close"]);
    if (d != null && typeof cl === "number") out.push({ date: String(d).slice(0, 10), close: cl });
  }
  return out;
}

// ── the cone ───────────────────────────────────────────────────────────────

function ConeChart({ p }: { p: VolProfile }) {
  const W = 720, H = 260, L = 42, R = 12, T = 14, B = 30;
  const pts = p.points;
  const hi = Math.max(...pts.map((x) => Math.max(x.max, x.current))) * 1.05;
  const lo = 0;
  const x = (i: number) => L + (i / Math.max(1, pts.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);

  type Pick = (q: ConePoint) => number;
  const band = (a: Pick, b: Pick) => {
    const top = pts.map((q, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(a(q)).toFixed(1)}`).join("");
    const bot = [...pts].reverse()
      .map((q, i) => `L${x(pts.length - 1 - i).toFixed(1)},${y(b(q)).toFixed(1)}`).join("");
    return `${top}${bot}Z`;
  };
  const line = (f: Pick) =>
    pts.map((q, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f(q)).toFixed(1)}`).join("");

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[260px]">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--c-line)" strokeWidth={0.5} />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--c-mut)">
              {t.toFixed(0)}%
            </text>
          </g>
        ))}

        {/* 5-95 outer band, 25-75 inner band, median line */}
        <path d={band((q) => q.p95, (q) => q.p5)} fill="var(--c-amber)" opacity={0.09} />
        <path d={band((q) => q.p75, (q) => q.p25)} fill="var(--c-amber)" opacity={0.16} />
        <path d={line((q) => q.p50)} fill="none" stroke="var(--c-mut)" strokeWidth={1.2} strokeDasharray="4 3" />

        {/* today */}
        <path d={line((q) => q.current)} fill="none" stroke="var(--c-amber)" strokeWidth={2} />
        {pts.map((q, i) => (
          <circle key={q.window} cx={x(i)} cy={y(q.current)} r={3}
                  fill="var(--c-amber)" stroke="var(--c-bg)" strokeWidth={1}>
            <title>{`${q.window}-bar realized vol: ${fmtNum(q.current, 1)}% — ${fmtNum(q.rank, 0)}th percentile of ${q.samples} observations`}</title>
          </circle>
        ))}

        {pts.map((q, i) => (
          <text key={q.window} x={x(i)} y={H - 10} textAnchor="middle" fontSize="9" fill="var(--c-mut)">
            {q.window}
          </text>
        ))}
        <text x={(W + L) / 2} y={H - 0.5} textAnchor="middle" fontSize="8.5" fill="var(--c-mut)">
          lookback window (bars)
        </text>
      </svg>
      <div className="flex flex-wrap items-center gap-4 text-[10.5px] text-mut mt-1">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-[2px]" style={{ background: "var(--c-amber)" }} /> Today
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t border-dashed" style={{ borderColor: "var(--c-mut)" }} /> Median
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "var(--c-amber)", opacity: 0.16 }} /> 25–75th
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "var(--c-amber)", opacity: 0.09 }} /> 5–95th
        </span>
      </div>
    </div>
  );
}

function rankTone(rank: number): string {
  if (!Number.isFinite(rank)) return "text-mut";
  if (rank >= 90) return "text-red";
  if (rank >= 75) return "text-amber";
  if (rank <= 10) return "text-green";
  return "text-txt";
}

// ── main ───────────────────────────────────────────────────────────────────

export function VolCone({ seedTicker }: { seedTicker?: string }) {
  const [ticker, setTicker] = useState(seedTicker || "RELIANCE.NS");
  const [period, setPeriod] = useState<string>("3Y");
  const [bars, setBars] = useState<VolBar[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async (t: string, p: string) => {
    const sym = t.trim().toUpperCase();
    if (!sym) return;
    const req = ++reqRef.current;
    setBusy(true); setErr(null);
    try {
      const b = await fetchBars(sym, p);
      if (req !== reqRef.current) return;
      setBars(b);
      if (b.length < 40) setErr(`Only ${b.length} bars came back for ${sym} — not enough to measure volatility.`);
    } catch (e: any) {
      if (req !== reqRef.current) return;
      setBars(null);
      setErr(e?.detail || `Could not load history for ${sym}.`);
    } finally {
      if (req === reqRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(ticker, period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const p = useMemo(() => (bars ? volProfile(bars) : null), [bars]);
  const shape = p ? termShape(p) : null;
  const spot = bars?.length ? bars[bars.length - 1].close : NaN;
  // The 30-bar window is the conventional "current vol" reference point.
  const ref = p?.points.find((x) => x.window === 30) ?? p?.points[0];

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Activity size={14} className="text-amber" />
        <h2 className="heading">BVOL — VOLATILITY CONE</h2>
      </div>

      <div className="panel-2 p-3 mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 min-w-[190px]">
          <span className="label-xs">Ticker</span>
          <TickerInput value={ticker} onCommit={(t) => { setTicker(t); load(t, period); }}
                       placeholder="Search a ticker…" className="input-bare !py-1 text-xs w-full" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">History</span>
          <select value={period} onChange={(e) => { setPeriod(e.target.value); load(ticker, e.target.value); }}
                  className="input-bare !py-1 text-xs">
            {PERIODS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>

      {err && <PanelError error={err} retry={() => load(ticker, period)} />}
      {busy && <div className="panel-2 p-6 text-center text-xs text-mut animate-pulse">Loading history…</div>}
      {!busy && !err && bars && !p && (
        <div className="panel-2 p-6 text-center text-sm text-mut">
          Not enough usable history to build a cone for this name.
        </div>
      )}

      {!busy && p && ref && shape && (
        <>
          <div className="panel p-3 mb-3">
            <div className="text-sm mb-1">
              <span className="text-mut">{ref.window}-bar realized vol is </span>
              <span className={`num ${rankTone(ref.rank)}`}>{fmtNum(ref.current, 1)}%</span>
              <span className="text-mut"> — </span>
              <span className={rankTone(ref.rank)}>{rankLabel(ref.rank)}</span>
              <span className="text-mut">
                {" "}for this name, at the {fmtNum(ref.rank, 0)}th percentile of its own
                last {fmtNum(p.years, 1)} years.
              </span>
            </div>
            <div className="text-xs text-mut">
              Term structure is in <span className="text-txt">{shape.label}</span>
              {shape.label === "backwardation" && " — short-dated vol above long-dated, the shape stress usually makes"}
              {shape.label === "contango" && " — short-dated vol below long-dated, the calm-market shape"}
              {shape.label === "flat" && " — no meaningful gap between short and long horizons"}
              {" "}({fmtNum(shape.shortVol, 1)}% at {p.points[0].window} bars vs{" "}
              {fmtNum(shape.longVol, 1)}% at {p.points[p.points.length - 1].window}).
            </div>
          </div>

          <div className="panel p-3 mb-3"><ConeChart p={p} /></div>

          <div className="panel mb-3">
            <ScrollX>
              <table className="w-full text-xs">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line">
                    <th className="text-left px-3 py-2 font-medium">Window</th>
                    <th className="text-right px-3 py-2 font-medium">Today</th>
                    <th className="text-right px-3 py-2 font-medium">%ile</th>
                    <th className="text-right px-3 py-2 font-medium">Min</th>
                    <th className="text-right px-3 py-2 font-medium">5th</th>
                    <th className="text-right px-3 py-2 font-medium">25th</th>
                    <th className="text-right px-3 py-2 font-medium">Median</th>
                    <th className="text-right px-3 py-2 font-medium">75th</th>
                    <th className="text-right px-3 py-2 font-medium">95th</th>
                    <th className="text-right px-3 py-2 font-medium">Max</th>
                    <th className="text-right px-3 py-2 font-medium">1σ move</th>
                  </tr>
                </thead>
                <tbody>
                  {p.points.map((q) => (
                    <tr key={q.window} className="border-b border-line/60 hover:bg-panel">
                      <td className="px-3 py-1.5 num">{q.window}</td>
                      <td className={`px-3 py-1.5 num text-right ${rankTone(q.rank)}`}>{fmtNum(q.current, 1)}</td>
                      <td className={`px-3 py-1.5 num text-right ${rankTone(q.rank)}`}
                          title={`${q.samples} rolling observations`}>{fmtNum(q.rank, 0)}</td>
                      <td className="px-3 py-1.5 num text-right text-mut">{fmtNum(q.min, 1)}</td>
                      <td className="px-3 py-1.5 num text-right text-mut">{fmtNum(q.p5, 1)}</td>
                      <td className="px-3 py-1.5 num text-right">{fmtNum(q.p25, 1)}</td>
                      <td className="px-3 py-1.5 num text-right">{fmtNum(q.p50, 1)}</td>
                      <td className="px-3 py-1.5 num text-right">{fmtNum(q.p75, 1)}</td>
                      <td className="px-3 py-1.5 num text-right text-mut">{fmtNum(q.p95, 1)}</td>
                      <td className="px-3 py-1.5 num text-right text-mut">{fmtNum(q.max, 1)}</td>
                      <td className="px-3 py-1.5 num text-right"
                          title={`One standard deviation over ${q.window} bars at today's ${q.window}-bar vol, on a normal-distribution assumption`}>
                        {Number.isFinite(spot)
                          ? `±${fmtNum(expectedMove(spot, q.current, q.window, p.barsPerYear), 1)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </div>

          <div className="text-[10.5px] text-mut leading-relaxed">
            Close-to-close realized volatility of log returns, annualised at{" "}
            {fmtNum(p.barsPerYear, 0)} bars/year (inferred from the data — this feed
            serves weekly bars on 3Y+ windows). Percentiles are this name&apos;s own
            rolling history over {p.from} → {p.to} ({p.bars} bars), so &ldquo;elevated&rdquo;
            means elevated for this stock, not against some absolute number that
            would mean different things for a utility and a small-cap miner.
            {p.skipped.length > 0 && (
              <> Windows {p.skipped.join(", ")} are omitted: this history is too short
              to give them {" "}enough rolling observations to build a distribution from.</>
            )}
            {" "}The 1σ column is a normal-distribution approximation — real return
            distributions have fatter tails, so the true chance of a larger move is
            higher than it implies.
            <br />
            <span className="text-txt">This is realized vol, not implied.</span>{" "}
            An implied-vol surface needs a live option chain, which the free data
            path does not provide (yfinance&apos;s option endpoint is blocked from cloud
            hosts and NSE F&amp;O isn&apos;t wired in). Rather than render an empty surface,
            this shows what the price history genuinely supports.
          </div>
        </>
      )}
    </div>
  );
}
