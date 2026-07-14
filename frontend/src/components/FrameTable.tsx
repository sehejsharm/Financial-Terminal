"use client";

import { type Frame } from "@/lib/api";
import { isIdentifierish, looksPercentLabel, prettyLabel } from "@/lib/labels";
import { formatPercent, humanNumber } from "@/lib/utils";

/** Raw ISO timestamps ("2026-03-31T00:00:00") -> "2026-03-31"; identifier-ish
 *  strings ("insidersPercentHeld") -> humanized labels. */
function prettyValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 10);
    if (isIdentifierish(v)) return prettyLabel(v);
  }
  return String(v);
}

/** True when a numeric cell should render as a percent: its column header
 *  reads percent-like, OR any string cell in the row does (yfinance's
 *  major_holders frame puts "insidersPercentHeld" in one column and the
 *  bare fraction 0.51 in the next). Fractions (|v| <= 1.5) are x100. */
function percentContext(colLabel: string, row: Record<string, unknown>): boolean {
  if (looksPercentLabel(colLabel)) return true;
  return Object.values(row).some(
    (x) => typeof x === "string" && /percent|% *held|% *out/i.test(x),
  );
}

/** Renders a backend {columns, rows} frame. Numbers are humanised when large. */
export function FrameTable({ frame, humanise = false, empty = "No data." }: {
  frame: Frame | null | undefined; humanise?: boolean; empty?: string;
}) {
  if (!frame || frame.rows.length === 0) {
    return <div className="panel-2 p-4 text-mut text-sm">{empty}</div>;
  }
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
          <tr className="border-b border-line">
            {frame.columns.map((c) => (
              <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">
                {prettyLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {frame.rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 hover:bg-panel">
              {frame.columns.map((c) => {
                const v = r[c];
                let display: string;
                if (typeof v === "number") {
                  if (percentContext(c, r) && Math.abs(v) <= 1.5) {
                    display = formatPercent(v, { fraction: true });
                  } else if (humanise && Math.abs(v) >= 1000) {
                    display = humanNumber(v);
                  } else {
                    display = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
                  }
                } else {
                  display = prettyValue(v);
                }
                return (
                  <td key={c} className="px-3 py-2 num whitespace-nowrap text-txt/90">{display}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
