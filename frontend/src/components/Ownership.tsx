"use client";

import { FrameTable } from "@/components/FrameTable";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { api, type Ownership as Own } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { humanNumber } from "@/lib/utils";

export function Ownership({ ticker }: { ticker: string }) {
  const { data, error, busy, retry, serverFault } = useAsync<Own>(() => api.ownership(ticker), [ticker]);

  if (busy) return <PanelLoading label="Loading ownership…" />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;
  if (!data) return null;

  const empty = data.major_holders.rows.length === 0
    && data.institutional_holders.rows.length === 0
    && data.mutualfund_holders.rows.length === 0
    && data.officers.length === 0;

  if (empty) return <div className="panel-2 p-4 text-mut text-sm">Ownership data unavailable for {ticker}.</div>;

  return (
    <div className="space-y-6">
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
    </div>
  );
}
