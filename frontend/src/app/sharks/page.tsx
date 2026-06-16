"use client";

import { useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { api, type DealRow } from "@/lib/api";

function DealTable({ rows, label }: { rows: DealRow[] | null; label: string }) {
  if (!rows) return <div className="text-mut text-xs">Loading {label}…</div>;
  if (rows.length === 0) {
    return (
      <div className="panel-2 p-4 text-mut text-sm">
        Could not load {label} right now (NSE may be blocking programmatic access,
        or there are no deals yet today).
      </div>
    );
  }
  const cols = Object.keys(rows[0]);
  return (
    <div className="panel overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
          <tr className="border-b border-line">
            {cols.map((c) => (
              <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">{c.replace(/_/g, " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 hover:bg-panel">
              {cols.map((c) => {
                const v = r[c];
                const display = typeof v === "number"
                  ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
                  : (v ?? "—");
                return <td key={c} className="px-3 py-2 num whitespace-nowrap text-txt/90">{display}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SharksPage() {
  const [tab, setTab] = useState<"bulk" | "block">("bulk");
  const [rows, setRows] = useState<DealRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    (tab === "bulk" ? api.bulkDeals() : api.blockDeals())
      .then(setRows)
      .catch(() => setRows([]));
  }, [tab]);

  return (
    <Shell>
      <h1 className="heading mb-3">BIG SHARK UPDATES</h1>
      <div className="panel-2 p-3 mb-4 text-[11px] text-mut">
        A true real-time feed of bulk/block deals requires a paid data subscription.
        NSE publishes these end-of-day only, so this is the latest <strong>END-OF-DAY</strong> activity
        (best-effort from NSE archives), not a live tick feed.
      </div>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setTab("bulk")} className={`btn ${tab === "bulk" ? "btn-primary" : "btn-ghost"}`}>Bulk deals</button>
        <button onClick={() => setTab("block")} className={`btn ${tab === "block" ? "btn-primary" : "btn-ghost"}`}>Block deals</button>
      </div>
      <DealTable rows={rows} label={tab === "bulk" ? "bulk deals" : "block deals"} />
    </Shell>
  );
}
