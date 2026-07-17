"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { AIPanel } from "@/components/AIPanel";
import { DataAge } from "@/components/DataAge";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CapitalStructureView } from "@/components/CapitalStructure";
import { Comparables } from "@/components/Comparables";
import { DebtProfile } from "@/components/DebtProfile";
import { EarningsHistory } from "@/components/EarningsHistory";
import { EstimatesView } from "@/components/Estimates";
import { Financials } from "@/components/Financials";
import { MetricCard } from "@/components/MetricCard";
import { News } from "@/components/News";
import { Notes } from "@/components/Notes";
import { OptionsChain } from "@/components/OptionsChain";
import { Ownership } from "@/components/Ownership";
import { ChartToolbar, PriceChart, useChartConfig } from "@/components/PriceChart";
import { Shell } from "@/components/Shell";
import { TerminalSkeleton } from "@/components/Skeleton";
import { TickerInput } from "@/components/TickerInput";
import { StreetRatings } from "@/components/StreetRatings";
import { ValueChainMap } from "@/components/ValueChainMap";
import { Wacc } from "@/components/Wacc";
import { api, type Quote, type ResolveRec, type Snapshot } from "@/lib/api";
import { FN_CODES } from "@/lib/commands";
import { useLive } from "@/lib/useLive";
import { curForTicker, fmtNum, fmtPct, formatPercent, humanNumber, inferCurrency } from "@/lib/utils";

const FUNCTIONS = [
  "Snapshot",
  "Technicals & charts",
  "Financials",
  "Estimates & targets",
  "Capital structure",
  "Comparables",
  "Debt profile",
  "Ownership / insiders",
  "Earnings history",
  "Street ratings",
  "WACC model",
  "Value-chain map",
  "Options & Greeks",
  "AI deep-dive",
  "Recent news",
  "Notes",
] as const;
type Fn = typeof FUNCTIONS[number];

const PERIODS = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y"] as const;

function TerminalInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialTicker = (sp.get("t") || "RELIANCE.NS").toUpperCase();

  const [ticker, setTicker] = useState(initialTicker);
  const [fn, setFn] = useState<Fn>("Snapshot");

  // Keep state in sync with the URL: in-app navigations (value-chain
  // drill-down, movers links, ⌘K command line) router.push new params —
  // without this effect the query changed but the page kept old state.
  // fn accepts either a mnemonic ("DES", "CF") or the full label.
  useEffect(() => {
    const t = (sp.get("t") || "").toUpperCase();
    if (t && t !== ticker) setTicker(t);
    const f = sp.get("fn");
    if (f) {
      const label = FN_CODES[f.toUpperCase()] ?? f;
      if ((FUNCTIONS as readonly string[]).includes(label) && label !== fn) {
        setFn(label as Fn);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  const peers = (sp.get("peers") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  // ── canonical resolution (Phase 0) ────────────────────────────────────
  // Bare inputs ("SUZLON", "TCS") resolve to exchange-qualified symbols
  // BEFORE any data loads. Ambiguous names show a picker; nothing guesses.
  const [disamb, setDisamb] = useState<ResolveRec[] | null>(null);
  const [resolvedNone, setResolvedNone] = useState(false);
  const isBare = !ticker.includes(".") && !ticker.startsWith("^");
  useEffect(() => {
    setDisamb(null);
    setResolvedNone(false);
    if (!isBare) return;
    let alive = true;
    api.resolve(ticker).then((r) => {
      if (!alive) return;
      if (r.status === "resolved" && r.match) {
        commitTicker(r.match.symbol);       // e.g. SUZLON -> SUZLON.NS
      } else if (r.status === "ambiguous") {
        setDisamb(r.candidates);
      } else if (r.status === "none") {
        // Explicit not-found: without this, junk like "ZZZZINVALID" fell
        // through to a sparse-data view with a misleading "some fields
        // unavailable" note instead of a clear "not found".
        setResolvedNone(true);
      }
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1Y");
  const [chartCfg, setChartCfg] = useChartConfig();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [candles, setCandles] = useState<any[]>([]);

  // Live quote: polls every 15s while the tab is visible (pauses hidden).
  const quoteLive = useLive<Quote>(() => api.quote(ticker), 15_000, [ticker]);
  const quote = quoteLive.data;

  // Snapshot (fundamentals): loads on ticker change; the header refresh
  // button forces past the localStorage cache.
  const loadSnap = useCallback((fresh = false) => {
    setSnapBusy(true);
    api.snapshotMeta(ticker, { fresh })
      .then((m) => { setSnap(m.data); setSnapAt(m.fetchedAt); })
      .catch(() => { /* snapshot can fail; quote alone is enough for the header */ })
      .finally(() => setSnapBusy(false));
  }, [ticker]);
  useEffect(() => { setSnap(null); setSnapAt(null); loadSnap(); }, [loadSnap]);

  function refreshHeader() { loadSnap(true); quoteLive.refresh(); }

  const loading = !quote && !snap && !quoteLive.error && !resolvedNone;
  const err = resolvedNone || (quoteLive.error && !quote && !snap)
    ? `Could not load data for ${ticker}.` : null;

  // Symbol didn't resolve — offer close matches instead of a blank page.
  const [suggestions, setSuggestions] = useState<{ symbol: string; name: string }[]>([]);
  useEffect(() => {
    if (!err) { setSuggestions([]); return; }
    let alive = true;
    api.search(ticker)
      .then((hits) => { if (alive) setSuggestions((hits ?? []).slice(0, 5)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [err, ticker]);

  // History reloads on ticker OR period change. A monotonic request id
  // guards against out-of-order responses: rapid period clicks (1D → 5D →
  // 10Y) fire overlapping fetches and the slowest one used to win, leaving
  // the chart showing stale data under a freshly-highlighted button.
  const [chartBusy, setChartBusy] = useState(false);
  const historyReq = useRef(0);
  useEffect(() => {
    const reqId = ++historyReq.current;
    setChartBusy(true);
    api.history(ticker, period)
      .then((h) => { if (historyReq.current === reqId) setCandles(h?.candles ?? []); })
      .catch(() => { if (historyReq.current === reqId) setCandles([]); })
      .finally(() => { if (historyReq.current === reqId) setChartBusy(false); });
  }, [ticker, period]);

  const cur = curForTicker(ticker, (snap?.currency as string) || quote?.currency);
  const price = (snap?.price ?? quote?.price) ?? null;
  const cp = quote?.change_pct ?? null;
  const name = (snap?.name as string) || ticker;

  function commitTicker(v: string) {
    const t = v.trim().toUpperCase();
    if (!t || t === ticker) return;
    setTicker(t);
    router.replace(`/terminal?t=${encodeURIComponent(t)}`);
    // Feed the ⌘K "Recent" group (qualified symbols only).
    if (t.includes(".") || t.startsWith("^")) {
      try {
        const r: string[] = JSON.parse(localStorage.getItem("mb_recent_tickers") || "[]");
        localStorage.setItem("mb_recent_tickers",
          JSON.stringify([t, ...r.filter((x) => x !== t)].slice(0, 10)));
      } catch { /* noop */ }
    }
  }

  return (
    <Shell>
      {/* Ticker + Function */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_280px] gap-3 mb-5">
        <TickerInput
          value={ticker}
          onCommit={commitTicker}
          commitOnBlur={false}  /* commit = navigation here; keep it explicit */
          placeholder="Ticker (RELIANCE.NS, AAPL, ^NSEI)…"
        />
        <select value={fn}
          onChange={(e) => {
            const f = e.target.value as Fn;
            setFn(f);
            // Reflect the view in the URL so reload/bookmarks/deep links keep
            // the selected tab instead of resetting to Snapshot.
            const params = new URLSearchParams(sp.toString());
            params.set("t", ticker);
            params.set("fn", f);
            router.replace(`/terminal?${params.toString()}`);
          }}
          className="input-bare cursor-pointer">
          {FUNCTIONS.map((f) => <option key={f}>{f}</option>)}
        </select>
      </div>

      {/* Header strip */}
      <div className="panel-2 p-4 mb-5 flex items-center gap-5">
        <div className="flex-1 min-w-0">
          <div className="text-amber text-xs uppercase tracking-[0.18em]">{ticker}</div>
          <div className="text-xl font-bold tracking-tight truncate">{name}</div>
          <div className="text-mut text-xs mt-0.5">
            {(snap?.sector as string) || "—"} / {(snap?.industry as string) || "—"}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <DataAge at={quoteLive.updatedAt} prefix="Quote" />
            <DataAge at={snapAt} prefix="Fundamentals" onRefresh={refreshHeader} busy={snapBusy} />
            <a href={`/tearsheet?t=${encodeURIComponent(ticker)}`} target="_blank"
               className="text-[10.5px] text-mut hover:text-amber underline decoration-dotted"
               title="Print-ready one-page tear sheet (save as PDF from the print dialog)">
              Tear sheet →
            </a>
          </div>
        </div>
        <MetricCard
          label="Price"
          value={price != null ? `${cur}${fmtNum(price, 2)}` : "—"}
          delta={cp != null ? fmtPct(cp) : null}
          tone={cp == null ? "neutral" : cp >= 0 ? "positive" : "negative"}
          className="!p-3 min-w-[160px]"
        />
      </div>

      {disamb && disamb.length > 0 && (
        <div className="panel-2 p-4 mb-5">
          <div className="text-sm mb-1">
            <span className="text-amber">{ticker}</span> matches more than one listing — pick one:
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {disamb.map((c) => (
              <button key={c.symbol} onClick={() => commitTicker(c.symbol)} className="btn-ghost text-xs">
                {c.symbol}
                <span className="text-mut normal-case"> · {c.name}{c.exchange ? ` (${c.exchange})` : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && !disamb && <TerminalSkeleton />}
      {err && !loading && !disamb && (
        <div className="panel-2 p-4">
          <div className="text-red text-sm mb-1">Symbol not found: <span className="text-amber">{ticker}</span></div>
          <div className="text-mut text-xs mb-3">
            No data provider recognizes this ticker. NSE listings need the
            <code className="text-amber"> .NS</code> suffix (RELIANCE.NS); US listings take none (AAPL).
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="label-xs">Did you mean</span>
              {suggestions.map((s) => (
                <button key={s.symbol} onClick={() => commitTicker(s.symbol)} className="btn-ghost text-xs">
                  {s.symbol} <span className="text-mut normal-case">· {s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* One failing widget must not take down the whole terminal —
          boundary resets when the function or ticker changes. */}
      <ErrorBoundary label={fn} resetKey={`${fn}:${ticker}`}>
      {!loading && !err && fn === "Snapshot" && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <MetricCard label="Market cap"   value={humanNumber(snap?.market_cap as number, cur)} />
            <MetricCard label="Trailing P/E" value={fmtNum(snap?.trailing_pe as number, 1)} />
            <MetricCard label="Beta"         value={fmtNum(snap?.beta as number, 2)}
              title="Provider-published beta (typically ~5Y monthly returns vs the listing exchange's main index). The Quant page computes its own 60-day / 1-year daily-returns beta vs a benchmark you choose, so the two figures can differ — different lookback, frequency, and benchmark, not a data bug." />
            <MetricCard
              label="52-w range"
              value={`${fmtNum(snap?.fifty_two_low as number, 2)} – ${fmtNum(snap?.fifty_two_high as number, 2)}`}
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {/* Level metrics: unsigned formatPercent — a "+" prefix falsely
                reads as a day-over-day change on what is a static level. */}
            <MetricCard label="Dividend yield" value={formatPercent(snap?.dividend_yield as number)} />
            <MetricCard label="ROE" value={formatPercent(snap?.roe as number, { fraction: true })} />
            <MetricCard label="Profit margin" value={formatPercent(snap?.profit_margin as number, { fraction: true })} />
            {/* Canonical D/E form is a ratio with "x" (matches Debt Profile);
                providers ship it percent-scaled (36.7 == 0.37x). */}
            <MetricCard label="Debt / Equity"
                        value={snap?.debt_to_equity != null ? `${fmtNum((snap.debt_to_equity as number) / 100, 2)}x` : "—"} />
          </div>
          {/* Screeners-style honesty: explain empty fields instead of bare
              dashes (free-provider coverage gaps are per-listing). */}
          {snap && [snap.dividend_yield, snap.roe, snap.profit_margin,
                    snap.debt_to_equity, snap.trailing_pe, snap.beta]
            .filter((v) => v == null).length >= 2 && (
            <div className="text-[10.5px] text-amber/90 mb-4">
              Some fields show “—” because free data providers don&apos;t cover them
              for this listing (coverage varies by exchange; FMP fills most US
              names, NSE covers Indian price/valuation but not every ratio).
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <div className="heading flex-1">Price Chart</div>
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className={`px-2 py-1 rounded text-[10.5px] tracking-wide border transition-colors ${
                  period === p ? "border-amber text-amber bg-amber/10" : "border-line2 text-mut hover:text-txt"
                }`}>{p}</button>
            ))}
          </div>
          <ChartToolbar config={chartCfg} onChange={setChartCfg} />
          <div className="relative">
            {chartBusy && (
              <div className="absolute top-2 right-2 z-10 px-2 py-0.5 rounded bg-panel2 border border-line text-[10px] text-amber animate-pulse">
                Loading {period}…
              </div>
            )}
            <div className={chartBusy ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <PriceChart data={candles} height={400} config={chartCfg} />
            </div>
          </div>
        </>
      )}

      {!loading && !err && fn === "Technicals & charts" && (
        <>
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <div className="heading flex-1">Price action</div>
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className={`px-2 py-1 rounded text-[10.5px] tracking-wide border transition-colors ${
                  period === p ? "border-amber text-amber bg-amber/10" : "border-line2 text-mut hover:text-txt"
                }`}>{p}</button>
            ))}
          </div>
          <ChartToolbar config={chartCfg} onChange={setChartCfg} />
          <div className="relative">
            {chartBusy && (
              <div className="absolute top-2 right-2 z-10 px-2 py-0.5 rounded bg-panel2 border border-line text-[10px] text-amber animate-pulse">
                Loading {period}…
              </div>
            )}
            <div className={chartBusy ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <PriceChart data={candles} height={520} config={chartCfg} />
            </div>
          </div>
        </>
      )}

      {!loading && !err && fn === "Financials" && <Financials ticker={ticker} currency={inferCurrency(ticker, snap?.currency as string)} />}
      {!loading && !err && fn === "Estimates & targets" && <EstimatesView ticker={ticker} currency={inferCurrency(ticker, snap?.currency as string)} />}
      {!loading && !err && fn === "Capital structure" && <CapitalStructureView ticker={ticker} />}
      {!loading && !err && fn === "Comparables" && <Comparables ticker={ticker} peers={peers} />}
      {!loading && !err && fn === "Debt profile" && <DebtProfile ticker={ticker} snap={snap} />}
      {!loading && !err && fn === "Ownership / insiders" && <Ownership ticker={ticker} />}
      {!loading && !err && fn === "Earnings history" && <EarningsHistory ticker={ticker} />}
      {!loading && !err && fn === "Street ratings" && <StreetRatings ticker={ticker} currency={inferCurrency(ticker, snap?.currency as string)} />}
      {!loading && !err && fn === "WACC model" && <Wacc ticker={ticker} snap={snap} />}
      {!loading && !err && fn === "Value-chain map" && <ValueChainMap ticker={ticker} />}
      {!loading && !err && fn === "Options & Greeks" && <OptionsChain ticker={ticker} />}
      {!loading && !err && fn === "AI deep-dive" && <AIPanel ticker={ticker} />}
      {!loading && !err && fn === "Recent news" && <News ticker={ticker} />}
      {!loading && !err && fn === "Notes" && <Notes ticker={ticker} />}
      </ErrorBoundary>
    </Shell>
  );
}

export default function TerminalPage() {
  return (
    <Suspense>
      <TerminalInner />
    </Suspense>
  );
}
