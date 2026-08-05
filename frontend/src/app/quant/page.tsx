"use client";

import { AlertTriangle } from "lucide-react";

import { useEffect, useState } from "react";

import { Backtester } from "@/components/Backtester";
import { Shell } from "@/components/Shell";
import { QuantSkeleton } from "@/components/Skeleton";
import { TickerInput } from "@/components/TickerInput";
import { Methodology } from "@/components/Methodology";
import { RiskLab } from "@/components/quant/RiskLab";
import { Note, PageHeader, SectionHeader, Tabs, type TabDef } from "@/components/ui";
import { VolCone } from "@/components/VolCone";
import { api, type Watchlist } from "@/lib/api";
import {
  alignReturns, betaFit, betaNote, isSignificant, matrix as buildMatrix,
  exclusionNote,
  matrixNote, readMatrix, WEAK_FIT,
  type Aligned, type BetaFit, type Matrix, type MatrixRead,
} from "@/lib/correlation";
import { tintBg } from "@/lib/heat";
import { fmtNum } from "@/lib/utils";

/** Cross-asset correlation matrix + rolling beta, computed client-side from
 *  the 1Y history series already used by the charts. */

type Series = { ticker: string; dates: string[]; closes: number[] };

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

async function fetchSeries(ticker: string): Promise<Series | null> {
  try {
    const h = await api.history(ticker, "1Y");
    const dates: string[] = [];
    const closes: number[] = [];
    for (const c of h.candles ?? []) {
      const d = pick(c, ["time", "Date", "Datetime", "date", "datetime"]);
      const cl = pick(c, ["close", "Close"]);
      if (d != null && typeof cl === "number") {
        dates.push(String(d).slice(0, 10));
        closes.push(cl);
      }
    }
    return closes.length > 30 ? { ticker, dates, closes } : null;
  } catch { return null; }
}

type QuantResult = {
  aligned: Aligned;
  matrix: Matrix;
  read: MatrixRead;
  /** Full-window fits, plus a trailing-60-day slope for regime drift. */
  betas: { full: BetaFit; recent: BetaFit }[] | null;
};

type Tab = "corr" | "bt" | "vol" | "risk";

const TABS: readonly TabDef<Tab>[] = [
  { id: "corr", label: "Correlation & beta", hint: "Pearson correlation of daily returns and rolling beta" },
  { id: "risk", label: "Risk lab", hint: "Distribution, drawdown and benchmark-relative statistics" },
  { id: "bt", label: "Backtest", hint: "Rule-based strategy over historical bars" },
  { id: "vol", label: "Volatility", hint: "Realised-volatility cone by horizon" },
];

export default function QuantPage() {
  const [tab, setTab] = useState<Tab>("corr");
  // Heavy tabs fetch on mount, so they're created on first visit and then
  // kept alive — flipping back and forth must not refetch or lose state.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [input, setInput] = useState("RELIANCE.NS, TCS.NS, HDFCBANK.NS, INFY.NS, ^NSEI");
  const [bench, setBench] = useState("^NSEI");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<QuantResult | null>(null);

  useEffect(() => {
    api.listWatchlists().then(setWatchlists).catch(() => {});
  }, []);

  // Auto-populate on first visit: restore the last-used ticker set (or keep
  // the NIFTY default) and run immediately — the page used to sit blank
  // until the user manually clicked Run.
  useEffect(() => {
    let inp = input, b = bench;
    try {
      inp = localStorage.getItem("mb_quant_input") || inp;
      b = localStorage.getItem("mb_quant_bench") || b;
      setInput(inp); setBench(b);
    } catch { /* defaults stand */ }
    run(inp, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(inputStr?: string, benchStr?: string) {
    const rawInput = inputStr ?? input;
    const rawBench = (benchStr ?? bench).trim().toUpperCase();
    try {
      localStorage.setItem("mb_quant_input", rawInput);
      localStorage.setItem("mb_quant_bench", rawBench);
    } catch { /* noop */ }
    const tickers = [...new Set(rawInput.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (tickers.length < 2) { setErr("Need at least 2 tickers."); return; }
    if (tickers.length > 12) { setErr("Max 12 tickers (12 history fetches)."); return; }
    setBusy(true); setErr(null); setResult(null);
    // A failed fetch used to be dropped here, before alignReturns could see
    // it, so the name never appeared in the grid and nothing said why. Pass
    // it through empty instead and let the exclusion report account for it.
    const fetched = await Promise.all(tickers.map(fetchSeries));
    const series: Series[] = fetched.map((s, i) =>
      s ?? { ticker: tickers[i], dates: [], closes: [] });
    if (series.filter((s) => s.dates.length).length < 2) {
      setErr("Could not load enough price history for these tickers.");
      setBusy(false); return;
    }
    const aligned = alignReturns(series);
    const m = buildMatrix(aligned);

    const bi = aligned.tickers.indexOf(rawBench);
    let betas: QuantResult["betas"] = null;
    if (bi >= 0) {
      betas = aligned.tickers
        .map((t, i) => ({
          full: betaFit(t, aligned.returns[i], aligned.returns[bi]),
          // A shorter window on purpose: drift between the two is the regime
          // change, and 30 observations is the floor everywhere else too.
          recent: betaFit(t, aligned.returns[i].slice(-60),
                          aligned.returns[bi].slice(-60)),
        }))
        .filter((r) => r.full.ticker !== rawBench);
    }
    setResult({ aligned, matrix: m, read: readMatrix(m), betas });
    setBusy(false);
  }

  function loadWatchlist(wl: Watchlist) {
    setInput([...wl.tickers, bench].join(", "));
  }

  const res = result;

  const firstTicker = input.split(/[,\s]+/).map((t) => t.trim().toUpperCase())
    .filter((t) => t && !t.startsWith("^"))[0];

  return (
    <Shell>
      <PageHeader
        title="QUANT"
        subtitle="Correlation, risk, backtesting and volatility — all computed
                  in your browser from the same 1-year history feed the charts
                  use, so nothing here depends on a server-side model." />

      <Tabs tabs={TABS} value={tab}
            onChange={(t) => { setTab(t); setOpened((o) => ({ ...o, [t]: true })); }} />

      <div className={tab === "bt" ? "" : "hidden"}>
        {opened.bt && <Backtester seedTicker={firstTicker} />}
      </div>
      <div className={tab === "vol" ? "" : "hidden"}>
        {opened.vol && <VolCone seedTicker={firstTicker} />}
      </div>
      <div className={tab === "risk" ? "" : "hidden"}>
        {opened.risk && <RiskLab seedTicker={firstTicker} />}
      </div>

      <div className={tab === "corr" ? "" : "hidden"}>
      <div className="text-mut text-xs mb-3">
        Pearson correlation of daily returns (1Y, aligned trading days) and rolling
        60-day / full-period beta vs the benchmark. Computed in your browser from
        the same history feed the charts use.
      </div>

      <div className="panel-2 p-3 mb-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-[280px]">
          <span className="label-xs">Tickers (max 12; include the benchmark)</span>
          <input value={input} onChange={(e) => setInput(e.target.value)} className="input-bare" />
          <TickerInput value="" onCommit={(t) => setInput((prev) => (prev.trim() ? `${prev.trim().replace(/,\s*$/, "")}, ${t}` : t))}
                       placeholder="Search to add a ticker…" className="input-bare !py-1 text-xs w-full" />
        </label>
        <label className="flex flex-col gap-1 w-32">
          <span className="label-xs">Benchmark</span>
          <input value={bench} onChange={(e) => setBench(e.target.value)} className="input-bare" />
        </label>
        <button onClick={() => run()} disabled={busy} className="btn-primary">{busy ? "Computing…" : "Compute"}</button>
        {watchlists.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-mut w-full">
            Load watchlist:
            {watchlists.map((wl) => (
              <button key={wl.id} onClick={() => loadWatchlist(wl)} className="btn-ghost text-xs">{wl.name}</button>
            ))}
          </div>
        )}
      </div>

      {err && (
        <div className="panel-2 p-4 mb-3 text-sm">
          <div className="text-red mb-2">{err}</div>
          <button onClick={() => run()} className="btn-ghost text-xs">Retry</button>
        </div>
      )}
      {busy && <QuantSkeleton />}
      {!busy && !err && !res && (
        <div className="panel-2 p-6 text-center text-sm text-mut">
          Enter 2–12 tickers above (include the benchmark) and hit
          <span className="text-amber"> Run</span> — or load a watchlist —
          to see the correlation matrix and betas.
        </div>
      )}

      {res && (
        <>
          {/* Four figures the grid can't show by being a grid. */}
          <div className="grid gap-2.5 mb-4"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <div className="hud p-3" title="Trading days shared by EVERY series">
              <div className="label-xs">Shared sessions</div>
              <div className={`num text-lg mt-0.5 ${
                res.aligned.shared < 60 ? "text-amber" : "text-txt"}`}>
                {res.aligned.shared}
              </div>
              {res.aligned.limitedBy && (
                <div className="text-[10px] text-mut mt-1 truncate"
                     title={`${res.aligned.limitedBy} has the shortest history`}>
                  capped by {res.aligned.limitedBy}
                </div>
              )}
            </div>
            <div className="hud p-3">
              <div className="label-xs">Average pairwise r</div>
              <div className="num text-lg mt-0.5 text-txt">
                {res.read.averageR == null ? "—" : fmtNum(res.read.averageR, 2)}
              </div>
            </div>
            <div className="hud p-3"
                 title="N / (1 + (N−1)·average r) — how many independent bets these behave like">
              <div className="label-xs">Independent bets</div>
              <div className={`num text-lg mt-0.5 ${
                (res.read.effectiveBets ?? 99) < res.read.count / 2
                  ? "text-amber" : "text-txt"}`}>
                {res.read.effectiveBets == null
                  ? "—" : fmtNum(res.read.effectiveBets, 1)}
              </div>
              <div className="text-[10px] text-mut mt-1">of {res.read.count} tickers</div>
            </div>
            <div className="hud p-3"
                 title="Below this, a correlation is not distinguishable from zero at this sample size">
              <div className="label-xs">Significance floor</div>
              <div className="num text-lg mt-0.5 text-txt">
                {res.matrix.threshold == null ? "—" : fmtNum(res.matrix.threshold, 2)}
              </div>
            </div>
          </div>

          {res.read.redundant.length > 0 && (
            <div className="hud p-3 mb-4">
              <div className="label-xs mb-1.5 text-amber">
                Effectively the same position
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                {res.read.redundant.map((p) => (
                  <span key={`${p.a}-${p.b}`} className="text-mut whitespace-nowrap">
                    {p.a.replace(".NS", "")} / {p.b.replace(".NS", "")}{" "}
                    <span className="num text-txt">{fmtNum(p.r, 2)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
          <div>
            <SectionHeader title="Correlation matrix"
                           count={`${res.matrix.n} shared sessions`} />
            {exclusionNote(res.aligned, bench) && (
              <div className="mb-2 flex items-start gap-2 rounded border border-amber/40 bg-amber/5 px-3 py-2 text-[11.5px] text-amber"
                   data-testid="excluded-banner">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  {exclusionNote(res.aligned, bench)}
                  {res.aligned.excluded.some((e) => e.ticker === bench)
                    && " The benchmark itself was excluded, so no betas could be computed against it."}
                </span>
              </div>
            )}
            <div className="panel overflow-x-auto">
              <table className="text-xs w-full" data-testid="corr-matrix">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 sticky left-0 bg-panel"></th>
                    {res.matrix.tickers.map((t) => (
                      <th key={t} className="px-2 py-1.5 text-mut font-medium whitespace-nowrap">{t.replace(".NS", "")}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.matrix.tickers.map((t, i) => (
                    <tr key={t}>
                      <td className="px-2 py-1.5 text-mut whitespace-nowrap sticky left-0 bg-bg2">{t.replace(".NS", "")}</td>
                      {res.matrix.tickers.map((u, j) => {
                        const v = res.matrix.values[i][j];
                        const weak = i !== j && !isSignificant(v, res.matrix.n);
                        return (
                          <td key={u}
                              title={weak
                                ? "Not distinguishable from zero at this sample size"
                                : undefined}
                              // Dimmed rather than dropped: an absent number
                              // reads as missing data, which is a different
                              // and worse claim than "too small to call".
                              className={`px-2 py-1.5 num text-center ${
                                weak ? "text-mut/50" : "text-txt"}`}
                              // Theme variables, not hardcoded rgba — the app
                              // has light and colourblind palettes.
                              style={{ background: i === j ? undefined
                                : tintBg(weak ? 0 : v, 1) }}>
                            {v == null ? "—" : v.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2">
              <Note>{matrixNote(res.matrix, res.read, res.aligned)}</Note>
            </div>
          </div>

          {res.betas && res.betas.length > 0 && (
            <div>
              <SectionHeader title={`Beta vs ${bench}`} />
              <div className="panel overflow-x-auto">
                <table className="w-full text-xs" data-testid="beta-table">
                  <thead className="text-mut uppercase tracking-wider">
                    <tr className="border-b border-line">
                      <th className="text-left px-3 py-2 font-medium">Ticker</th>
                      <th className="text-right px-3 py-2 font-medium">β 60d</th>
                      <th className="text-right px-3 py-2 font-medium">β full</th>
                      <th className="text-right px-3 py-2 font-medium"
                          title="Share of the ticker's variance the benchmark explains">
                        R²
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.betas.map(({ full, recent }) => {
                      const weak = (full.rSquared ?? 0) < WEAK_FIT;
                      return (
                        <tr key={full.ticker} className="border-b border-line/60 hover:bg-panel">
                          <td className="px-3 py-2 whitespace-nowrap">{full.ticker}</td>
                          <td className="px-3 py-2 num text-right">
                            {recent.beta == null ? "—" : fmtNum(recent.beta, 2)}
                          </td>
                          {/* Greyed when the fit is too weak to support the
                              slope — the number is real and means nothing. */}
                          <td className={`px-3 py-2 num text-right ${
                            weak ? "text-mut/60" : "text-txt"}`}>
                            {full.beta == null ? "—" : fmtNum(full.beta, 2)}
                          </td>
                          <td className={`px-3 py-2 num text-right ${
                            weak ? "text-red/80" : "text-mut"}`}
                              title={weak
                                ? `${bench} explains almost none of this ticker's movement`
                                : undefined}>
                            {full.rSquared == null ? "—" : fmtNum(full.rSquared, 2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2">
                <Note>{betaNote(res.betas.map((b) => b.full), bench)}</Note>
              </div>
            </div>
          )}
        </div>
        <Methodology id="correlation" className="mt-4" />
        </>
      )}
      </div>
    </Shell>
  );
}
