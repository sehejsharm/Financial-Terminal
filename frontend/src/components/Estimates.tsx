"use client";

import { MetricCard } from "@/components/MetricCard";
import { Note } from "@/components/ui";
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
  const { data, error, busy, retry, serverFault } = useAsync<Est>(() => api.estimates(ticker), [ticker]);

  if (busy) return <PanelLoading label="Loading estimates…" />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;
  if (!data) return null;

  const pt = data.price_targets;
  const cur = pt?.current ?? null;
  const mean = pt?.mean ?? pt?.median ?? null;
  const upside = cur != null && mean != null && cur > 0
    ? ((mean - cur) / cur) * 100 : null;
  const dispersion = pt?.high != null && pt?.low != null && mean != null && mean !== 0
    ? ((pt.high - pt.low) / Math.abs(mean)) * 100 : null;
  // The band is drawn from a floor below the low to a ceiling above the high
  // so the current price stays on the track even when it sits outside the
  // analyst range, which is exactly when the picture is most interesting.
  const lo = pt?.low ?? null, hi = pt?.high ?? null;
  const floor = lo != null && hi != null
    ? Math.min(lo, cur ?? lo) * 0.97 : null;
  const ceil = lo != null && hi != null
    ? Math.max(hi, cur ?? hi) * 1.03 : null;
  const rangeOk = floor != null && ceil != null && ceil > floor;
  const pos = (v: number | null | undefined) =>
    (!rangeOk || v == null ? null : ((v - floor!) / (ceil! - floor!)) * 100);
  const lowPos = pos(lo) ?? 0;
  const highPos = pos(hi) ?? 100;
  const meanPos = pos(mean);
  const curPos = pos(cur);

  const hasAny = pt || data.earnings_estimate || data.revenue_estimate || data.growth_estimates;

  return (
    <div>
      {pt && Object.keys(pt).length > 0 && (
        <>
          <div className="heading mb-2">Analyst price targets ({currency})</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            {/* Upside, not just the target. A target of 1,600 means nothing
                until you know the price is 1,425 — the screen was making the
                reader do that subtraction on every visit. */}
            <MetricCard
              label="Implied upside to mean"
              value={upside == null ? "—"
                : `${upside >= 0 ? "+" : ""}${fmtNum(upside, 1)}%`}
              tone={upside == null ? "neutral" : upside >= 0 ? "positive" : "negative"} />
            <MetricCard label="Mean target" value={fmtNum(pt.mean ?? pt.median, 2)} />
            <MetricCard label="Current" value={fmtNum(pt.current, 2)} />
            {/* Dispersion is the part that says how much agreement there is.
                A tight band and a 60%-wide one carry the same mean and very
                different information. */}
            <MetricCard
              label="Spread of views"
              value={dispersion == null ? "—" : `${fmtNum(dispersion, 0)}%`}
              title="High minus low, as a share of the mean target"
              tone={dispersion == null ? "neutral"
                : dispersion > 50 ? "negative" : "neutral"} />
          </div>

          {rangeOk && (
            <div className="panel-2 p-4 mb-3">
              <div className="relative h-8">
                <div className="absolute inset-x-0 top-3.5 h-1 bg-line2 rounded" />
                <div className="absolute top-3.5 h-1 bg-amber/60 rounded"
                     style={{ left: `${lowPos}%`, width: `${Math.max(1, highPos - lowPos)}%` }} />
                {meanPos != null && (
                  <div className="absolute top-1.5 w-px h-5 bg-amber"
                       style={{ left: `${meanPos}%` }} title="Mean target" />
                )}
                {curPos != null && (
                  <div className="absolute top-0 flex flex-col items-center"
                       style={{ left: `${curPos}%`, transform: "translateX(-50%)" }}>
                    <span className="w-px h-8 bg-txt" />
                  </div>
                )}
              </div>
              <div className="flex justify-between text-[10.5px] text-mut">
                <span>low {fmtNum(pt.low, 2)}</span>
                <span className="text-txt">current {fmtNum(pt.current, 2)}</span>
                <span>high {fmtNum(pt.high, 2)}</span>
              </div>
            </div>
          )}

          <Note>
            Targets are whatever consensus the free feed carries, with no
            analyst count attached — a mean set by two analysts and one set by
            thirty are indistinguishable here. They are also anchored to the
            price: targets follow the share more often than they lead it, so a
            wide implied upside after a fall is not by itself a signal.
          </Note>
          <div className="mb-6" />
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
