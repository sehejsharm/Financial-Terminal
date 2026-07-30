"use client";

import { useMemo } from "react";

import { Methodology } from "@/components/Methodology";
import { Note, SectionHeader } from "@/components/ui";
import {
  keyLevels, levelNote, tally, technicalNote, technicalReadings, toOhlc,
  type Reading, type Signal,
} from "@/lib/technicalRead";
import { fmtNum } from "@/lib/utils";

/**
 * What the indicators are saying, in words.
 *
 * GIP offered fourteen indicators and left every reading to the eye — the
 * reader had to toggle RSI on, look at where the line sat, remember that 78 is
 * high, and do it again for the next one. All of that is work the screen can
 * do, so it does it here and leaves the chart to be a chart.
 *
 * Computed from the candles the chart has already loaded, which means it costs
 * no extra request and moves with the period selector. That coupling is worth
 * stating rather than hiding, which the note does.
 */

const TONE: Record<Signal, string> = {
  bullish: "text-green",
  bearish: "text-red",
  neutral: "text-mut",
};

const DOT: Record<Signal, string> = {
  bullish: "bg-green",
  bearish: "bg-red",
  neutral: "bg-mut",
};

const GROUPS = ["Trend", "Momentum", "Volatility", "Volume"] as const;

function formatValue(r: Reading, decimals = 2): string {
  if (r.value == null) return "—";
  const sign = r.unit === "%" && r.key !== "bb" && r.value > 0 ? "+" : "";
  const digits = r.unit === "" ? (Math.abs(r.value) >= 10 ? 1 : 2) : decimals;
  return `${sign}${fmtNum(r.value, digits)}${r.unit === "%" ? "%" : ""}`;
}

export function TechnicalReadout({ candles }: { candles: unknown[] | null }) {
  const bars = useMemo(
    () => toOhlc(candles as Record<string, unknown>[] | null), [candles]);
  const readings = useMemo(() => technicalReadings(bars), [bars]);
  const t = useMemo(() => tally(readings), [readings]);
  const levels = useMemo(() => keyLevels(bars), [bars]);

  return (
    <div className="mb-6">
      <SectionHeader
        title="Indicator readout"
        count={readings.length ? `${readings.length} indicators` : undefined}
        actions={readings.length ? (
          <div className="flex items-center gap-3 text-[11px] num">
            <span className="text-green">{t.bullish} bullish</span>
            <span className="text-red">{t.bearish} bearish</span>
            <span className="text-mut">{t.neutral} no direction</span>
          </div>
        ) : undefined}
      />

      {!readings.length ? (
        <Note>{technicalNote(readings, t, bars.length)}</Note>
      ) : (
        <>
          <div className="grid gap-2.5 mb-3"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {GROUPS.map((g) => {
              const rows = readings.filter((r) => r.group === g);
              if (!rows.length) return null;
              return (
                <div key={g} className="hud p-3">
                  <div className="label-xs mb-2">{g}</div>
                  <div className="flex flex-col gap-2">
                    {rows.map((r) => (
                      <div key={r.key}>
                        <div className="flex items-baseline gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[r.signal]}`} />
                          <span className="text-[11px] text-txt flex-1 min-w-0">{r.label}</span>
                          {/* Values are never truncated — a readout whose
                              number is clipped has failed at its one job. */}
                          <span className={`num text-[12px] whitespace-nowrap ${TONE[r.signal]}`}>
                            {formatValue(r)}
                            {r.extra != null && (
                              <span className="text-mut"> / {fmtNum(r.extra, 2)}</span>
                            )}
                          </span>
                        </div>
                        <div className="text-[10px] text-mut leading-relaxed pl-3.5 mt-0.5">
                          {r.read}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <Note>{technicalNote(readings, t, bars.length)}</Note>
        </>
      )}

      {levels.length > 0 && (
        <div className="mt-5">
          <SectionHeader title="Key levels" count={`${levels.length} levels`} />
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-mut border-b border-line2">
                  <th className="text-left font-normal py-1.5 pr-3">Level</th>
                  <th className="text-right font-normal py-1.5 px-3">Price</th>
                  <th className="text-right font-normal py-1.5 px-3">Distance</th>
                  <th className="text-right font-normal py-1.5 pl-3">Sessions traded there</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((l) => (
                  <tr key={`${l.label}-${l.price}`} className="border-b border-line2/50">
                    <td className="py-1.5 pr-3 text-txt whitespace-nowrap">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${
                        l.kind === "resistance" ? "bg-red" : "bg-green"}`} />
                      {l.label}
                    </td>
                    <td className="py-1.5 px-3 text-right num text-txt whitespace-nowrap">
                      {fmtNum(l.price, 2)}
                    </td>
                    <td className={`py-1.5 px-3 text-right num whitespace-nowrap ${
                      l.distancePct >= 0 ? "text-red" : "text-green"}`}>
                      {l.distancePct >= 0 ? "+" : ""}{fmtNum(l.distancePct, 1)}%
                    </td>
                    <td className="py-1.5 pl-3 text-right num text-mut">{l.touches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2">
            <Note>{levelNote(levels)}</Note>
          </div>
        </div>
      )}

      <Methodology id="technicals" className="mt-3" />
    </div>
  );
}
