"use client";

import { MetricCard } from "@/components/MetricCard";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { api, type Estimates as Est } from "@/lib/api";
import { looksPercentLabel, prettyLabel } from "@/lib/labels";
import { useAsync } from "@/lib/useAsync";
import { fmtNum, formatPercent, humanNumber } from "@/lib/utils";

/** Renders any record-of-records estimate block as a table. */
function EstTable({ title, block, cur }: { title: string; block?: Record<string, Record<string, number | null>>; cur: string }) {
  if (!block || Object.keys(block).length === 0) return null;
  // block is column-major: { colName: { rowName: value } }
  const cols = Object.keys(block);
  const rows = Array.from(new Set(cols.flatMap((c) => Object.keys(block[c] ?? {}))));
  return (
    <div className="mb-6">
      <div className="heading mb-2">{title}</div>
      <div className="panel overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-mut uppercase tracking-wider">
            <tr className="border-b border-line">
              <th className="text-left px-3 py-2 font-medium">Metric</th>
              {cols.map((c) => (
                // Period codes ("0q", "+1y") and camelCase keys humanized.
                <th key={c} className="text-right px-3 py-2 font-medium whitespace-nowrap">{prettyLabel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((rk) => {
              const pct = looksPercentLabel(rk) || looksPercentLabel(title);
              return (
                <tr key={rk} className="border-b border-line/60 hover:bg-panel">
                  <td className="px-3 py-2 text-txt whitespace-nowrap">{prettyLabel(rk)}</td>
                  {cols.map((c) => {
                    const v = block[c]?.[rk];
                    let display = "—";
                    if (typeof v === "number") {
                      display = pct && Math.abs(v) <= 1.5
                        ? formatPercent(v, { fraction: true })
                        : humanNumber(v);
                    }
                    return (
                      <td key={c} className="px-3 py-2 num text-right text-txt/90">{display}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EstimatesView({ ticker, currency }: { ticker: string; currency: string }) {
  const { data, error, busy, retry } = useAsync<Est>(() => api.estimates(ticker), [ticker]);

  if (busy) return <PanelLoading label="Loading estimates…" />;
  if (error) return <PanelError error={error} retry={retry} />;
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
