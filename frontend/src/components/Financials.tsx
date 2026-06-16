"use client";

import { useEffect, useState } from "react";

import { api, type Statement } from "@/lib/api";
import { humanNumber } from "@/lib/utils";

const KINDS = [
  { key: "income", label: "Income" },
  { key: "balance", label: "Balance sheet" },
  { key: "cashflow", label: "Cash flow" },
] as const;

type Kind = typeof KINDS[number]["key"];

/** Financial statements with period toggle (annual/quarterly) and statement tabs. */
export function Financials({ ticker, currency }: { ticker: string; currency: string }) {
  const [kind, setKind] = useState<Kind>("income");
  const [quarterly, setQuarterly] = useState(false);
  const [data, setData] = useState<Statement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true); setErr(null); setData(null);
    api.statement(ticker, kind, quarterly)
      .then(setData)
      .catch(() => setData({ ticker, kind, columns: [], rows: [] } as Statement))
      .finally(() => setBusy(false));
  }, [ticker, kind, quarterly]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => setKind(k.key)}
            className={`btn ${kind === k.key ? "btn-primary" : "btn-ghost"}`}
          >
            {k.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setQuarterly((v) => !v)}
          className={`btn ${quarterly ? "btn-primary" : "btn-ghost"}`}
        >
          {quarterly ? "Quarterly" : "Annual"}
        </button>
      </div>

      {busy && <div className="text-mut text-xs">Loading statement…</div>}

      {data && !busy && data.rows.length === 0 && (
        <div className="panel-2 p-4 text-mut text-sm">
          Income/balance/cashflow statements for <span className="text-amber">{ticker}</span> aren&apos;t
          available from the free data provider on this host. Yahoo Finance blocks
          datacenter IPs; NSE&apos;s public API doesn&apos;t expose annual reports as structured
          JSON. Set <code className="text-amber">TWELVE_DATA_API_KEY</code> on the backend
          for full statement coverage, or view this section in the Streamlit app.
        </div>
      )}

      {data && !busy && data.rows.length > 0 && (
        <div className="panel overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
              <tr className="border-b border-line">
                <th className="text-left px-3 py-2 font-medium">Line item ({currency})</th>
                {data.columns.map((c) => (
                  <th key={c} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                    {c.slice(0, 10)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60 hover:bg-panel">
                  <td className="px-3 py-2 text-txt whitespace-nowrap">{r.line}</td>
                  {data.columns.map((c) => {
                    const v = r[c];
                    return (
                      <td key={c} className="px-3 py-2 num text-right text-txt/90">
                        {typeof v === "number" ? humanNumber(v) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
