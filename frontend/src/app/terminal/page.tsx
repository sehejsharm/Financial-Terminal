"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { AIPanel } from "@/components/AIPanel";
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
import { curForTicker, fmtNum, fmtPct, humanNumber, inferCurrency } from "@/lib/utils";

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
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1Y");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [candles, setCandles] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Header data (snapshot + quote) on ticker change.
  // Stream each result independently so the page paints with whichever
  // returns first — no waiting on the slowest call.
  useEffect(() => {
    setLoading(true); setErr(null); setSnap(null); setQuote(null);
    let gotQuote = false, gotSnap = false;
    api.quote(ticker)
      .then((q) => { setQuote(q); gotQuote = true; setLoading(false); })
      .catch(() => { gotQuote = false; if (gotSnap === false && gotQuote === false) setErr(`Could not load data for ${ticker}.`); });
    api.snapshot(ticker)
      .then((s) => { setSnap(s); gotSnap = true; setLoading(false); })
      .catch(() => { /* snapshot can fail; quote alone is enough for the header */ });
  }, [ticker]);

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
            <MetricCard label="Dividend yield" value={snap?.dividend_yield != null ? fmtPct(snap.dividend_yield as number) : "—"} />
            <MetricCard label="ROE" value={snap?.roe != null ? fmtPct((snap.roe as number) * 100) : "—"} />
            <MetricCard label="Profit margin" value={snap?.profit_margin != null ? fmtPct((snap.profit_margin as number) * 100) : "—"} />
            <MetricCard label="Debt / Equity" value={fmtNum(snap?.debt_to_equity as number, 1)} />
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
