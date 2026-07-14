"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

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
import { OptionsChain } from "@/components/OptionsChain";
import { Ownership } from "@/components/Ownership";
import { PriceChart } from "@/components/PriceChart";
import { Shell } from "@/components/Shell";
import { StreetRatings } from "@/components/StreetRatings";
import { ValueChainMap } from "@/components/ValueChainMap";
import { Wacc } from "@/components/Wacc";
import { api, type Quote, type Snapshot } from "@/lib/api";
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
] as const;
type Fn = typeof FUNCTIONS[number];

const PERIODS = ["1M", "6M", "1Y", "5Y"] as const;

function TerminalInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialTicker = (sp.get("t") || "RELIANCE.NS").toUpperCase();

  const [ticker, setTicker] = useState(initialTicker);
  const [fn, setFn] = useState<Fn>("Snapshot");

  // Keep state in sync with the URL: in-app navigations (value-chain
  // drill-down, movers links) router.push a new ?t= — without this effect the
  // query param changed but the page kept showing the old ticker.
  useEffect(() => {
    const t = (sp.get("t") || "").toUpperCase();
    if (t && t !== ticker) setTicker(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1Y");
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

  const loading = !quote && !snap && !quoteLive.error;
  const err = quoteLive.error && !quote && !snap
    ? `Could not load data for ${ticker}.` : null;

  // History reloads on ticker OR period change.
  useEffect(() => {
    api.history(ticker, period).then((h) => setCandles(h?.candles ?? [])).catch(() => setCandles([]));
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
  }

  return (
    <Shell>
      {/* Ticker + Function */}
      <div className="grid grid-cols-[1fr_280px] gap-3 mb-5">
        <input
          defaultValue={ticker}
          key={ticker}
          onBlur={(e) => commitTicker(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commitTicker((e.target as HTMLInputElement).value); }}
          placeholder="Ticker (RELIANCE.NS, AAPL, ^NSEI)…"
          className="input-bare"
        />
        <select value={fn} onChange={(e) => setFn(e.target.value as Fn)} className="input-bare cursor-pointer">
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

      {loading && <div className="text-mut text-xs">Loading…</div>}
      {err && !loading && <div className="text-red text-sm">{err}</div>}

      {/* One failing widget must not take down the whole terminal —
          boundary resets when the function or ticker changes. */}
      <ErrorBoundary label={fn} resetKey={`${fn}:${ticker}`}>
      {!loading && !err && fn === "Snapshot" && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <MetricCard label="Market cap"   value={humanNumber(snap?.market_cap as number, cur)} />
            <MetricCard label="Trailing P/E" value={fmtNum(snap?.trailing_pe as number, 1)} />
            <MetricCard label="Beta"         value={fmtNum(snap?.beta as number, 2)} />
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
          <div className="mb-2 heading">1-Year Chart</div>
          <PriceChart data={candles} height={380} />
        </>
      )}

      {!loading && !err && fn === "Technicals & charts" && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <div className="heading flex-1">Price action</div>
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setPeriod(p)} className={`btn ${period === p ? "btn-primary" : "btn-ghost"}`}>{p}</button>
            ))}
          </div>
          <PriceChart data={candles} height={460} />
        </>
      )}

      {!loading && !err && fn === "Financials" && <Financials ticker={ticker} currency={inferCurrency(ticker, snap?.currency as string)} />}
      {!loading && !err && fn === "Estimates & targets" && <EstimatesView ticker={ticker} currency={inferCurrency(ticker, snap?.currency as string)} />}
      {!loading && !err && fn === "Capital structure" && <CapitalStructureView ticker={ticker} />}
      {!loading && !err && fn === "Comparables" && <Comparables ticker={ticker} />}
      {!loading && !err && fn === "Debt profile" && <DebtProfile ticker={ticker} snap={snap} />}
      {!loading && !err && fn === "Ownership / insiders" && <Ownership ticker={ticker} />}
      {!loading && !err && fn === "Earnings history" && <EarningsHistory ticker={ticker} />}
      {!loading && !err && fn === "Street ratings" && <StreetRatings ticker={ticker} currency={inferCurrency(ticker, snap?.currency as string)} />}
      {!loading && !err && fn === "WACC model" && <Wacc ticker={ticker} snap={snap} />}
      {!loading && !err && fn === "Value-chain map" && <ValueChainMap ticker={ticker} />}
      {!loading && !err && fn === "Options & Greeks" && <OptionsChain ticker={ticker} />}
      {!loading && !err && fn === "AI deep-dive" && <AIPanel ticker={ticker} />}
      {!loading && !err && fn === "Recent news" && <News ticker={ticker} />}
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
