"use client";

import { MetricCard } from "@/components/MetricCard";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { api, type CapStructure, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { curSymbol, fmtNum, humanNumber } from "@/lib/utils";

/**
 * Debt profile. Free data exposes debt levels + ratios, not a maturity ladder.
 * Pulls total debt from capital-structure and ratios from the snapshot.
 */
export function DebtProfile({ ticker, snap }: { ticker: string; snap: Snapshot | null }) {
  const { data: cap, error, busy, retry, serverFault } = useAsync<CapStructure>(
    () => api.capitalStructure(ticker), [ticker],
  );

  if (busy) return <PanelLoading label="Loading debt profile…" />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;

  const cur = curSymbol((cap?.currency || (snap?.currency as string)) ?? "USD");
  const de = snap?.debt_to_equity as number | undefined;

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <MetricCard label="Total debt" value={humanNumber(cap?.total_debt, cur)} />
        <MetricCard label="Debt / Equity" value={de != null ? `${(de / 100).toFixed(2)}x` : "—"}
                    tone={de != null && de / 100 > 1 ? "negative" : "neutral"} />
        <MetricCard label="Current ratio" value={fmtNum(snap?.current_ratio as number, 2)} />
        <MetricCard label="Quick ratio" value={fmtNum(snap?.quick_ratio as number, 2)} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Cash" value={humanNumber(cap?.cash, cur)} />
        <MetricCard label="Net debt" value={humanNumber((cap?.total_debt ?? 0) - (cap?.cash ?? 0), cur)} />
        <MetricCard label="Free cash flow" value={humanNumber(snap?.free_cashflow as number, cur)} />
        <MetricCard label="EBITDA" value={humanNumber(snap?.ebitda as number, cur)} />
      </div>
      <div className="text-[10.5px] text-mut mt-3">
        Free data exposes debt levels and ratios, not a maturity-by-year schedule.
      </div>
    </div>
  );
}
