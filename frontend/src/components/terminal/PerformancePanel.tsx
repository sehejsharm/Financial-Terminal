"use client";

import { useMemo } from "react";

import { Note } from "@/components/ui";
import {
  horizonReturns, performanceNote, rideStats, toBars, ytdReturn,
  type Candle,
} from "@/lib/priceStats";
import { fmtNum } from "@/lib/utils";

/**
 * How the stock has actually done — the thing every reader works out for
 * themselves in the first ten seconds on a snapshot screen.
 *
 * Computed from the candles the chart has already loaded, so it costs no
 * extra request and moves with the period selector. That coupling is worth
 * being explicit about, which the note below does.
 */
export function PerformancePanel({ candles }: { candles: Candle[] | null }) {
  const bars = useMemo(() => toBars(candles), [candles]);
  const rets = useMemo(() => horizonReturns(bars), [bars]);
  const ytd = useMemo(() => ytdReturn(bars), [bars]);
  const stats = useMemo(() => rideStats(bars), [bars]);

  const cells = [...rets, ytd];
  const anyReturn = cells.some((c) => c.pct != null);

  return (
    <div className="mb-6">
      <div className="heading mb-2">Performance</div>

      <div className="grid gap-2.5 mb-2.5"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
        {cells.map((r) => (
          <div key={r.key} className="hud p-3" title={
            r.fromDate ? `From the close on ${r.fromDate}`
              : "Not enough history loaded for this window"}>
            <div className="label-xs truncate">{r.label}</div>
            <div className={`num text-lg mt-0.5 ${
              r.pct == null ? "text-mut" : r.pct >= 0 ? "text-green" : "text-red"}`}>
              {r.pct == null ? "—" : `${r.pct >= 0 ? "+" : ""}${fmtNum(r.pct, 1)}%`}
            </div>
          </div>
        ))}
      </div>

      {anyReturn && (
        <div className="grid gap-2.5 mb-2"
             style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <div className="hud p-3">
            <div className="label-xs">Volatility (annualised)</div>
            <div className="num text-lg mt-0.5 text-txt">
              {stats.annualVolPct == null ? "—" : `${fmtNum(stats.annualVolPct, 1)}%`}
            </div>
          </div>
          <div className="hud p-3" title="Deepest peak-to-trough fall inside the window">
            <div className="label-xs">Worst drawdown</div>
            <div className={`num text-lg mt-0.5 ${
              stats.maxDrawdownPct == null ? "text-mut"
                : stats.maxDrawdownPct < -20 ? "text-red" : "text-txt"}`}>
              {stats.maxDrawdownPct == null ? "—" : `${fmtNum(stats.maxDrawdownPct, 1)}%`}
            </div>
          </div>
          <div className="hud p-3">
            <div className="label-xs">Position in window range</div>
            <div className="num text-lg mt-0.5 text-txt">
              {stats.rangePosition == null ? "—" : `${fmtNum(stats.rangePosition, 0)}%`}
            </div>
            {stats.low != null && stats.high != null && (
              <div className="text-[10px] text-mut mt-1 num">
                {fmtNum(stats.low, 2)} – {fmtNum(stats.high, 2)}
              </div>
            )}
          </div>
          <div className="hud p-3">
            <div className="label-xs">Sessions measured</div>
            <div className="num text-lg mt-0.5 text-txt">{stats.bars}</div>
          </div>
        </div>
      )}

      <Note>{performanceNote(bars, stats)}</Note>
    </div>
  );
}
