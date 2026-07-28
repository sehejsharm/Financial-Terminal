"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { ScrollX } from "@/components/ScrollX";
import { api, type PortfolioRow } from "@/lib/api";
import {
  alignedReturns, applyShock, estimateBeta, findWorstWindows, replayWindow,
  WEAK_R2, type BetaFit, type Series, type SeriesMap, type StressWindow,
} from "@/lib/stress";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * MARS — portfolio stress test.
 *
 * Two methods side by side: replay a real historical crash through today's
 * weights, or push a hypothetical shock through estimated betas. Both report
 * how much of the book they actually cover, because a stress number computed
 * on 60% of a portfolio is not a stress number for that portfolio.
 */

/** History fetches are one request each; past this the page stalls. */
const MAX_POSITIONS = 15;
const BENCHMARKS = [
  { sym: "^NSEI", label: "NIFTY 50" },
  { sym: "^BSESN", label: "SENSEX" },
  { sym: "^GSPC", label: "S&P 500" },
  { sym: "^IXIC", label: "Nasdaq" },
];
const SHOCKS = [-30, -20, -10, -5, 5, 10];
const WINDOW_BARS = 20;   // ~1 month of trading days

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

async function fetchSeries(ticker: string): Promise<Series | null> {
  try {
    const h = await api.history(ticker, "5Y");
    const dates: string[] = [], closes: number[] = [];
    for (const c of h.candles ?? []) {
      const d = pick(c as Record<string, unknown>, ["time", "Date", "Datetime", "date", "datetime"]);
      const cl = pick(c as Record<string, unknown>, ["close", "Close"]);
      if (d != null && typeof cl === "number") { dates.push(String(d).slice(0, 10)); closes.push(cl); }
    }
    return dates.length > 30 ? { dates, closes } : null;
  } catch { return null; }
}

function Sev({ v, cur, pct }: { v: number; cur: string; pct?: boolean }) {
  const tone = v < -0.0005 ? "text-red" : v > 0.0005 ? "text-green" : "text-mut";
  return (
    <span className={`num ${tone}`}>
      {pct ? `${v > 0 ? "+" : ""}${fmtNum(v * 100, 2)}%` : humanNumber(v, cur)}
    </span>
  );
}

export function StressTest({ positions, cur, mixedCcy }: {
  positions: PortfolioRow[]; cur: string; mixedCcy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [bench, setBench] = useState("^NSEI");
  const [shock, setShock] = useState(-10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesMap>({});
  const [benchSeries, setBenchSeries] = useState<Series | null>(null);
  const reqRef = useRef(0);

  // Biggest holdings first — if we have to truncate, truncate the tail.
  const held = useMemo(() => (positions ?? [])
    .filter((p) => (p.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)), [positions]);
  const tested = useMemo(() => held.slice(0, MAX_POSITIONS), [held]);
  const truncated = held.length - tested.length;

  const stressPositions = useMemo(
    () => tested.map((p) => ({ ticker: p.ticker, value: p.value ?? 0 })), [tested]);

  const load = useCallback(async (b: string, tickers: string[]) => {
    const req = ++reqRef.current;
    setBusy(true); setErr(null);
    try {
      const [bs, ...rest] = await Promise.all([
        fetchSeries(b), ...tickers.map(fetchSeries),
      ]);
      if (req !== reqRef.current) return;
      if (!bs) { setErr(`Could not load history for the ${b} benchmark.`); setBenchSeries(null); return; }
      setBenchSeries(bs);
      const map: SeriesMap = {};
      tickers.forEach((t, i) => { const s = rest[i]; if (s) map[t] = s; });
      setSeries(map);
    } catch (e: any) {
      if (req === reqRef.current) setErr(e?.detail || "Stress test data failed to load.");
    } finally {
      if (req === reqRef.current) setBusy(false);
    }
  }, []);

  // Keyed on the ticker LIST, not the positions array: the portfolio polls
  // for live prices, so depending on the array identity would refetch every
  // holding's 5Y history on every tick.
  const tickerKey = tested.map((p) => p.ticker).join(",");
  useEffect(() => {
    if (!open || !tickerKey) return;
    load(bench, tickerKey.split(","));
  }, [open, bench, tickerKey, load]);

  // ── historical replay ──
  const windows: StressWindow[] = useMemo(
    () => (benchSeries ? findWorstWindows(benchSeries, WINDOW_BARS, 3) : []), [benchSeries]);
  const replays = useMemo(
    () => windows.map((w) => replayWindow(stressPositions, series, w)),
    [windows, stressPositions, series]);

  // ── factor shock ──
  const fits = useMemo(() => {
    const out: Record<string, BetaFit | null> = {};
    if (!benchSeries) return out;
    for (const p of stressPositions) {
      const s = series[p.ticker];
      if (!s) { out[p.ticker] = null; continue; }
      const { a, b } = alignedReturns(s, benchSeries);
      out[p.ticker] = estimateBeta(a, b);
    }
    return out;
  }, [stressPositions, series, benchSeries]);

  const shocked = useMemo(
    () => applyShock(stressPositions, fits, shock), [stressPositions, fits, shock]);

  if (!held.length) return null;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-ghost text-xs flex items-center gap-1.5"
              title="Replay real crashes through today's weights, or push a hypothetical shock through estimated betas">
        <ShieldAlert size={12} /> Stress test
      </button>
    );
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <ShieldAlert size={14} className="text-amber" />
        <h2 className="heading">MARS — STRESS TEST</h2>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-mut">
          Benchmark
          <select value={bench} onChange={(e) => setBench(e.target.value)}
                  className="input-bare !py-0.5 text-xs">
            {BENCHMARKS.map((b) => <option key={b.sym} value={b.sym}>{b.label}</option>)}
          </select>
        </label>
        <button onClick={() => setOpen(false)} className="text-mut hover:text-txt text-xs">close</button>
      </div>

      {err && <PanelError error={err} retry={() => load(bench, tested.map((p) => p.ticker))} />}
      {busy && (
        <div className="panel-2 p-6 text-center text-xs text-mut animate-pulse">
          Loading {tested.length + 1} price histories…
        </div>
      )}

      {!busy && !err && benchSeries && (
        <>
          {/* ── hypothetical shock ── */}
          <div className="panel p-3 mb-3">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="heading">If the benchmark moves</span>
              <select value={shock} onChange={(e) => setShock(parseFloat(e.target.value))}
                      className="input-bare !py-0.5 text-xs num">
                {SHOCKS.map((s) => <option key={s} value={s}>{s > 0 ? "+" : ""}{s}%</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
              <span>
                <span className="text-mut">Book impact </span>
                <Sev v={shocked.portfolioRet} cur={cur} pct />
              </span>
              <span>
                <span className="text-mut">P&amp;L </span>
                {mixedCcy
                  ? <span className="num text-mut" title="Mixed-currency book — the sum isn't a single-currency figure">
                      {fmtNum(shocked.pnl, 0)}
                    </span>
                  : <Sev v={shocked.pnl} cur={cur} />}
              </span>
              <span className="text-xs text-mut">
                weighted beta {shocked.portfolioBeta == null ? "—" : fmtNum(shocked.portfolioBeta, 2)}
              </span>
              <span className="text-xs text-mut">
                covering {fmtNum(shocked.coveragePct, 0)}% of the book
              </span>
            </div>
            {shocked.weakFits.length > 0 && (
              <div className="text-[10.5px] text-mut mt-1.5">
                Weak fit (R² &lt; {WEAK_R2}) for {shocked.weakFits.join(", ")} — the benchmark
                barely explains how {shocked.weakFits.length === 1 ? "it moves" : "they move"},
                so their contribution above is the least trustworthy part of this number.
              </div>
            )}
          </div>

          {/* ── historical replay ── */}
          {replays.length > 0 && (
            <div className="panel p-3 mb-3">
              <div className="heading mb-2">
                Worst {WINDOW_BARS}-bar stretches for {BENCHMARKS.find((b) => b.sym === bench)?.label}
              </div>
              <ScrollX>
                <table className="w-full text-xs">
                  <thead className="text-mut uppercase tracking-wider">
                    <tr className="border-b border-line">
                      <th className="text-left px-3 py-2 font-medium">Window</th>
                      <th className="text-right px-3 py-2 font-medium">Benchmark</th>
                      <th className="text-right px-3 py-2 font-medium">This book</th>
                      <th className="text-right px-3 py-2 font-medium">P&amp;L</th>
                      <th className="text-left px-3 py-2 font-medium">Worst holding</th>
                      <th className="text-right px-3 py-2 font-medium">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {replays.map((r) => (
                      <tr key={r.window.from} className="border-b border-line/60 hover:bg-panel">
                        <td className="px-3 py-1.5 whitespace-nowrap">{r.window.label}</td>
                        <td className="px-3 py-1.5 text-right"><Sev v={r.window.benchRet} cur={cur} pct /></td>
                        <td className="px-3 py-1.5 text-right"><Sev v={r.portfolioRet} cur={cur} pct /></td>
                        <td className="px-3 py-1.5 text-right">
                          {mixedCcy ? <span className="num text-mut">{fmtNum(r.pnl, 0)}</span>
                                    : <Sev v={r.pnl} cur={cur} />}
                        </td>
                        <td className="px-3 py-1.5">
                          {r.worst
                            ? <>{r.worst.ticker.replace(".NS", "")}{" "}
                                <span className="num text-red">{fmtNum(r.worst.ret! * 100, 1)}%</span></>
                            : <span className="text-mut">—</span>}
                        </td>
                        <td className={`px-3 py-1.5 num text-right ${
                          r.coveragePct < 80 ? "text-amber" : "text-mut"}`}
                            title={r.coveragePct < 100
                              ? "Holdings without price history covering this window are excluded"
                              : "Every holding has history covering this window"}>
                          {fmtNum(r.coveragePct, 0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
              <div className="text-[10.5px] text-mut mt-2">
                Real windows found in the last 5 years of {BENCHMARKS.find((b) => b.sym === bench)?.label}
                {" "}history, non-overlapping so they are distinct events rather than the same
                crash counted three times. Each one applies TODAY&apos;s weights to what these
                holdings actually did then — it uses real co-movement, not an assumed
                correlation, but it also assumes you would have held through it unchanged.
              </div>
            </div>
          )}

          {/* ── per-holding detail ── */}
          <div className="panel mb-3">
            <div className="heading px-3 pt-3 pb-2">Per-holding sensitivity</div>
            <ScrollX>
              <table className="w-full text-xs">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line">
                    <th className="text-left px-3 py-2 font-medium">Ticker</th>
                    <th className="text-right px-3 py-2 font-medium">Weight</th>
                    <th className="text-right px-3 py-2 font-medium">Beta</th>
                    <th className="text-right px-3 py-2 font-medium">R²</th>
                    <th className="text-right px-3 py-2 font-medium">At {shock > 0 ? "+" : ""}{shock}%</th>
                    {replays[0] && <th className="text-right px-3 py-2 font-medium">Worst window</th>}
                  </tr>
                </thead>
                <tbody>
                  {shocked.legs.map((l) => {
                    const rep = replays[0]?.legs.find((x) => x.ticker === l.ticker);
                    return (
                      <tr key={l.ticker} className="border-b border-line/60 hover:bg-panel">
                        <td className="px-3 py-1.5">{l.ticker.replace(".NS", "")}</td>
                        <td className="px-3 py-1.5 num text-right text-mut">{fmtNum(l.weight * 100, 1)}%</td>
                        <td className="px-3 py-1.5 num text-right">
                          {l.fit ? fmtNum(l.fit.beta, 2)
                                 : <span className="text-mut" title="No usable price history">—</span>}
                        </td>
                        <td className={`px-3 py-1.5 num text-right ${
                          l.fit && l.fit.r2 < WEAK_R2 ? "text-amber" : "text-mut"}`}
                            title={l.fit ? `${l.fit.n} aligned daily returns` : undefined}>
                          {l.fit ? fmtNum(l.fit.r2, 2) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {l.ret == null ? <span className="text-mut">unmodelled</span>
                                         : <Sev v={l.ret} cur={cur} pct />}
                        </td>
                        {replays[0] && (
                          <td className="px-3 py-1.5 text-right">
                            {rep?.ret == null ? <span className="text-mut">—</span>
                                              : <Sev v={rep.ret} cur={cur} pct />}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollX>
          </div>

          <div className="text-[10.5px] text-mut leading-relaxed">
            Betas are OLS slopes of each holding&apos;s daily returns on the benchmark&apos;s
            over the last 5 years, with R² showing how much of that holding&apos;s movement
            the benchmark actually explains. A beta is an average-day summary, and the
            whole point of a stress event is that it is not an average day — correlations
            converge and betas rise in a crash, so the shock scenario is more likely to
            understate a real drawdown than overstate it. The historical replay avoids
            that assumption entirely, at the cost of only being able to replay what
            happened.
            {truncated > 0 && (
              <> Testing the {MAX_POSITIONS} largest holdings; {truncated} smaller
              {truncated === 1 ? " position is" : " positions are"} excluded to keep this to
              a reasonable number of history requests.</>
            )}
            {" "}Holdings without usable history are marked unmodelled and left out of the
            totals rather than assumed flat, which is why coverage is shown alongside
            every result.
          </div>
        </>
      )}
    </div>
  );
}
