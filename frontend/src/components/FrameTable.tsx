"use client";

import { type Frame } from "@/lib/api";
import { humanNumber } from "@/lib/utils";

/** "pctHeld" / "Date_Reported" -> "Pct Held" / "Date Reported". */
function prettyHeader(c: string): string {
  return c
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (s) => s.toUpperCase());
}

/** Raw ISO timestamps ("2026-03-31T00:00:00") -> "2026-03-31". */
function prettyValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 10);
  }
  return String(v);
}

/** Renders a backend {columns, rows} frame. Numbers are humanised when large. */
export function FrameTable({ frame, humanise = false, empty = "No data." }: {
  frame: Frame | null | undefined; humanise?: boolean; empty?: string;
}) {
  if (!frame || frame.rows.length === 0) {
    return <div className="panel-2 p-4 text-mut text-sm">{empty}</div>;
  }
  return (
    <div className="panel overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
          <tr className="border-b border-line">
            {frame.columns.map((c) => (
              <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">
                {prettyHeader(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {frame.rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 hover:bg-panel">
              {frame.columns.map((c) => {
                const v = r[c];
                const display = typeof v === "number"
                  ? (humanise && Math.abs(v) >= 1000 ? humanNumber(v) : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
                  : prettyValue(v);
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
