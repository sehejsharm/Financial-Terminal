"use client";

import { useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { QuantSkeleton } from "@/components/Skeleton";
import { TickerInput } from "@/components/TickerInput";
import { api, type Watchlist } from "@/lib/api";
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

/** Align series on shared dates, return daily returns per ticker. */
function alignedReturns(series: Series[]): { tickers: string[]; returns: number[][] } {
  const common = series
    .map((s) => new Set(s.dates))
    .reduce((a, b) => new Set([...a].filter((d) => b.has(d))));
  const dates = [...common].sort();
  const rets: number[][] = series.map((s) => {
    const byDate = new Map(s.dates.map((d, i) => [d, s.closes[i]]));
    const px = dates.map((d) => byDate.get(d)!);
    const r: number[] = [];
    for (let i = 1; i < px.length; i++) r.push(px[i] / px[i - 1] - 1);
    return r;
  });
  return { tickers: series.map((s) => s.ticker), returns: rets };
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function beta(asset: number[], bench: number[]): number {
  const n = Math.min(asset.length, bench.length);
  if (n < 10) return NaN;
  const mb = bench.reduce((x, y) => x + y, 0) / n;
  const ma = asset.reduce((x, y) => x + y, 0) / n;
  let cov = 0, varb = 0;
  for (let i = 0; i < n; i++) {
    cov += (asset[i] - ma) * (bench[i] - mb);
    varb += (bench[i] - mb) ** 2;
  }
  return cov / varb;
}

function corrColor(v: number): string {
  if (Number.isNaN(v)) return "transparent";
  // negative -> blue, positive -> amber/red
  const a = Math.min(1, Math.abs(v));
  return v >= 0 ? `rgba(255,176,0,${0.12 + a * 0.5})` : `rgba(59,130,246,${0.12 + a * 0.5})`;
}

type QuantResult = {
  tickers: string[];
  matrix: number[][];
  betas: { ticker: string; b60: number; bfull: number }[] | null;
};

export default function QuantPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [input, setInput] = useState("RELIANCE.NS, TCS.NS, HDFCBANK.NS, INFY.NS, ^NSEI");
  const [bench, setBench] = useState("^NSEI");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<QuantResult | null>(null);

  useEffect(() => {
    api.listWatchlists().then(setWatchlists).catch(() => {});
  }, []);

  async function run() {
    const tickers = [...new Set(input.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (tickers.length < 2) { setErr("Need at least 2 tickers."); return; }
    if (tickers.length > 12) { setErr("Max 12 tickers (12 history fetches)."); return; }
    setBusy(true); setErr(null); setResult(null);
    const series = (await Promise.all(tickers.map(fetchSeries))).filter(Boolean) as Series[];
    if (series.length < 2) {
      setErr("Could not load enough price history for these tickers.");
      setBusy(false); return;
    }
    const { tickers: ts, returns } = alignedReturns(series);
    const matrix = ts.map((_, i) => ts.map((_, j) => pearson(returns[i], returns[j])));

    const bi = ts.indexOf(bench.trim().toUpperCase());
    let betas: QuantResult["betas"] = null;
    if (bi >= 0) {
      betas = ts
        .map((t, i) => ({
          ticker: t,
          b60: beta(returns[i].slice(-60), returns[bi].slice(-60)),
          bfull: beta(returns[i], returns[bi]),
        }))
        .filter((r) => r.ticker !== bench.trim().toUpperCase());
    }
    setResult({ tickers: ts, matrix, betas });
    setBusy(false);
  }

  function loadWatchlist(wl: Watchlist) {
    setInput([...wl.tickers, bench].join(", "));
  }

  const res = result;

  return (
    <Shell>
      <h1 className="heading mb-3">QUANT — CORRELATION & BETA</h1>
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
        <button onClick={run} disabled={busy} className="btn-primary">{busy ? "Computing…" : "Compute"}</button>
        {watchlists.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-mut w-full">
            Load watchlist:
            {watchlists.map((wl) => (
              <button key={wl.id} onClick={() => loadWatchlist(wl)} className="btn-ghost text-xs">{wl.name}</button>
            ))}
          </div>
        )}
      </div>

      {err && <div className="text-red text-sm mb-3">{err}</div>}
      {busy && <QuantSkeleton />}

      {res && (
        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
          <div>
            <div className="heading mb-2">Correlation matrix (1Y daily returns)</div>
            <div className="panel overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 sticky left-0 bg-panel"></th>
                    {res.tickers.map((t) => (
                      <th key={t} className="px-2 py-1.5 text-mut font-medium whitespace-nowrap">{t.replace(".NS", "")}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.tickers.map((t, i) => (
                    <tr key={t}>
                      <td className="px-2 py-1.5 text-mut whitespace-nowrap sticky left-0 bg-bg2">{t.replace(".NS", "")}</td>
                      {res.tickers.map((u, j) => (
                        <td key={u} className="px-2 py-1.5 num text-center"
                            style={{ background: corrColor(res.matrix[i][j]) }}>
                          {Number.isNaN(res.matrix[i][j]) ? "—" : res.matrix[i][j].toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {res.betas && res.betas.length > 0 && (
            <div>
              <div className="heading mb-2">Beta vs {bench}</div>
              <div className="panel overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-mut uppercase tracking-wider">
                    <tr className="border-b border-line">
                      <th className="text-left px-3 py-2 font-medium">Ticker</th>
                      <th className="text-right px-3 py-2 font-medium">β 60d</th>
                      <th className="text-right px-3 py-2 font-medium">β 1Y</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.betas.map((b) => (
                      <tr key={b.ticker} className="border-b border-line/60 hover:bg-panel">
                        <td className="px-3 py-2">{b.ticker}</td>
                        <td className="px-3 py-2 num text-right">{Number.isNaN(b.b60) ? "—" : fmtNum(b.b60, 2)}</td>
                        <td className="px-3 py-2 num text-right">{Number.isNaN(b.bfull) ? "—" : fmtNum(b.bfull, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[10.5px] text-mut mt-2">
                β 60d uses the trailing 60 trading days; drift between the two
                columns shows regime change. Computed here from daily returns
                vs {bench} — this will differ from the Terminal&apos;s Snapshot/WACC
                beta, which is the data provider&apos;s published figure (typically
                ~5Y monthly returns vs the listing exchange&apos;s main index).
              </div>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
