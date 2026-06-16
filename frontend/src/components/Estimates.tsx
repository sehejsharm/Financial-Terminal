"use client";

import { useEffect, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { api, type Estimates as Est } from "@/lib/api";
import { fmtNum, humanNumber } from "@/lib/utils";

/** Renders any record-of-records estimate block as a table. */
function EstTable({ title, block, cur }: { title: string; block?: Record<string, Record<string, number | null>>; cur: string }) {
  if (!block || Object.keys(block).length === 0) return null;
  // block is column-major: { colName: { rowName: value } }
  const cols = Object.keys(block);
  const rows = Array.from(new Set(cols.flatMap((c) => Object.keys(block[c] ?? {}))));
  return (
    <div className="mb-6">
      <div className="heading mb-2">{title}</div>
      <div className="panel overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-mut uppercase tracking-wider">
            <tr className="border-b border-line">
              <th className="text-left px-3 py-2 font-medium">Metric</th>
              {cols.map((c) => (
                <th key={c} className="text-right px-3 py-2 font-medium">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((rk) => (
              <tr key={rk} className="border-b border-line/60 hover:bg-panel">
                <td className="px-3 py-2 text-txt">{rk}</td>
                {cols.map((c) => {
                  const v = block[c]?.[rk];
                  return (
                    <td key={c} className="px-3 py-2 num text-right text-txt/90">
                      {typeof v === "number" ? humanNumber(v) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EstimatesView({ ticker, currency }: { ticker: string; currency: string }) {
  const [data, setData] = useState<Est | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true); setErr(null); setData(null);
    api.estimates(ticker)
      .then(setData)
      .catch((e) => setErr(e?.detail || "Failed to load estimates."))
      .finally(() => setBusy(false));
  }, [ticker]);

  if (busy) return <div className="text-mut text-xs">Loading estimates…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;
  if (!data) return null;

  const pt = data.price_targets;
  const hasAny = pt || data.earnings_estimate || data.revenue_estimate || data.growth_estimates;

  return (
    <div>
      {pt && Object.keys(pt).length > 0 && (
        <>
          <div className="heading mb-2">Analyst price targets ({currency})</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <MetricCard label="Low" value={fmtNum(pt.low, 2)} />
            <MetricCard label="Mean" value={fmtNum(pt.mean ?? pt.median, 2)} />
            <MetricCard label="Current" value={fmtNum(pt.current, 2)} />
            <MetricCard label="High" value={fmtNum(pt.high, 2)} />
          </div>
        </>
      )}
      <EstTable title="Earnings estimates" block={data.earnings_estimate} cur={currency} />
      <EstTable title="Revenue estimates" block={data.revenue_estimate} cur={currency} />
      <EstTable title="Growth estimates" block={data.growth_estimates} cur={currency} />
      {!hasAny && (
        <div className="panel-2 p-4 text-mut text-sm">No analyst estimates available for {ticker}.</div>
      )}
    </div>
  );
}
