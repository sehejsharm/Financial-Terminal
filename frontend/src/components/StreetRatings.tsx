"use client";

import { useMemo } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Methodology } from "@/components/Methodology";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { Note } from "@/components/ui";
import { api, type Ratings } from "@/lib/api";
import {
  consensusLabel, parseRecommendations, recTrend, REC_BUCKETS, streetNote,
} from "@/lib/streetView";
import { useAsync } from "@/lib/useAsync";
import { curSymbol, fmtNum } from "@/lib/utils";

/**
 * ANR — what the street thinks, and which way it is moving.
 *
 * The old screen showed four target cards and dumped the recommendation
 * frame as a table of month codes and counts. Both things a reader wants
 * were missing: the shape of the distribution now, and whether it is
 * improving. A downgrade cycle is visible in the trend and invisible in the
 * latest row, and the latest row was all you got.
 */

const BUCKET_TONE: Record<string, string> = {
  strongBuy: "bg-green",
  buy: "bg-green/60",
  hold: "bg-mut/50",
  sell: "bg-red/60",
  strongSell: "bg-red",
};

function Distribution({ counts, total }: {
  counts: Record<string, number>; total: number;
}) {
  if (!total) return null;
  return (
    <div>
      <div className="flex h-5 rounded overflow-hidden border border-line2">
        {REC_BUCKETS.map((b) => {
          const n = counts[b.key] ?? 0;
          if (!n) return null;
          const pct = (n / total) * 100;
          return (
            <div key={b.key} className={`${BUCKET_TONE[b.key]} flex items-center
                                         justify-center text-[9px] text-black font-bold`}
                 style={{ width: `${pct}%` }}
                 title={`${b.label}: ${n} of ${total}`}>
              {pct > 9 ? n : ""}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[10px] text-mut">
        {REC_BUCKETS.map((b) => (
          <span key={b.key}>
            <span className={`inline-block w-2.5 h-2.5 rounded mr-1 align-middle
                              ${BUCKET_TONE[b.key]}`} />
            {b.label} <span className="num text-txt">{counts[b.key] ?? 0}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function StreetRatings({ ticker, currency }: { ticker: string; currency: string }) {
  const { data, error, busy, retry, serverFault } =
    useAsync<Ratings>(() => api.ratings(ticker), [ticker]);

  const periods = useMemo(() => parseRecommendations(data?.recommendations ?? null),
                          [data]);
  const trend = useMemo(() => recTrend(periods), [periods]);

  if (busy) return <PanelLoading label="Loading street ratings…" rows={5} />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;
  if (!data) return null;

  const cur = curSymbol(currency);
  const t = data.targets || {};
  const hasTargets = Object.keys(t).length > 0;
  const money = (v: unknown) =>
    (typeof v === "number" ? `${cur}${fmtNum(v, 2)}` : (v ? `${cur}${v}` : "—"));

  const price = typeof t.current === "number" ? t.current : null;
  const mean = typeof t.mean === "number" ? t.mean
    : typeof t.median === "number" ? t.median : null;
  const upside = price != null && mean != null && price > 0
    ? ((mean - price) / price) * 100 : null;

  if (!hasTargets && !periods.length) {
    return (
      <div className="panel-2 p-4 text-mut text-sm">
        Analyst rating data unavailable for {ticker}. Free-tier coverage of
        Indian mid- and small-caps is thin; this is a gap in the feed rather
        than an absence of coverage.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {periods.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Consensus"
              value={consensusLabel(trend.latest?.score ?? null) ?? "—"}
              tone={(trend.latest?.score ?? 3) <= 2.5 ? "positive"
                : (trend.latest?.score ?? 3) >= 3.5 ? "negative" : "neutral"} />
            <MetricCard label="Analysts covering" value={trend.latest?.total ?? "—"} />
            <MetricCard
              label="Buy or better"
              value={trend.latest?.bullishPct == null ? "—"
                : `${fmtNum(trend.latest.bullishPct, 0)}%`} />
            <MetricCard
              label="Direction"
              value={trend.direction ?? "—"}
              // The scale runs 1 (strong buy) to 5, so a falling score is an
              // upgrade — the tone follows the meaning, not the sign.
              tone={trend.direction === "upgrading" ? "positive"
                : trend.direction === "downgrading" ? "negative" : "neutral"} />
          </div>

          <div>
            <div className="heading mb-2">Where the ratings sit</div>
            <div className="panel-2 p-4">
              <Distribution counts={trend.latest!.counts} total={trend.latest!.total} />
            </div>
          </div>

          {periods.length > 1 && (
            <div>
              <div className="heading mb-2">How it has moved</div>
              <div className="panel-2 p-4 grid gap-3">
                {periods.map((p) => (
                  <div key={p.period}>
                    <div className="flex justify-between text-[10.5px] text-mut mb-1">
                      <span>{p.period}</span>
                      <span className="num">
                        {p.total} rating{p.total === 1 ? "" : "s"} ·{" "}
                        {consensusLabel(p.score)}
                      </span>
                    </div>
                    <Distribution counts={p.counts} total={p.total} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <Note>{streetNote(trend)}</Note>
        </>
      )}

      {hasTargets && (
        <div>
          <div className="heading mb-2">Price targets ({currency})</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Implied upside to mean"
              value={upside == null ? "—"
                : `${upside >= 0 ? "+" : ""}${fmtNum(upside, 1)}%`}
              tone={upside == null ? "neutral" : upside >= 0 ? "positive" : "negative"} />
            <MetricCard label="Mean target" value={money(t.mean ?? t.median)} />
            <MetricCard label="Low" value={money(t.low)} />
            <MetricCard label="High" value={money(t.high)} />
          </div>
        </div>
      )}

      <Methodology id="street" />
    </div>
  );
}
