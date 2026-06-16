"use client";

import { useEffect, useState } from "react";

import { FrameTable } from "@/components/FrameTable";
import { MetricCard } from "@/components/MetricCard";
import { api, type Ratings } from "@/lib/api";
import { curSymbol, fmtNum } from "@/lib/utils";

export function StreetRatings({ ticker, currency }: { ticker: string; currency: string }) {
  const [data, setData] = useState<Ratings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true); setErr(null); setData(null);
    api.ratings(ticker).then(setData).catch((e) => setErr(e?.detail || "Failed to load.")).finally(() => setBusy(false));
  }, [ticker]);

  if (busy) return <div className="text-mut text-xs">Loading street ratings…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;
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
