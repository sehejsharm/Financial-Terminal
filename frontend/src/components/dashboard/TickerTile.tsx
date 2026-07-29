"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { LiveNumber } from "@/components/LiveNumber";
import { heatBg, heatBorder } from "@/lib/heat";
import { instrument } from "@/lib/instruments";
import { useQuote } from "@/lib/useQuote";
import { curForTicker, fmtNum } from "@/lib/utils";

/**
 * One instrument tile.
 *
 * Subscribes to its OWN symbol so a tick re-renders this tile and nothing
 * else — the board can hold 60 instruments without a page-wide re-render per
 * message.
 *
 * Three distinct states, kept visually distinct on purpose:
 *   priced      — number, change, and a magnitude bar
 *   waiting     — subscribed, no tick yet (pulsing placeholder)
 *   unpriceable — catalogued as having no free symbol at all, so it says so
 *                 instead of pretending it's still loading forever
 */
export function TickerTile({
  sym, dense, editing, onRemove, onMove,
}: {
  sym: string;
  dense?: boolean;
  editing?: boolean;
  onRemove?: () => void;
  onMove?: (dir: -1 | 1) => void;
}) {
  const meta = instrument(sym);
  const tick = useQuote(meta.coverage === "none" ? null : sym);
  const cur = curForTicker(sym, tick?.ccy);
  const cp = tick?.chgPct ?? null;
  const has = tick?.ltp != null;
  const up = cp != null && cp >= 0;

  // Bar width saturates at ±3%: beyond that the exact magnitude stops
  // mattering and a full bar reads faster than a longer one.
  const mag = cp == null ? 0 : Math.min(1, Math.abs(cp) / 3);

  const body = (
    <div data-testid={`tile-${sym}`}
         style={{ borderColor: heatBorder(cp) }}
         className={`hud relative overflow-hidden group h-full transition-all duration-300
                     ${has ? "hover:-translate-y-[1px] hover:hud-glow" : ""}
                     ${dense ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      {/* Same heat shading as the Global board, so a 1.4% move looks the
          same wherever you meet it. */}
      <span aria-hidden
            className="absolute inset-0 pointer-events-none transition-colors duration-500"
            style={{ background: heatBg(cp) }} />
      <div className="flex items-center gap-1.5 relative">
        <span className={`label-xs truncate flex-1 min-w-0 ${dense ? "text-[9.5px]" : ""}`}
              title={meta.label}>
          {meta.short}
        </span>
        {meta.coverage === "nse" && (
          <span title="Served direct from NSE — the most reliable path"
                className="w-1 h-1 rounded-full bg-green/70 shrink-0" />
        )}
      </div>

      {/* Price left, change right on ONE baseline. A tile stretched wide by
          the grid then reads as a deliberate row rather than a narrow card
          with a gap bolted onto its right-hand side. */}
      <div className="flex items-baseline justify-between gap-2 mt-1.5 min-w-0 relative">
        <span className={`num text-txt tracking-tight leading-none truncate
                          ${dense ? "text-[15px]" : "text-[19px]"}`}>
          {has
            ? <LiveNumber value={tick!.ltp} format="price" ccy={cur} />
            : meta.coverage === "none"
              ? <span className="text-mut text-[13px]">n/a</span>
              : <span className="text-mut animate-pulse">···</span>}
        </span>

        <span className={`shrink-0 text-right ${dense ? "text-[10px]" : "text-[11.5px]"}`}>
          {cp != null ? (
            <span className={up ? "text-green" : "text-red"}>
              {up ? "▲" : "▼"} <LiveNumber value={cp} format="pct" />
              {tick?.chg != null && !dense && (
                <span className="num text-mut ml-1.5">{fmtNum(Math.abs(tick.chg), 2)}</span>
              )}
            </span>
          ) : (
            <span className="text-mut">
              {meta.coverage === "none" ? "no free symbol" : "awaiting tick"}
            </span>
          )}
        </span>
      </div>

      {/* Magnitude bar — size of the move, readable without parsing digits. */}
      {cp != null && (
        <div className="hud-bar"
             style={{
               width: `${Math.round(mag * 100)}%`,
               background: up ? "rgb(var(--c-green) / 0.8)" : "rgb(var(--c-red) / 0.8)",
             }} />
      )}
    </div>
  );

  if (editing) {
    return (
      <div className="relative">
        {body}
        <div className="absolute inset-0 bg-bg/70 opacity-0 hover:opacity-100 transition-opacity
                        flex items-center justify-center gap-1 rounded-md">
          <button onClick={() => onMove?.(-1)} title="Move left"
                  className="p-1 rounded border border-line2 bg-panel text-mut hover:text-amber">
            <ChevronLeft size={12} />
          </button>
          <button onClick={onRemove} title={`Remove ${meta.short}`}
                  className="p-1 rounded border border-line2 bg-panel text-mut hover:text-red">
            <X size={12} />
          </button>
          <button onClick={() => onMove?.(1)} title="Move right"
                  className="p-1 rounded border border-line2 bg-panel text-mut hover:text-amber">
            <ChevronRight size={12} />
          </button>
        </div>
      </div>
    );
  }

  // Unpriceable instruments have nothing to show on the Terminal page either,
  // so they aren't links — a dead click is worse than an obviously inert tile.
  if (meta.coverage === "none") {
    return <div title={meta.note}>{body}</div>;
  }

  return (
    <Link href={`/terminal?t=${encodeURIComponent(sym)}`}
          title={`${meta.label} — open in Terminal`}>
      {body}
    </Link>
  );
}
