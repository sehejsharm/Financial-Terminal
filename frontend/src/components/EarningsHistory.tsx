"use client";

import { useEffect, useState } from "react";

import { FrameTable } from "@/components/FrameTable";
import { api, type Frame } from "@/lib/api";

export function EarningsHistory({ ticker }: { ticker: string }) {
  const [data, setData] = useState<Frame | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true); setErr(null); setData(null);
    api.earningsHistory(ticker).then(setData).catch((e) => setErr(e?.detail || "Failed to load.")).finally(() => setBusy(false));
  }, [ticker]);

  if (busy) return <div className="text-mut text-xs">Loading earnings history…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;

  // Find actual vs estimate columns for a beat/miss bar (case-insensitive).
  const cols = data?.columns ?? [];
  const actCol = cols.find((c) => c.toLowerCase() === "epsactual");
  const estCol = cols.find((c) => c.toLowerCase() === "epsestimate");
  const periodCol = cols.find((c) => /date|quarter|period|index/i.test(c)) ?? cols[0];
  const series = (data?.rows ?? [])
    .map((r) => ({
      label: String(r[periodCol] ?? "").slice(0, 10),
      act: Number(r[actCol ?? ""] ?? NaN),
      est: Number(r[estCol ?? ""] ?? NaN),
    }))
    .filter((d) => Number.isFinite(d.act) && Number.isFinite(d.est));
  const maxAbs = Math.max(1, ...series.map((d) => Math.max(Math.abs(d.act), Math.abs(d.est))));

  return (
    <div className="space-y-5">
      {series.length > 0 && (
        <div>
          <div className="heading mb-2">EPS: actual vs estimate</div>
          <div className="panel-2 p-4 space-y-3">
            {series.map((d, i) => (
              <div key={i}>
                <div className="flex justify-between text-[11px] text-mut mb-1">
                  <span>{d.label}</span>
                  <span className="num">act {d.act.toFixed(2)} · est {d.est.toFixed(2)}</span>
                </div>
                <div className="flex gap-1 items-center">
                  <div className="h-2.5 bg-mut/50 rounded" style={{ width: `${(Math.abs(d.est) / maxAbs) * 50}%` }} title="Estimate" />
                  <div className={`h-2.5 rounded ${d.act >= d.est ? "bg-green" : "bg-red"}`}
                       style={{ width: `${(Math.abs(d.act) / maxAbs) * 50}%` }} title="Actual" />
                </div>
              </div>
            ))}
            <div className="flex gap-4 text-[10px] text-mut pt-1">
              <span><span className="inline-block w-2.5 h-2.5 bg-mut/50 rounded mr-1 align-middle" />Estimate</span>
              <span><span className="inline-block w-2.5 h-2.5 bg-green rounded mr-1 align-middle" />Beat</span>
              <span><span className="inline-block w-2.5 h-2.5 bg-red rounded mr-1 align-middle" />Miss</span>
            </div>
          </div>
        </div>
      )}
      <div><div className="heading mb-2">Earnings history</div><FrameTable frame={data} empty="Earnings history unavailable." /></div>
    </div>
  );
}
