"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { ScrollX } from "@/components/ScrollX";
import { TickerInput } from "@/components/TickerInput";
import {
  gridAround, runBacktest, STRATEGIES, sweep,
  type Bar, type BacktestResult, type StrategyId, type SweepCell,
} from "@/lib/backtest";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

/**
 * BT — strategy backtester.
 *
 * Fetches the history once per ticker/period, then re-runs the (pure) engine
 * in the browser on every parameter change, so tuning is instant and costs
 * nothing. Every result is in-sample on the chosen window; the footer says so
 * rather than letting a good-looking equity curve imply otherwise.
 */

const PERIODS = ["1Y", "2Y", "3Y", "5Y", "10Y"] as const;

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

async function fetchBars(ticker: string, period: string): Promise<Bar[]> {
  const h = await api.history(ticker, period);
  const out: Bar[] = [];
  for (const c of h.candles ?? []) {
    const d = pick(c as Record<string, unknown>, ["time", "Date", "Datetime", "date", "datetime"]);
    const cl = pick(c as Record<string, unknown>, ["close", "Close"]);
    if (d != null && typeof cl === "number") out.push({ date: String(d).slice(0, 10), close: cl });
  }
  return out;
}

// ── equity curve ───────────────────────────────────────────────────────────

function EquityChart({ res }: { res: BacktestResult }) {
  const W = 720, H = 210, PAD = 4;
  const all = [...res.equity, ...res.buyHold];
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (res.equity.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  // Shaded bands for the stretches actually held — makes exposure visible
  // instead of a number you have to trust.
  const bands: { from: number; to: number }[] = [];
  let start = -1;
  res.position.forEach((p, i) => {
    if (p === 1 && start < 0) start = i;
    if (p === 0 && start >= 0) { bands.push({ from: start, to: i }); start = -1; }
  });
  if (start >= 0) bands.push({ from: start, to: res.position.length - 1 });

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[210px]" preserveAspectRatio="none">
        {bands.map((b, i) => (
          <rect key={i} x={x(b.from)} y={PAD} width={Math.max(0.7, x(b.to) - x(b.from))}
                height={H - PAD * 2} fill="var(--c-amber)" opacity={0.07} />
        ))}
        <line x1={PAD} x2={W - PAD} y1={y(1)} y2={y(1)} stroke="var(--c-line)" strokeDasharray="3 3" />
        <path d={path(res.buyHold)} fill="none" stroke="var(--c-mut)" strokeWidth={1.2} opacity={0.85} />
        <path d={path(res.equity)} fill="none" stroke="var(--c-amber)" strokeWidth={1.7} />
      </svg>
      <div className="flex flex-wrap items-center gap-4 text-[10.5px] text-mut mt-1">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-[2px]" style={{ background: "var(--c-amber)" }} /> Strategy
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-[2px]" style={{ background: "var(--c-mut)" }} /> Buy &amp; hold
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm"
                style={{ background: "var(--c-amber)", opacity: 0.14 }} /> In the market
        </span>
        <span>{res.dates[0]} → {res.dates.at(-1)}</span>
      </div>
    </div>
  );
}

// ── stats ──────────────────────────────────────────────────────────────────

function Stat({ label, value, tone, title }: {
  label: string; value: string; tone?: "up" | "down" | null; title?: string;
}) {
  return (
    <div className="panel-2 px-3 py-2" title={title}>
      <div className="label-xs">{label}</div>
      <div className={`num text-sm mt-0.5 ${
        tone === "up" ? "text-green" : tone === "down" ? "text-red" : "text-txt"}`}>
        {value}
      </div>
    </div>
  );
}

const pct = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${fmtNum(v, d)}%`;
const plain = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : fmtNum(v, d);
/** Percentages round to "-0.0"; a signed zero reads as a loss that isn't. */
const tone = (v: number | null | undefined) =>
  v == null || Math.abs(v) < 0.05 ? null : v > 0 ? ("up" as const) : ("down" as const);

// ── sweep heatmap ──────────────────────────────────────────────────────────

function SweepGrid({ cells, keyA, keyB, onPick }: {
  cells: SweepCell[]; keyA: string; keyB: string;
  onPick: (a: number, b: number) => void;
}) {
  const as = [...new Set(cells.map((c) => c.a))].sort((x, y) => x - y);
  const bs = [...new Set(cells.map((c) => c.b))].sort((x, y) => x - y);
  const vals = cells.map((c) => c.totalPct);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const at = (a: number, b: number) => cells.find((c) => c.a === a && c.b === b);
  const best = cells.reduce((m, c) => (c.totalPct > m.totalPct ? c : m), cells[0]);

  const bg = (v: number) => {
    if (v >= 0) return `rgba(0,200,120,${hi > 0 ? 0.1 + 0.5 * (v / hi) : 0.1})`;
    return `rgba(255,80,80,${lo < 0 ? 0.1 + 0.5 * (v / lo) : 0.1})`;
  };

  return (
    <div>
      <ScrollX>
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-mut font-medium text-[10px] uppercase">{keyA} \ {keyB}</th>
              {bs.map((b) => <th key={b} className="px-2 py-1 num text-mut font-medium">{b}</th>)}
            </tr>
          </thead>
          <tbody>
            {as.map((a) => (
              <tr key={a}>
                <td className="px-2 py-1 num text-mut">{a}</td>
                {bs.map((b) => {
                  const c = at(a, b);
                  if (!c) return <td key={b} className="px-2 py-1 text-center text-mut">—</td>;
                  const isBest = c.a === best.a && c.b === best.b;
                  return (
                    <td key={b} className="p-0">
                      <button onClick={() => onPick(a, b)}
                              title={`${keyA}=${a}, ${keyB}=${b} · ${c.trades} trades — click to load`}
                              className={`w-full px-2 py-1 num text-center ${
                                isBest ? "ring-1 ring-amber font-semibold" : ""}`}
                              style={{ background: bg(c.totalPct) }}>
                        {fmtNum(c.totalPct, 0)}%
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
      <div className="text-[10.5px] text-mut mt-2">
        Total return for each parameter pair on this exact window. The ringed cell
        is the best one — which is the point: if its neighbours are far worse, the
        result is a fit to this history, not an edge. A robust rule shows a broad
        plateau of similar numbers, not a lone bright square.
      </div>
    </div>
  );
}

// ── main ───────────────────────────────────────────────────────────────────

export function Backtester({ seedTicker }: { seedTicker?: string }) {
  const [ticker, setTicker] = useState(seedTicker || "RELIANCE.NS");
  const [period, setPeriod] = useState<string>("5Y");
  const [strategy, setStrategy] = useState<StrategyId>("sma_cross");
  const [params, setParams] = useState<Record<string, number>>(() =>
    Object.fromEntries(STRATEGIES[0].params.map((p) => [p.key, p.def])));
  const [costBps, setCostBps] = useState(10);

  const [bars, setBars] = useState<Bar[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sweepCells, setSweepCells] = useState<SweepCell[] | null>(null);
  const reqRef = useRef(0);

  const def = STRATEGIES.find((s) => s.id === strategy)!;

  const load = useCallback(async (t: string, p: string) => {
    const sym = t.trim().toUpperCase();
    if (!sym) return;
    const req = ++reqRef.current;
    setBusy(true); setErr(null); setSweepCells(null);
    try {
      const b = await fetchBars(sym, p);
      if (req !== reqRef.current) return;          // a newer request won
      setBars(b);
      if (b.length < 60) {
        setErr(`Only ${b.length} bars came back for ${sym} — not enough history to test on.`);
      }
    } catch (e: any) {
      if (req !== reqRef.current) return;
      setBars(null);
      setErr(e?.detail || `Could not load history for ${sym}.`);
    } finally {
      if (req === reqRef.current) setBusy(false);
    }
  }, []);

  // Initial load only — every later fetch is triggered explicitly by the
  // ticker/window controls, so re-running on their change would double-fetch.
  useEffect(() => {
    load(ticker, period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching strategy resets to that strategy's own defaults, otherwise the
  // params object carries stale keys from the previous rule.
  function chooseStrategy(id: StrategyId) {
    const s = STRATEGIES.find((x) => x.id === id)!;
    setStrategy(id);
    setParams(Object.fromEntries(s.params.map((p) => [p.key, p.def])));
    setSweepCells(null);
  }

  // Pure + memoised: every knob re-runs locally, no refetch.
  const res = useMemo(
    () => (bars ? runBacktest(bars, { strategy, params, costBps }) : null),
    [bars, strategy, params, costBps],
  );

  function runSweep() {
    if (!bars || def.params.length < 2) return;
    const [pa, pb] = def.params;
    // Step proportional to the current value: a ±35% spread around 200 is a
    // meaningful neighbourhood, the same absolute step around 12 is not.
    const step = (cur: number) => Math.max(1, Math.round(cur * 0.35));
    const va = params[pa.key] ?? pa.def;
    const vb = params[pb.key] ?? pb.def;
    setSweepCells(sweep(
      bars, strategy,
      pa.key, gridAround(va, step(va)),
      pb.key, gridAround(vb, step(vb)),
      params, costBps,
    ));
  }

  const s = res?.stats;
  const beat = s ? s.totalPct - s.buyHoldPct : null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical size={14} className="text-amber" />
        <h2 className="heading">BT — STRATEGY BACKTEST</h2>
      </div>

      {/* ── controls ── */}
      <div className="panel-2 p-3 mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 min-w-[190px]">
          <span className="label-xs">Ticker</span>
          <TickerInput value={ticker}
                       onCommit={(t) => { setTicker(t); load(t, period); }}
                       placeholder="Search a ticker…" className="input-bare !py-1 text-xs w-full" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Window</span>
          <select value={period} onChange={(e) => { setPeriod(e.target.value); load(ticker, e.target.value); }}
                  className="input-bare !py-1 text-xs">
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Strategy</span>
          <select value={strategy} onChange={(e) => chooseStrategy(e.target.value as StrategyId)}
                  className="input-bare !py-1 text-xs">
            {STRATEGIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        {def.params.map((p) => (
          <label key={p.key} className="flex flex-col gap-1 w-[86px]">
            <span className="label-xs">{p.label}</span>
            <input type="number" min={p.min} max={p.max} value={params[p.key] ?? p.def}
                   onChange={(e) => {
                     const v = parseFloat(e.target.value);
                     setParams((q) => ({ ...q, [p.key]: Number.isFinite(v) ? v : p.def }));
                     setSweepCells(null);
                   }}
                   className="input-bare !py-1 text-xs num w-full" />
          </label>
        ))}
        <label className="flex flex-col gap-1 w-[100px]"
               title="Round-turn transaction cost charged every time the position changes">
          <span className="label-xs">Cost (bps)</span>
          <input type="number" min={0} max={500} value={costBps}
                 onChange={(e) => setCostBps(Math.max(0, parseFloat(e.target.value) || 0))}
                 className="input-bare !py-1 text-xs num w-full" />
        </label>
        {def.params.length >= 2 && (
          <button onClick={runSweep} disabled={!bars || busy} className="btn-ghost text-xs disabled:opacity-40"
                  title="Re-run across a grid of neighbouring parameters">
            Sweep params
          </button>
        )}
      </div>

      <div className="text-[11px] text-mut mb-3">{def.rule}</div>

      {err && <PanelError error={err} retry={() => load(ticker, period)} />}
      {busy && <div className="panel-2 p-6 text-center text-xs text-mut animate-pulse">Loading history…</div>}

      {!busy && !err && bars && !res && (
        <div className="panel-2 p-6 text-center text-sm text-mut">
          Not enough usable bars in this window to run a test.
        </div>
      )}

      {!busy && res && s && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
            <Stat label="Strategy" value={pct(s.totalPct)} tone={tone(s.totalPct)} />
            <Stat label="Buy & hold" value={pct(s.buyHoldPct)} tone={tone(s.buyHoldPct)} />
            <Stat label="vs B&H" value={pct(beat)} tone={tone(beat)}
                  title="Total return minus buy & hold over the same window, net of costs" />
            <Stat label="CAGR" value={s.cagrPct == null ? "—" : pct(s.cagrPct)}
                  tone={tone(s.cagrPct)}
                  title={s.cagrPct == null
                    ? "Window is under 9 months — annualising it would be noise"
                    : "Compound annual growth rate over the tested window"} />
            <Stat label="Max drawdown" value={pct(s.maxDdPct)} tone={tone(s.maxDdPct)}
                  title={`Buy & hold drew down ${fmtNum(s.buyHoldMaxDdPct, 1)}% over the same window`} />
            <Stat label="Sharpe" value={plain(s.sharpe)}
                  title="Annualised return / volatility, against a 0% risk-free rate" />
            <Stat label="Sortino" value={plain(s.sortino)}
                  title="Like Sharpe but only penalising downside volatility" />
            <Stat label="Ann. vol" value={s.annVolPct.toFixed(1) + "%"} />
            <Stat label="Trades" value={String(s.trades)}
                  title="Closed round trips. An open position at the end is excluded." />
            <Stat label="Win rate" value={s.winRatePct == null ? "—" : `${fmtNum(s.winRatePct, 0)}%`}
                  title="Share of closed trades that finished green, net of costs" />
            <Stat label="Profit factor" value={plain(s.profitFactor)}
                  title="Gross winnings / gross losses across closed trades" />
            <Stat label="Exposure" value={`${fmtNum(s.exposurePct, 0)}%`}
                  title="Share of bars actually holding the position" />
          </div>

          <div className="panel p-3 mb-3"><EquityChart res={res} /></div>

          {sweepCells && sweepCells.length > 0 && (
            <div className="panel p-3 mb-3">
              <div className="heading mb-2">Parameter sweep</div>
              <SweepGrid cells={sweepCells} keyA={def.params[0].label} keyB={def.params[1].label}
                         onPick={(a, b) => setParams((q) => ({
                           ...q, [def.params[0].key]: a, [def.params[1].key]: b,
                         }))} />
            </div>
          )}

          {res.trades.length > 0 && (
            <div className="panel mb-3">
              <div className="heading px-3 pt-3 pb-2">Trades ({res.trades.length})</div>
              <ScrollX>
                <table className="w-full text-xs">
                  <thead className="text-mut uppercase tracking-wider">
                    <tr className="border-b border-line">
                      <th className="text-left px-3 py-2 font-medium">Entry</th>
                      <th className="text-right px-3 py-2 font-medium">Px</th>
                      <th className="text-left px-3 py-2 font-medium">Exit</th>
                      <th className="text-right px-3 py-2 font-medium">Px</th>
                      <th className="text-right px-3 py-2 font-medium">Bars</th>
                      <th className="text-right px-3 py-2 font-medium">Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.trades.slice(-40).reverse().map((t, i) => (
                      <tr key={`${t.entryDate}-${i}`} className="border-b border-line/60 hover:bg-panel">
                        <td className="px-3 py-1.5 whitespace-nowrap">{t.entryDate}</td>
                        <td className="px-3 py-1.5 num text-right">{fmtNum(t.entryPx, 2)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {t.open ? <span className="text-amber">open</span> : t.exitDate}
                        </td>
                        <td className="px-3 py-1.5 num text-right">
                          {t.exitPx == null ? "—" : fmtNum(t.exitPx, 2)}
                        </td>
                        <td className="px-3 py-1.5 num text-right text-mut">{t.bars}</td>
                        <td className={`px-3 py-1.5 num text-right ${
                          tone(t.retPct) === "up" ? "text-green"
                            : tone(t.retPct) === "down" ? "text-red" : ""}`}>
                          {pct(t.retPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
              {res.trades.length > 40 && (
                <div className="px-3 py-2 text-[10.5px] text-mut">
                  Showing the 40 most recent of {res.trades.length} trades.
                </div>
              )}
            </div>
          )}

          <div className="text-[10.5px] text-mut leading-relaxed">
            Signals are computed on a bar&apos;s close and acted on at the NEXT bar&apos;s
            close, so nothing is bought on information it could not have had.
            Returns are close-to-close, long or flat only — no shorting, no leverage,
            no dividends. Costs of {costBps} bps are charged round-turn on every
            position change; real slippage on an illiquid name will be worse.
            {s.barsPerYear < 100 && " This window is served as WEEKLY bars, so the test resolves to weekly decisions and annualised figures use ~52 periods."}
            {" "}Every number above is in-sample on this exact window and this exact
            parameter set — it describes what the rule would have done, which is
            not evidence of what it will do. Educational only, not advice.
          </div>
        </>
      )}
    </div>
  );
}
