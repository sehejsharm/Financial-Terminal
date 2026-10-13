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
  // Numeric columns right-align (thousands separators via toLocaleString);
  // the first column is sticky so wide frames scroll under it.
  const numericCol = frame.columns.map((c) =>
    frame.rows.some((r) => typeof r[c] === "number"));

  return (
    // tabIndex + role + name, because this scrolls horizontally.
    //
    // A div with overflow-x-auto can only be scrolled with a pointer or a
    // trackpad unless it can take focus — arrow keys scroll the element that
    // HAS focus, so a keyboard user simply cannot reach the clipped columns.
    // These frames are financial statements, so the clipped columns are the
    // earlier periods: the comparison the table exists for.
    //
    // axe reports it as `scrollable-region-focusable`, and it was a live CI
    // failure on /workspace's financials widget. It could not appear locally,
    // because an empty frame returns the panel above and never renders a
    // scroll container at all.
    //
    // role + aria-label rather than a bare tabIndex: a focusable div with no
    // role is a tab stop that announces nothing, which trades one defect for
    // a more confusing one.
    <div className="panel overflow-x-auto" tabIndex={0}
         role="region" aria-label="Financial data table, scrolls horizontally">
      <table className="w-full text-xs">
        <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel z-10">
          <tr className="border-b border-line">
            {frame.columns.map((c, ci) => (
              <th key={c}
                  className={`px-3 py-2 font-medium whitespace-nowrap ${numericCol[ci] ? "text-right" : "text-left"} ${ci === 0 ? "sticky left-0 bg-panel" : ""}`}>
                {prettyLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {frame.rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 hover:bg-panel">
              {frame.columns.map((c, ci) => {
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
                  <td key={c}
                      className={`px-3 py-2 num whitespace-nowrap text-txt/90 ${numericCol[ci] ? "text-right" : ""} ${ci === 0 ? "sticky left-0 bg-bg2" : ""}`}>
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
