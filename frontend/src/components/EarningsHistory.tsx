"use client";

import { useMemo } from "react";

import { FrameTable } from "@/components/FrameTable";
import { MetricCard } from "@/components/MetricCard";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { Note } from "@/components/ui";
import { api, type Frame } from "@/lib/api";
import { parseSurprises, surpriseNote, surpriseSummary } from "@/lib/earnings";
import { useAsync } from "@/lib/useAsync";
import { fmtNum } from "@/lib/utils";

/**
 * ERN — reported versus expected.
 *
 * The old screen drew a bar per quarter and printed the provider's raw frame
 * underneath. Neither answers what anyone brings to it: does this company
 * habitually beat, by how much, and is that changing? A single beat is
 * noise; a record with a hit rate and a typical size is a fact about how
 * management guides, and it is what makes the next print interpretable.
 */
export function EarningsHistory({ ticker }: { ticker: string }) {
  const { data, error, busy, retry, serverFault } =
    useAsync<Frame>(() => api.earningsHistory(ticker), [ticker]);

  const rows = useMemo(() => parseSurprises(data), [data]);
  const sum = useMemo(() => surpriseSummary(rows), [rows]);

  if (busy) return <PanelLoading label="Loading earnings history…" rows={5} />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;

  const maxAbs = Math.max(1, ...rows.map((d) =>
    Math.max(Math.abs(d.actual), Math.abs(d.estimate))));

  return (
    <div className="space-y-5">
      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Hit rate"
              value={sum.beatRatePct == null ? "—" : `${fmtNum(sum.beatRatePct, 0)}%`}
              tone={sum.beatRatePct == null ? "neutral"
                : sum.beatRatePct >= 75 ? "positive"
                : sum.beatRatePct < 50 ? "negative" : "neutral"} />
            <MetricCard
              label="Typical surprise (median)"
              value={sum.medianSurprisePct == null ? "—"
                : `${sum.medianSurprisePct >= 0 ? "+" : ""}${fmtNum(sum.medianSurprisePct, 1)}%`}
              tone={sum.medianSurprisePct == null ? "neutral"
                : sum.medianSurprisePct >= 0 ? "positive" : "negative"} />
            <MetricCard
              label="Record"
              value={`${sum.beats}B / ${sum.misses}M${sum.inLine ? ` / ${sum.inLine}=` : ""}`}
              title="Beats / misses / in line. An exact match is neither a beat nor a miss." />
            <MetricCard
              label="Current beat streak"
              value={sum.currentStreak ? `${sum.currentStreak}` : "0"}
              tone={sum.currentStreak >= 3 ? "positive" : "neutral"} />
          </div>

          <Note>{surpriseNote(sum)}</Note>

          <div>
            <div className="heading mb-2">EPS: actual vs estimate</div>
            <div className="panel-2 p-4 space-y-3">
              {rows.map((d, i) => (
                <div key={i}>
                  <div className="flex flex-wrap justify-between gap-2 text-[11px] mb-1">
                    <span className="text-mut">{d.period}</span>
                    <span className="num text-mut">
                      act {fmtNum(d.actual, 2)} · est {fmtNum(d.estimate, 2)}
                      {d.surprisePct != null && (
                        <span className={`ml-2 ${d.beat ? "text-green" : "text-red"}`}>
                          {d.surprisePct >= 0 ? "+" : ""}{fmtNum(d.surprisePct, 1)}%
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex gap-1 items-center">
                    <div className="h-2.5 bg-mut/50 rounded"
                         style={{ width: `${(Math.abs(d.estimate) / maxAbs) * 50}%` }}
                         title="Estimate" />
                    <div className={`h-2.5 rounded ${d.beat ? "bg-green" : "bg-red"}`}
                         style={{ width: `${(Math.abs(d.actual) / maxAbs) * 50}%` }}
                         title="Actual" />
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
        </>
      )}

      <div>
        <div className="heading mb-2">Earnings history</div>
        <FrameTable frame={data} empty="Earnings history unavailable." />
      </div>

      {rows.length > 0 && (
        <Note>
          Surprise is measured against the estimate&apos;s magnitude, so a
          company expected to lose 0.50 that loses 0.40 shows a{" "}
          <span className="text-green">+20%</span> beat rather than a −20%
          miss. &ldquo;In line&rdquo; is counted separately from a miss: an
          exact match is neither. Estimates are whatever consensus the free
          feed carries — no analyst count comes with it, so a figure set by
          two analysts and one set by thirty look identical here.
        </Note>
      )}
    </div>
  );
}
