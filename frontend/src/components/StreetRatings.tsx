"use client";

import { FrameTable } from "@/components/FrameTable";
import { MetricCard } from "@/components/MetricCard";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { api, type Ratings } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { curSymbol, fmtNum } from "@/lib/utils";

export function StreetRatings({ ticker, currency }: { ticker: string; currency: string }) {
  const { data, error, busy, retry } = useAsync<Ratings>(() => api.ratings(ticker), [ticker]);

  if (busy) return <PanelLoading label="Loading street ratings…" />;
  if (error) return <PanelError error={error} retry={retry} />;
  if (!data) return null;

  const cur = curSymbol(currency);
  const t = data.targets || {};
  const hasTargets = Object.keys(t).length > 0;
  const n = (v: unknown) => (typeof v === "number" ? `${cur}${fmtNum(v, 2)}` : (v ? `${cur}${v}` : "—"));
  const hasRecs = data.recommendations.rows.length > 0;

  if (!hasTargets && !hasRecs) {
    return <div className="panel-2 p-4 text-mut text-sm">Analyst rating data unavailable for {ticker}.</div>;
  }

  return (
    <div className="space-y-6">
      {hasTargets && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Mean target" value={n(t.mean ?? t.median)} />
          <MetricCard label="High" value={n(t.high)} />
          <MetricCard label="Low" value={n(t.low)} />
          <MetricCard label="Current" value={n(t.current)} />
        </div>
      )}
      {hasRecs && (
        <div><div className="heading mb-2">Recommendation trend</div><FrameTable frame={data.recommendations} /></div>
      )}
    </div>
  );
}
