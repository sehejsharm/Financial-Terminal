"use client";

import { useMemo } from "react";

import { Methodology } from "@/components/Methodology";
import { Note, SectionHeader } from "@/components/ui";
import { tintBg } from "@/lib/heat";
import {
  attribution, attributionNote, betaBreakdown, betaNote, concentration,
  concentrationNote, sectorConcentration, type Row,
} from "@/lib/portfolioAnalytics";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * What the book is doing, as opposed to what it is worth.
 *
 * PORT could tell you the total P&L, the weighted beta and the sector split.
 * None of those answer the questions a holder actually has: which positions
 * made the money, how concentrated am I really, and where is the market
 * sensitivity coming from. All three are computable from the rows already on
 * the page.
 */
export function BookAnalytics({ positions, sectors, cur, mixedCcy }: {
  positions: Row[];
  sectors: { sector: string; weight: number }[];
  cur: string;
  mixedCcy: boolean;
}) {
  const attr = useMemo(() => attribution(positions), [positions]);
  const conc = useMemo(() => concentration(positions), [positions]);
  const sectorConc = useMemo(() => sectorConcentration(sectors), [sectors]);
  const beta = useMemo(() => betaBreakdown(positions), [positions]);

  if (!positions.length) return null;

  const money = (n: number) => humanNumber(n, mixedCcy ? "" : cur);

  return (
    <div className="mt-6">
      {/* ── concentration ─────────────────────────────────────────────── */}
      <SectionHeader title="Concentration"
                     count={`${conc.positions} priced positions`} />
      <div className="grid gap-2.5 mb-2"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <div className="hud p-3"
             title="1 / HHI — the number of equal-sized positions this book behaves like">
          <div className="label-xs">Effective positions</div>
          <div className={`num text-lg mt-0.5 ${
            conc.band === "concentrated" ? "text-red"
              : conc.band === "diversified" ? "text-green" : "text-txt"}`}>
            {conc.effectiveN == null ? "—" : fmtNum(conc.effectiveN, 1)}
          </div>
          <div className="text-[10px] text-mut mt-1 capitalize">{conc.band}</div>
        </div>
        <div className="hud p-3">
          <div className="label-xs">Largest position</div>
          <div className={`num text-lg mt-0.5 ${
            (conc.topPct ?? 0) > 25 ? "text-amber" : "text-txt"}`}>
            {conc.topPct == null ? "—" : `${fmtNum(conc.topPct, 1)}%`}
          </div>
        </div>
        <div className="hud p-3">
          <div className="label-xs">Top 3 / top 5</div>
          <div className="num text-lg mt-0.5 text-txt">
            {conc.top3Pct == null ? "—"
              : `${fmtNum(conc.top3Pct, 0)}% / ${fmtNum(conc.top5Pct!, 0)}%`}
          </div>
        </div>
        <div className="hud p-3" title="The same measure over sector weights">
          <div className="label-xs">Effective sectors</div>
          <div className={`num text-lg mt-0.5 ${
            (sectorConc.effectiveN ?? 99) < 3 ? "text-red" : "text-txt"}`}>
            {sectorConc.effectiveN == null ? "—" : fmtNum(sectorConc.effectiveN, 1)}
          </div>
        </div>
      </div>
      <Note>{concentrationNote(conc, sectorConc)}</Note>

      {/* ── attribution ───────────────────────────────────────────────── */}
      <div className="mt-6">
        <SectionHeader
          title="Where the P&L came from"
          count={attr.priced ? `${attr.priced} priced` : undefined}
          actions={
            <span className={`num text-[11px] ${
              attr.totalPnl >= 0 ? "text-green" : "text-red"}`}>
              {money(attr.totalPnl)} total
            </span>
          } />
        {attr.priced === 0 ? (
          <Note>{attributionNote(attr)}</Note>
        ) : (
          <>
            <div className="overflow-x-auto mb-2">
              <table className="w-full text-[11px]" data-testid="attribution">
                <thead>
                  <tr className="text-mut border-b border-line2">
                    <th className="text-left font-normal py-1.5 pr-3">Position</th>
                    <th className="text-right font-normal py-1.5 px-3">P&amp;L</th>
                    <th className="text-right font-normal py-1.5 px-3">On position</th>
                    <th className="text-right font-normal py-1.5 px-3">On book</th>
                    <th className="text-right font-normal py-1.5 pl-3"
                        title="Share of the sum of ABSOLUTE P&L — not of the net, which is unbounded">
                      Share of movement
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {attr.rows.map((c) => (
                    <tr key={c.ticker} className="border-b border-line2/50">
                      <td className="py-1.5 pr-3 text-txt whitespace-nowrap">
                        {c.ticker}
                        {c.sector && (
                          <span className="text-mut text-[10px] ml-1.5">{c.sector}</span>
                        )}
                      </td>
                      <td className={`py-1.5 px-3 text-right num whitespace-nowrap ${
                        c.pnl >= 0 ? "text-green" : "text-red"}`}>
                        {money(c.pnl)}
                      </td>
                      <td className={`py-1.5 px-3 text-right num whitespace-nowrap ${
                        c.pnlPct == null ? "text-mut"
                          : c.pnlPct >= 0 ? "text-green" : "text-red"}`}>
                        {c.pnlPct == null ? "—"
                          : `${c.pnlPct >= 0 ? "+" : ""}${fmtNum(c.pnlPct, 1)}%`}
                      </td>
                      <td className="py-1.5 px-3 text-right num text-txt whitespace-nowrap">
                        {c.bookPct == null ? "—"
                          : `${c.bookPct >= 0 ? "+" : ""}${fmtNum(c.bookPct, 2)}%`}
                      </td>
                      <td className="py-1.5 pl-3 text-right num text-txt whitespace-nowrap"
                          style={{ background: tintBg(
                            c.pnl >= 0 ? c.sharePct : -c.sharePct, 40) }}>
                        {fmtNum(c.sharePct, 1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>{attributionNote(attr)}</Note>
          </>
        )}
      </div>

      {/* ── where the beta comes from ─────────────────────────────────── */}
      <div className="mt-6">
        <SectionHeader
          title="Where the market sensitivity comes from"
          actions={beta.weightedBeta != null ? (
            <span className="num text-[11px] text-txt">
              beta {fmtNum(beta.weightedBeta, 2)}
              {beta.coveragePct != null && beta.coveragePct < 100 && (
                <span className="text-mut ml-1.5">
                  ({fmtNum(beta.coveragePct, 0)}% covered)
                </span>
              )}
            </span>
          ) : undefined} />
        {beta.rows.length > 0 && (
          <div className="grid gap-2.5 mb-2"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            {beta.rows.slice(0, 6).map((r) => (
              <div key={r.ticker} className="hud p-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] text-txt flex-1 min-w-0 truncate">
                    {r.ticker}
                  </span>
                  <span className="num text-[11px] text-mut shrink-0">
                    β {fmtNum(r.beta, 2)}
                  </span>
                </div>
                <div className="num text-base mt-1 text-txt">
                  {fmtNum(r.contribution, 2)}
                  <span className="text-[10px] text-mut ml-1.5">
                    of the book&apos;s beta
                  </span>
                </div>
                <div className="h-1 bg-panel rounded overflow-hidden mt-1.5">
                  <div className="h-full bg-amber/70"
                       style={{ width: `${Math.min(100, r.weightPct)}%` }} />
                </div>
                <div className="text-[10px] text-mut mt-1 num">
                  {fmtNum(r.weightPct, 1)}% of the book
                </div>
              </div>
            ))}
          </div>
        )}
        <Note>{betaNote(beta)}</Note>
      </div>

      <Methodology id="bookAnalytics" className="mt-3" />
    </div>
  );
}
