"use client";

import { useEffect, useState } from "react";

import { AIPanel } from "@/components/AIPanel";
import { Backtester } from "@/components/Backtester";
import { CapitalStructureView } from "@/components/CapitalStructure";
import { Comparables } from "@/components/Comparables";
import { ContagionPathFinder } from "@/components/ContagionPath";
import { DebtProfile } from "@/components/DebtProfile";
import { EarningsHistory } from "@/components/EarningsHistory";
import { EstimatesView } from "@/components/Estimates";
import { Financials } from "@/components/Financials";
import { LiveNumber } from "@/components/LiveNumber";
import { News } from "@/components/News";
import { Notes } from "@/components/Notes";
import { OptionBuilder } from "@/components/OptionBuilder";
import { OptionsChain } from "@/components/OptionsChain";
import { Ownership } from "@/components/Ownership";
import { PanelError } from "@/components/PanelStates";
import { PriceChart } from "@/components/PriceChart";
import { StreetRatings } from "@/components/StreetRatings";
import { ValueChainMap } from "@/components/ValueChainMap";
import { VolCone } from "@/components/VolCone";
import { Wacc } from "@/components/Wacc";
import { MoversBoard } from "@/components/dashboard/MoversBoard";
import { WatchlistBoard } from "@/components/dashboard/WatchlistBoard";
import { api, type Snapshot } from "@/lib/api";
import { useQuote } from "@/lib/useQuote";
import { curForTicker, fmtNum, humanNumber, inferCurrency } from "@/lib/utils";

/**
 * Renders one pane's widget.
 *
 * Several widgets need a snapshot (WACC and the debt profile take one as a
 * prop), so this fetches it once per pane and shares it rather than making
 * each child re-request. Every fetch is guarded against the stale-response
 * race: retarget a linked group quickly and an older, slower response must
 * not overwrite the newer one.
 */

function useSnapshot(ticker: string, enabled: boolean) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setSnap(null); setErr(null);
    api.snapshot(ticker)
      .then((s) => { if (alive) setSnap(s); })
      .catch((e: any) => { if (alive) setErr(e?.detail || "Snapshot unavailable."); });
    return () => { alive = false; };
  }, [ticker, enabled, epoch]);
  return { snap, err, retry: () => setEpoch((n) => n + 1) };
}

// ── small in-pane widgets ─────────────────────────────────────────────────

/** A compact live quote strip — the cheapest useful pane there is. */
function QuoteStrip({ ticker }: { ticker: string }) {
  const t = useQuote(ticker);
  const cur = curForTicker(ticker, t?.ccy);
  const cp = t?.chgPct ?? null;
  const up = cp != null && cp >= 0;
  const cell = (label: string, node: React.ReactNode) => (
    <div className="px-3 py-2 border-r border-line last:border-r-0 min-w-[86px]">
      <div className="label-xs">{label}</div>
      <div className="num text-sm mt-0.5">{node}</div>
    </div>
  );
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="num text-2xl text-txt">
          {t?.ltp != null
            ? <LiveNumber value={t.ltp} format="price" ccy={cur} />
            : <span className="text-mut">···</span>}
        </span>
        {cp != null && (
          <span className={`num text-sm ${up ? "text-green" : "text-red"}`}>
            {up ? "▲" : "▼"} <LiveNumber value={cp} format="pct" />
            {t?.chg != null && <span className="text-mut ml-2">{fmtNum(Math.abs(t.chg), 2)}</span>}
          </span>
        )}
      </div>
      <div className="hud flex flex-wrap">
        {cell("Bid", t?.bid != null ? fmtNum(t.bid, 2) : "—")}
        {cell("Ask", t?.ask != null ? fmtNum(t.ask, 2) : "—")}
        {cell("Volume", t?.vol != null ? humanNumber(t.vol) : "—")}
        {cell("Source", <span className="text-[11px] text-mut uppercase">{t?.src ?? "—"}</span>)}
      </div>
      {t?.stale && (
        <div className="text-[10.5px] text-amber mt-2">
          Marked stale by the feed — this is the last value received, not a live one.
        </div>
      )}
    </div>
  );
}

function ChartPane({ ticker }: { ticker: string }) {
  const [candles, setCandles] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let alive = true;
    setCandles(null); setErr(null);
    api.history(ticker, "1Y")
      .then((h) => { if (alive) setCandles(h?.candles ?? []); })
      .catch((e: any) => {
        if (alive) { setCandles([]); setErr(e?.detail || "Chart data failed to load."); }
      });
    return () => { alive = false; };
  }, [ticker, epoch]);

  if (candles === null) {
    return <div className="text-mut text-xs animate-pulse py-6 text-center">Loading chart…</div>;
  }
  if (err || candles.length === 0) {
    return (
      <PanelError error={err ?? `No chart data for ${ticker} right now.`}
                  retry={() => setEpoch((n) => n + 1)} />
    );
  }
  return <PriceChart data={candles} height={300} symbol={ticker} />;
}

function SnapshotPane({ ticker }: { ticker: string }) {
  const { snap, err, retry } = useSnapshot(ticker, true);
  if (err) return <PanelError error={err} retry={retry} />;
  if (!snap) return <div className="text-mut text-xs animate-pulse py-4">Loading…</div>;
  const rows: [string, string][] = [
    ["Market cap", humanNumber(snap.market_cap as number)],
    ["P/E", fmtNum(snap.trailing_pe as number, 1)],
    ["Beta", fmtNum(snap.beta as number, 2)],
    ["52w high", fmtNum(snap.fifty_two_high as number, 2)],
    ["52w low", fmtNum(snap.fifty_two_low as number, 2)],
    ["Sector", String(snap.sector ?? "—")],
  ];
  return (
    <div>
      <div className="text-sm text-txt mb-2 truncate" title={String(snap.name ?? ticker)}>
        {String(snap.name ?? ticker)}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {rows.map(([l, v]) => (
          <div key={l} className="hud px-2.5 py-1.5">
            <div className="label-xs">{l}</div>
            <div className="num text-[13px] mt-0.5 truncate">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Widgets that need a snapshot prop, isolated so the fetch is shared. */
function SnapDependent({ ticker, kind }: { ticker: string; kind: "wacc" | "debt" }) {
  const { snap, err, retry } = useSnapshot(ticker, true);
  if (err) return <PanelError error={err} retry={retry} />;
  return kind === "wacc"
    ? <Wacc ticker={ticker} snap={snap} />
    : <DebtProfile ticker={ticker} snap={snap} />;
}

// ── the switch ────────────────────────────────────────────────────────────

export function PaneBody({ widget, ticker }: { widget: string; ticker: string }) {
  const currency = inferCurrency(ticker);
  switch (widget) {
    case "chart": return <ChartPane ticker={ticker} />;
    case "snapshot": return <SnapshotPane ticker={ticker} />;
    case "quotebar": return <QuoteStrip ticker={ticker} />;
    case "volcone": return <VolCone seedTicker={ticker} />;
    case "backtest": return <Backtester seedTicker={ticker} />;

    case "financials": return <Financials ticker={ticker} currency={currency} />;
    case "estimates": return <EstimatesView ticker={ticker} currency={currency} />;
    case "ratings": return <StreetRatings ticker={ticker} currency={currency} />;
    case "comparables": return <Comparables ticker={ticker} />;
    case "earnings": return <EarningsHistory ticker={ticker} />;
    case "wacc": return <SnapDependent ticker={ticker} kind="wacc" />;
    case "capstruct": return <CapitalStructureView ticker={ticker} />;
    case "debt": return <SnapDependent ticker={ticker} kind="debt" />;

    case "ownership": return <Ownership ticker={ticker} />;
    case "options": return <OptionsChain ticker={ticker} />;
    case "optbuilder": return <OptionBuilder ticker={ticker} />;
    case "movers": return <MoversBoard />;
    case "watchlist": return <WatchlistBoard />;

    case "news": return <News ticker={ticker} />;
    case "valuechain": return <ValueChainMap ticker={ticker} />;
    case "contagion": return <ContagionPathFinder seed={ticker} />;
    case "ai": return <AIPanel ticker={ticker} />;
    case "notes": return <Notes ticker={ticker} />;

    default:
      // Reachable only if a saved layout survives normalize() with a widget
      // this build dropped — say so instead of rendering blank.
      return (
        <div className="text-mut text-xs py-4">
          This pane holds a widget (<span className="text-txt">{widget}</span>) that
          this version no longer ships. Pick another from the header.
        </div>
      );
  }
}
