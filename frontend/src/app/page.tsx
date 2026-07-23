"use client";

import Link from "next/link";
import { useState } from "react";

import { DataAge } from "@/components/DataAge";
import { LiveNumber } from "@/components/LiveNumber";
import { MetricCard } from "@/components/MetricCard";
import { RowsSkeleton } from "@/components/Skeleton";
import { Shell } from "@/components/Shell";
import { WatchlistEditor } from "@/components/WatchlistEditor";
import { api, type Mover } from "@/lib/api";
import { useLive } from "@/lib/useLive";
import { useQuote } from "@/lib/useQuote";
import { curForTicker, fmtPct } from "@/lib/utils";

// All NSE-resolvable so the dashboard fills via the direct NSE provider
// (fast, never blocked). The old INR=X / GC=F / SI=F / CL=F set went through
// Yahoo and timed out on Render free.
const SNAPSHOT_TICKERS = [
  "^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX",
  "^CNXIT", "^CNXFMCG", "^CNXAUTO", "^CNXPHARMA",
  "^CNXMETAL", "^CNXENERGY", "^CNXMIDCAP", "^CNX500",
];
const NAMES: Record<string, string> = {
  "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY",
  "^INDIAVIX": "INDIA VIX", "^CNXIT": "NIFTY IT", "^CNXFMCG": "NIFTY FMCG",
  "^CNXAUTO": "NIFTY AUTO", "^CNXPHARMA": "NIFTY PHARMA",
  "^CNXMETAL": "NIFTY METAL", "^CNXENERGY": "NIFTY ENERGY",
  "^CNXMIDCAP": "NIFTY MIDCAP 100", "^CNX500": "NIFTY 500",
};

/** A mover row whose % streams live (the NIFTY gainers/losers list is a
 *  computed EOD-ish set, but each constituent's change % can update live
 *  during the session). Bare NSE names are qualified for the socket. */
function LiveMoverRow({ m }: { m: Mover }) {
  const sym = String(m.symbol ?? m.ticker ?? "");
  const streamSym = sym && !sym.includes(".") && !sym.startsWith("^") ? `${sym}.NS` : sym;
  const tick = useQuote(streamSym || null);
  const cp = tick?.chgPct ?? Number(m.change_pct ?? m.percent_change ?? 0);
  return (
    <Link href={`/terminal?t=${encodeURIComponent(sym)}`}
          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-panel border border-transparent hover:border-line min-w-0">
      <span className="text-sm truncate min-w-0">{String(m.name ?? sym)}</span>
      <span className={`num text-sm shrink-0 ${cp >= 0 ? "text-green" : "text-red"}`}>
        <LiveNumber symbol={streamSym} field="chgPct" format="pct" />
      </span>
    </Link>
  );
}

function MoversPanel() {
  const [kind, setKind] = useState<"gainers" | "losers">("gainers");
  // Movers refresh every 60s while the tab is visible (server cache TTL 300s,
  // kept warm by the backend prewarmer, so each poll is cheap).
  const { data, busy, updatedAt, refresh } = useLive<Mover[]>(
    () => api.movers(kind, 8).then((r) => (Array.isArray(r) ? r : [])),
    60_000,
    [kind],
  );
  const rows = data ?? [];

  return (
    <div className="panel-2 p-4">
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setKind("gainers")} className={`btn ${kind === "gainers" ? "btn-primary" : "btn-ghost"}`}>Gainers</button>
        <button onClick={() => setKind("losers")} className={`btn ${kind === "losers" ? "btn-primary" : "btn-ghost"}`}>Losers</button>
        <div className="flex-1" />
        <DataAge at={updatedAt} onRefresh={refresh} busy={busy} />
      </div>
      {busy && rows.length === 0 && <RowsSkeleton rows={8} />}
      {!busy && rows.length === 0 && <div className="text-mut text-xs">No data.</div>}
      <div className="flex flex-col gap-1">
        {rows.map((m, i) => <LiveMoverRow key={i} m={m} />)}
      </div>
    </div>
  );
}

/** One streaming index tile. Subscribes itself to the symbol (ref-counted),
 *  so only this card re-renders when its tick changes — not the whole grid. */
function IndexCard({ t }: { t: string }) {
  const tick = useQuote(t);
  const cur = curForTicker(t, tick?.ccy);
  const cp = tick?.chgPct ?? null;
  const tone = cp == null ? "neutral" : cp >= 0 ? "positive" : "negative";
  const has = tick?.ltp != null;
  return (
    <Link href={`/terminal?t=${encodeURIComponent(t)}`}>
      <MetricCard
        label={NAMES[t] ?? t}
        value={has ? <LiveNumber symbol={t} field="ltp" format="price" ccy={cur} /> : "···"}
        delta={cp != null ? <LiveNumber symbol={t} field="chgPct" format="pct" showDelta /> : null}
        tone={tone}
        className={`cursor-pointer ${!has ? "animate-pulse" : ""}`}
      />
    </Link>
  );
}

export default function DashboardPage() {
  // Index tiles now stream: each IndexCard subscribes to the shared socket
  // (seeded once from REST by the store, so no blank first paint). The old
  // per-page 15s quoteBulk poll is gone — liveness shows in the header badge.
  return (
    <Shell>
      <div className="flex items-center gap-3 mb-3">
        <h1 className="heading">MARKET SNAPSHOT</h1>
      </div>
      <div className="grid gap-3 mb-8" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {SNAPSHOT_TICKERS.map((t) => <IndexCard key={t} t={t} />)}
      </div>

      {/* min-w-0 on grid children: without it the movers column refused to
          shrink at ~1084px and the % values clipped off the right edge. */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 mb-8">
        <div className="min-w-0">
          <h1 className="heading mb-3">WATCHLISTS</h1>
          <WatchlistEditor />
        </div>
        <div className="min-w-0">
          <h1 className="heading mb-3">MOVERS</h1>
          <MoversPanel />
        </div>
      </div>
    </Shell>
  );
}
