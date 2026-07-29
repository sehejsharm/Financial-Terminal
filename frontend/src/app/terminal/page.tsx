"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense, useCallback, useEffect, useReducer, useRef, useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { AIPanel } from "@/components/AIPanel";
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
import { OptionBuilder } from "@/components/OptionBuilder";
import { OptionsChain } from "@/components/OptionsChain";
import { Ownership } from "@/components/Ownership";
import { ChartToolbar, PriceChart, useChartConfig } from "@/components/PriceChart";
import { Shell } from "@/components/Shell";
import { TerminalSkeleton } from "@/components/Skeleton";
import { TickerInput } from "@/components/TickerInput";
import { FunctionRail } from "@/components/terminal/FunctionRail";
import { QuoteHeader } from "@/components/terminal/QuoteHeader";
import { StreetRatings } from "@/components/StreetRatings";
import { ValueChainMap } from "@/components/ValueChainMap";
import { LiveNumber } from "@/components/LiveNumber";
import { Wacc } from "@/components/Wacc";
import { api, type Quote, type ResolveRec, type Snapshot } from "@/lib/api";
import { parseEntry, resolveFn, stepFn } from "@/lib/terminalFunctions";
import { useLive } from "@/lib/useLive";
import { useQuote } from "@/lib/useQuote";
import { curForTicker, fmtNum, fmtPct, formatPercent, humanNumber, inferCurrency } from "@/lib/utils";

/** The screens, their mnemonics and their order live in lib/terminalFunctions
 *  so the rail, the keyboard handling, the URL sync and the ⌘K palette all
 *  agree — a code must never mean two different things. */
type Fn = string;

const PERIODS = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y"] as const;

function TerminalInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialTicker = (sp.get("t") || "RELIANCE.NS").toUpperCase();

  const [ticker, setTicker] = useState(initialTicker);
  /** Wraps the command line so "/" can focus it without a brittle selector. */
  const cmdRef = useRef<HTMLDivElement>(null);
  const [fn, setFn] = useState<Fn>("Snapshot");

  // Keep state in sync with the URL: in-app navigations (value-chain
  // drill-down, movers links, ⌘K command line) router.push new params —
  // without this effect the query changed but the page kept old state.
  // fn accepts either a mnemonic ("DES", "CF") or the full label.
  useEffect(() => {
    const t = (sp.get("t") || "").toUpperCase();
    if (t && t !== ticker) setTicker(t);
    const label = resolveFn(sp.get("fn"));
    if (label && label !== fn) setFn(label);
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

  /** Switch screens, reflecting it in the URL so links and reloads keep it. */
  const pickFn = useCallback((label: string) => {
    setFn(label);
    const params = new URLSearchParams(sp.toString());
    params.set("t", ticker);
    params.set("fn", label);
    router.replace(`/terminal?${params.toString()}`);
  }, [router, sp, ticker]);

  /**
   * The command line. "TCS.NS" navigates, "FA" jumps screens on the current
   * name, "TCS.NS FA" does both — the way a terminal command line is expected
   * to behave.
   */
  function runEntry(raw: string) {
    const parsed = parseEntry(raw);
    switch (parsed.kind) {
      case "symbol": commitTicker(parsed.symbol); break;
      case "function": pickFn(parsed.fn); break;
      case "both": commitTicker(parsed.symbol, parsed.fn); break;
      default: break;
    }
  }

  // ── symbol history (back / forward within the terminal) ──
  // Held in a ref, not state: travel() and the push effect both read the
  // CURRENT stack, and a render closure over a state array goes stale the
  // moment two navigations land in the same tick. The version counter exists
  // only to re-render the disabled state of the two buttons.
  const histRef = useRef<{ stack: string[]; idx: number }>({ stack: [initialTicker], idx: 0 });
  const [, bumpHist] = useReducer((x: number) => x + 1, 0);
  const travelling = useRef(false);

  useEffect(() => {
    if (travelling.current) { travelling.current = false; return; }
    const h = histRef.current;
    if (h.stack[h.idx] === ticker) return;
    // A new visit truncates the forward stack, like a browser.
    const stack = [...h.stack.slice(0, h.idx + 1), ticker].slice(-25);
    histRef.current = { stack, idx: stack.length - 1 };
    bumpHist();
  }, [ticker]);

  const travel = useCallback((delta: -1 | 1) => {
    const h = histRef.current;
    const j = h.idx + delta;
    if (j < 0 || j >= h.stack.length) return;
    travelling.current = true;
    histRef.current = { ...h, idx: j };
    const sym = h.stack[j];
    setTicker(sym);
    router.replace(`/terminal?t=${encodeURIComponent(sym)}&fn=${encodeURIComponent(fn)}`);
    bumpHist();
  }, [router, fn]);

  const canBack = histRef.current.idx > 0;
  const canForward = histRef.current.idx < histRef.current.stack.length - 1;

  // ── keyboard ──
  // "/" focuses the command line, "[" / "]" cycle screens. Ignored while the
  // user is typing anywhere, so they never eat a character.
  //
  // Registered ONCE. The handler reads the current function and callback
  // through refs rather than closing over them, because re-running this
  // effect on every state change tore the listener down and re-added it —
  // and a keystroke landing in that window was silently dropped. That was a
  // real source of "I pressed it and nothing happened".
  // Flipped once the listener above is attached. The markup is server
  // rendered, so a visible rail button is NOT evidence that the shortcuts are
  // live — a keystroke sent between paint and hydration goes nowhere. This is
  // the signal the e2e suite waits on instead of guessing with a sleep.
  const [kbReady, setKbReady] = useState(false);
  const fnRef = useRef(fn);
  const pickRef = useRef(pickFn);
  useEffect(() => { fnRef.current = fn; pickRef.current = pickFn; }, [fn, pickFn]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        || el.tagName === "SELECT" || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        // A ref, not a placeholder-prefix query: the placeholder is copy and
        // will change, and focus management should not depend on it.
        cmdRef.current?.querySelector("input")?.focus();
      } else if (e.key === "[") {
        e.preventDefault(); pickRef.current(stepFn(fnRef.current, -1));
      } else if (e.key === "]") {
        e.preventDefault(); pickRef.current(stepFn(fnRef.current, 1));
      }
    }
    window.addEventListener("keydown", onKey);
    setKbReady(true);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function commitTicker(v: string, withFn?: string) {
    const t = v.trim().toUpperCase();
    if (!t) return;
    const nextFn = withFn ?? fn;
    if (withFn) setFn(withFn);
    if (t === ticker) {
      if (withFn) pickFn(withFn);
      return;
    }
    setTicker(t);
    router.replace(
      `/terminal?t=${encodeURIComponent(t)}&fn=${encodeURIComponent(nextFn)}`);
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
      {/* Command line: a symbol, a mnemonic, or both ("TCS.NS FA"). */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div ref={cmdRef} className="flex-1 min-w-[260px]"
             data-shortcuts={kbReady ? "live" : "pending"}>
          {/* No key={ticker}: TickerInput already syncs its text from the
              value prop, and remounting it on every ticker change threw away
              focus — and would discard a half-typed command. */}
          <TickerInput
            value={ticker}
            onCommit={runEntry}
            commitOnBlur={false}  /* commit = navigation here; keep it explicit */
            placeholder="Symbol, function code, or both — RELIANCE.NS · FA · TCS.NS OMON"
          />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => travel(-1)} disabled={!canBack}
                  title="Back to the previous symbol"
                  className="btn-ghost !px-2 !py-1.5 text-xs disabled:opacity-30">
            <ChevronLeft size={13} />
          </button>
          <button onClick={() => travel(1)} disabled={!canForward}
                  title="Forward"
                  className="btn-ghost !px-2 !py-1.5 text-xs disabled:opacity-30">
            <ChevronRight size={13} />
          </button>
        </div>
        <span className="text-[10px] text-mut hidden xl:inline">
          <kbd className="px-1 border border-line2 rounded">/</kbd> command ·{" "}
          <kbd className="px-1 border border-line2 rounded">[</kbd>
          <kbd className="px-1 border border-line2 rounded ml-0.5">]</kbd> cycle screens
        </span>
      </div>

      <FunctionRail active={fn} onPick={pickFn} />

      <QuoteHeader
        ticker={ticker}
        name={name}
        snap={snap}
        cur={cur}
        fallbackPrice={price}
        fallbackCp={cp}
        quoteAt={quoteLive.updatedAt}
        snapAt={snapAt}
        snapBusy={snapBusy}
        onRefresh={refreshHeader}
      />

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
            {/* Market cap and the 52-week range moved into the quote header;
                repeating them here would be two places to read the same
                number. These are what the header doesn't carry. */}
            <MetricCard label="Trailing P/E" value={fmtNum(snap?.trailing_pe as number, 1)} />
            <MetricCard label="Forward P/E"  value={fmtNum(snap?.forward_pe as number, 1)}
              title="Consensus forward earnings multiple, where the providers publish one." />
            <MetricCard label="EPS (TTM)"    value={fmtNum(snap?.eps_trailing as number, 2)} />
            <MetricCard label="Beta"         value={fmtNum(snap?.beta as number, 2)}
              title="Provider-published beta (typically ~5Y monthly returns vs the listing exchange's main index). The Quant page computes its own 60-day / 1-year daily-returns beta vs a benchmark you choose, so the two figures can differ — different lookback, frequency, and benchmark, not a data bug." />
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
              <PriceChart data={candles} height={400} config={chartCfg} symbol={ticker} />
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
              <PriceChart data={candles} height={520} config={chartCfg} symbol={ticker} />
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
      {!loading && !err && fn === "Options & Greeks" && (
        <>
          <OptionsChain ticker={ticker} />
          {/* The chain needs a live option feed the free path doesn't have;
              the builder works from theory alone, so it's always useful. */}
          <div className="mt-6 pt-6 border-t border-line">
            <OptionBuilder ticker={ticker} spot={price} />
          </div>
        </>
      )}
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
