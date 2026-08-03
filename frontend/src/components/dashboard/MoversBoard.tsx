"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { LiveNumber } from "@/components/LiveNumber";
import { RowsSkeleton } from "@/components/Skeleton";
import { api, type Mover, type MoversResult } from "@/lib/api";
import { useNow } from "@/lib/clock";
import {
  loadMarket, marketFor, MARKETS, moversNote, saveMarket, sessionState,
  type MarketKey,
} from "@/lib/homeMarket";
import { useLive } from "@/lib/useLive";
import { useQuote } from "@/lib/useQuote";

/**
 * Gainers and losers, side by side.
 *
 * The old version was one panel with a toggle, so you could never see both at
 * once — which is the entire point of a movers board. Each row now carries a
 * proportional magnitude bar so the shape of the session (a few big movers vs
 * a broad drift) reads without parsing ten percentages.
 *
 * Rows stream: the list itself is a cached server computation, but each
 * constituent's change % updates live off the shared socket.
 */

function MoverRow({ m, rank, max, tone }: {
  m: Mover; rank: number; max: number; tone: "up" | "down";
}) {
  const sym = String(m.symbol ?? m.ticker ?? "");
  // The movers feed returns bare NSE names; the socket needs them qualified.
  const streamSym = sym && !sym.includes(".") && !sym.startsWith("^") ? `${sym}.NS` : sym;
  const tick = useQuote(streamSym || null);
  const cp = tick?.chgPct ?? Number(m.change_pct ?? m.percent_change ?? 0);
  const name = String(m.name ?? sym);
  const width = max > 0 ? Math.min(100, (Math.abs(cp) / max) * 100) : 0;

  return (
    <Link href={`/terminal?t=${encodeURIComponent(sym)}`}
          title={`${name} — open in Terminal`}
          className="relative flex items-center gap-2 px-2.5 py-[7px] rounded
                     hover:bg-panel2 border border-transparent hover:border-line2
                     transition-colors min-w-0 group">
      {/* Magnitude bar, behind the text. */}
      <span aria-hidden
            className="absolute left-0 top-0 bottom-0 rounded pointer-events-none transition-[width] duration-500"
            style={{
              width: `${width}%`,
              background: tone === "up"
                ? "rgb(var(--c-green) / 0.10)" : "rgb(var(--c-red) / 0.10)",
            }} />
      <span className="num text-[10px] text-mut w-4 shrink-0 relative">{rank}</span>
      <span className="text-[13px] truncate min-w-0 flex-1 relative group-hover:text-amber transition-colors">
        {name}
      </span>
      <span className={`num text-[13px] shrink-0 relative ${cp >= 0 ? "text-green" : "text-red"}`}>
        <LiveNumber value={cp} format="pct" />
      </span>
    </Link>
  );
}

function Column({ kind, rows, busy }: {
  kind: "gainers" | "losers"; rows: Mover[]; busy: boolean;
}) {
  const up = kind === "gainers";
  const max = useMemo(
    () => Math.max(...rows.map((m) => Math.abs(Number(m.change_pct ?? m.percent_change ?? 0))), 0.01),
    [rows]);

  return (
    <div className="hud p-3 min-w-0">
      <div className="flex items-center gap-2 mb-2">
        {up ? <TrendingUp size={13} className="text-green" />
            : <TrendingDown size={13} className="text-red" />}
        <span className={`text-[11px] uppercase tracking-[0.1em] font-bold ${up ? "text-green" : "text-red"}`}>
          {up ? "Top gainers" : "Top losers"}
        </span>
      </div>
      {busy && rows.length === 0 && <RowsSkeleton rows={8} />}
      {!busy && rows.length === 0 && (
        <div className="text-mut text-xs py-3">
          No {kind} returned. The NIFTY movers list is computed server-side and
          may be empty outside market hours.
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {rows.map((m, i) => (
          <MoverRow key={`${m.symbol ?? m.ticker ?? i}`} m={m} rank={i + 1} max={max}
                    tone={up ? "up" : "down"} />
        ))}
      </div>
    </div>
  );
}

export function MoversBoard() {
  // Which market the reader is sitting in. Defaulted from their timezone —
  // a New York reader opening this at 9am local was being shown an Indian
  // session that closed hours earlier — and remembered once they choose.
  const [marketKey, setMarketKey] = useState<MarketKey>("IN");
  useEffect(() => { setMarketKey(loadMarket()); }, []);
  const market = marketFor(marketKey);

  function pick(k: MarketKey) {
    setMarketKey(k);
    saveMarket(k);
  }

  // Both sides refresh on the same 60s cadence (server cache TTL 300s, kept
  // warm by the backend prewarmer, so each poll is cheap).
  const gain = useLive<MoversResult | null>(
    () => api.movers("gainers", 10, marketKey), 60_000, [marketKey]);
  const lose = useLive<MoversResult | null>(
    () => api.movers("losers", 10, marketKey), 60_000, [marketKey]);

  // One clock read per render rather than per row, and a minute's resolution
  // is all a session state needs.
  const now = useNow();
  const session = useMemo(
    () => sessionState(market, new Date(now)), [market, now]);
  const universe = gain.data?.universe ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h2 className="heading">Gainers &amp; losers</h2>
        {/* Open/closed at the VENUE, not here: a mover list from a closed
            market is a finished session and reads identically to a live one. */}
        <span className={`inline-flex items-center gap-1.5 text-[10px] whitespace-nowrap ${
          session.open ? "text-green" : "text-mut"}`}
              title={session.read}>
          <span className={`w-1.5 h-1.5 rounded-full ${
            session.open ? "bg-green mb-ping" : "bg-mut"}`} />
          {session.open ? "open" : "closed"} · {session.localTime} local
        </span>
        <div className="flex-1" />
        <select value={marketKey}
                onChange={(e) => pick(e.target.value as MarketKey)}
                aria-label="Market"
                className="input-bare !py-1 text-[11px] cursor-pointer">
          {MARKETS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        <DataAge at={gain.updatedAt}
                 onRefresh={() => { gain.refresh(); lose.refresh(); }}
                 busy={gain.busy || lose.busy} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Column kind="gainers" rows={gain.data?.rows ?? []} busy={gain.busy} />
        <Column kind="losers" rows={lose.data?.rows ?? []} busy={lose.busy} />
      </div>
      {universe > 0 && (
        <div className="text-[10px] text-mut mt-2 leading-relaxed">
          {moversNote(market, universe, session)}
        </div>
      )}
    </div>
  );
}
