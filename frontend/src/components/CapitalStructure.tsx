"use client";

import { MetricCard } from "@/components/MetricCard";
import { PanelEmpty, PanelError, PanelLoading } from "@/components/PanelStates";
import { api, type CapStructure } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { curSymbol, humanNumber } from "@/lib/utils";

/** Capital stack: debt / cash / equity with a proportional bar (enterprise value). */
export function CapitalStructureView({ ticker }: { ticker: string }) {
  const { data, error, busy, retry, serverFault } = useAsync<CapStructure>(
    () => api.capitalStructure(ticker), [ticker],
  );

  if (busy) return <PanelLoading label="Loading capital structure…" />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;
  if (!data) return null;

  if (data.market_cap == null && data.total_debt == null && data.cash == null) {
    return (
      <PanelEmpty retry={retry}>
        Capital-structure inputs aren&apos;t covered by free data for this listing.
      </PanelEmpty>
    );
  }

  const cur = curSymbol(data.currency);
  const debt = data.total_debt ?? 0;
  const cash = data.cash ?? 0;
  const equity = data.market_cap ?? 0;
  const netDebt = debt - cash;
  const ev = equity + netDebt;
  const total = equity + Math.max(debt, 0) || 1;
  const equityPct = (equity / total) * 100;
  const debtPct = (Math.max(debt, 0) / total) * 100;

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard label="Market cap (equity)" value={humanNumber(data.market_cap, cur)} />
        <MetricCard label="Total debt" value={humanNumber(data.total_debt, cur)} />
        <MetricCard label="Cash" value={humanNumber(data.cash, cur)} />
        <MetricCard label="Net debt" value={humanNumber(netDebt, cur)} tone={netDebt > 0 ? "negative" : "positive"} />
      </div>

      <div className="heading mb-2">Enterprise value ≈ {humanNumber(ev, cur)}</div>
      <div className="panel-2 p-4">
        <div className="flex h-8 rounded overflow-hidden border border-line2 mb-2">
          <div className="bg-amber/80 flex items-center justify-center text-[10px] text-black font-bold"
               style={{ width: `${equityPct}%` }}>
            {equityPct > 12 ? "EQUITY" : ""}
          </div>
          <div className="bg-red/70 flex items-center justify-center text-[10px] text-white font-bold"
               style={{ width: `${debtPct}%` }}>
            {debtPct > 12 ? "DEBT" : ""}
          </div>
        </div>
        <div className="flex justify-between text-[11px] text-mut">
          <span>Equity {equityPct.toFixed(0)}%</span>
          <span>Debt {debtPct.toFixed(0)}%</span>
        </div>
        {data.shares != null && (
          <div className="text-[11px] text-mut mt-3">
            Shares outstanding: <span className="num text-txt">{humanNumber(data.shares)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
