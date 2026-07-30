"use client";

import { useMemo } from "react";

import { FrameTable } from "@/components/FrameTable";
import { MetricCard } from "@/components/MetricCard";
import { Methodology } from "@/components/Methodology";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { Note } from "@/components/ui";
import { api, type Ownership as Own } from "@/lib/api";
import { holderConcentration, ownershipNote } from "@/lib/streetView";
import { useAsync } from "@/lib/useAsync";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * OWN — who holds it, and how tightly.
 *
 * The screen listed the top holders and stopped. A list answers "who owns
 * this"; a position needs the other question — can one of them selling move
 * the price — and that is concentration, which the list does not show.
 */
export function Ownership({ ticker }: { ticker: string }) {
  const { data, error, busy, retry, serverFault } =
    useAsync<Own>(() => api.ownership(ticker), [ticker]);

  // Institutional and fund registers are two disclosures of the same thing;
  // concentration is measured over the larger of them rather than summing,
  // because a fund can appear in both and would be double-counted.
  const conc = useMemo(() => {
    const inst = holderConcentration(data?.institutional_holders ?? null);
    const fund = holderConcentration(data?.mutualfund_holders ?? null);
    return (inst.top5Pct ?? 0) >= (fund.top5Pct ?? 0) ? inst : fund;
  }, [data]);

  if (busy) return <PanelLoading label="Loading ownership…" rows={5} />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;
  if (!data) return null;

  const empty = data.major_holders.rows.length === 0
    && data.institutional_holders.rows.length === 0
    && data.mutualfund_holders.rows.length === 0
    && data.officers.length === 0;

  if (empty) return <div className="panel-2 p-4 text-mut text-sm">Ownership data unavailable for {ticker}.</div>;

  return (
    <div className="space-y-6">
      {conc.top5Pct != null && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Top 5 holders own"
                        value={`${fmtNum(conc.top5Pct, 1)}%`}
                        tone={conc.top5Pct > 40 ? "negative" : "neutral"} />
            <MetricCard label="Largest single stake"
                        value={`${fmtNum(conc.top1Pct!, 1)}%`}
                        tone={conc.top1Pct! > 10 ? "negative" : "neutral"} />
            <MetricCard label="Largest holder"
                        value={conc.largest!.name.length > 22
                          ? `${conc.largest!.name.slice(0, 21)}…`
                          : conc.largest!.name}
                        title={conc.largest!.name} />
            <MetricCard label="Disclosed holders" value={conc.n} />
          </div>
          <Note>{ownershipNote(conc)}</Note>
        </>
      )}

      {data.major_holders.rows.length > 0 && (
        <div><div className="heading mb-2">Ownership summary</div><FrameTable frame={data.major_holders} /></div>
      )}
      {data.institutional_holders.rows.length > 0 && (
        <div><div className="heading mb-2">Top institutional holders</div><FrameTable frame={data.institutional_holders} humanise /></div>
      )}
      {data.mutualfund_holders.rows.length > 0 && (
        <div><div className="heading mb-2">Top mutual-fund holders</div><FrameTable frame={data.mutualfund_holders} humanise /></div>
      )}
      {data.officers.length > 0 && (
        <div>
          <div className="heading mb-2">Key officers</div>
          <div className="panel overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-mut uppercase tracking-wider">
                <tr className="border-b border-line">
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Title</th>
                  <th className="text-right px-3 py-2 font-medium">Pay</th>
                  <th className="text-right px-3 py-2 font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {data.officers.map((o, i) => (
                  <tr key={i} className="border-b border-line/60 hover:bg-panel">
                    <td className="px-3 py-2 text-txt">{o.name || "—"}</td>
                    <td className="px-3 py-2 text-txt/80">{o.title || "—"}</td>
                    <td className="px-3 py-2 num text-right">{o.pay != null ? humanNumber(o.pay) : "—"}</td>
                    <td className="px-3 py-2 num text-right">{o.age ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Methodology id="ownership" />
    </div>
  );
}
