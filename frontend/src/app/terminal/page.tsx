"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { PriceChart } from "@/components/PriceChart";
import { Shell } from "@/components/Shell";
import { api, type Quote, type Snapshot } from "@/lib/api";
import { cn, curSymbol, fmtNum, fmtPct, humanNumber } from "@/lib/utils";

const FUNCTIONS = ["Snapshot", "Technicals & charts", "Financials"] as const;
type Fn = typeof FUNCTIONS[number];

function TerminalInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialTicker = (sp.get("t") || "RELIANCE.NS").toUpperCase();

  const [ticker, setTicker] = useState(initialTicker);
  const [fn, setFn] = useState<Fn>("Snapshot");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [candles, setCandles] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetch on ticker change.
  useEffect(() => {
    setLoading(true); setErr(null);
    Promise.all([
      api.snapshot(ticker).catch(() => null),
      api.quote(ticker).catch(() => null),
      api.history(ticker, "1Y").catch(() => ({ candles: [] as any[] })),
    ]).then(([s, q, h]) => {
      setSnap(s); setQuote(q); setCandles(h?.candles ?? []);
      setLoading(false);
      if (!s && !q) setErr(`Could not load data for ${ticker}.`);
    });
  }, [ticker]);

  const cur = curSymbol(snap?.currency || quote?.currency || undefined);
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
          onBlur={(e) => commitTicker(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commitTicker((e.target as HTMLInputElement).value); }}
          placeholder="Ticker (RELIANCE.NS, AAPL, ^NSEI)…"
          className="input-bare"
        />
        <select
          value={fn}
          onChange={(e) => setFn(e.target.value as Fn)}
          className="input-bare cursor-pointer"
        >
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
          <div className="grid grid-cols-4 gap-3 mb-5">
            <MetricCard label="Market cap"   value={humanNumber(snap?.market_cap as number, cur)} />
            <MetricCard label="Trailing P/E" value={fmtNum(snap?.trailing_pe as number, 1)} />
            <MetricCard label="Beta"         value={fmtNum(snap?.beta as number, 2)} />
            <MetricCard
              label="52-w range"
              value={`${fmtNum(snap?.fifty_two_low as number, 2)} – ${fmtNum(snap?.fifty_two_high as number, 2)}`}
            />
          </div>
          <div className="mb-2 heading">1-Year Chart</div>
          <PriceChart data={candles} height={380} />
        </>
      )}

      {!loading && !err && fn === "Technicals & charts" && (
        <>
          <div className="mb-2 heading">Price action</div>
          <PriceChart data={candles} height={460} />
          <div className="text-mut text-xs mt-3">
            Indicators, RSI, and backtesting are wired in the Streamlit app today;
            the React version exposes the chart and a clean handoff point — extend
            in <code className="text-amber">src/app/terminal/page.tsx</code>.
          </div>
        </>
      )}

      {!loading && !err && fn === "Financials" && (
        <div className="panel-2 p-5 text-sm text-mut">
          Hook this view into <code className="text-amber">GET /api/v1/fundamentals/{`{ticker}`}/statement/{`{kind}`}</code>.
          Endpoint is live — render with a TanStack Table for full polish.
        </div>
      )}
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
