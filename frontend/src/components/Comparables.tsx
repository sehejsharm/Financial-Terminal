"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type CompRow } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

/** Peer relative-valuation matrix. Editable peer list, defaults to IT majors.
 *  `peers` (from the ⌘K command line, e.g. "RELIANCE TCS INFY CF") overrides
 *  the default set. */
export function Comparables({ ticker, peers }: { ticker: string; peers?: string[] }) {
  const defaults = (peers && peers.length
    ? [ticker, ...peers.filter((p) => p !== ticker)]
    : [ticker, "TCS.NS", "INFY.NS", "WIPRO.NS"]).join(", ");
  const [input, setInput] = useState(defaults);
  const [rows, setRows] = useState<CompRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load(peers: string) {
    const ts = peers.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!ts.length) return;
    setBusy(true); setErr(null);
    api.comps(ts).then(setRows).catch((e) => setErr(e?.detail || "Comps failed.")).finally(() => setBusy(false));
  }

  useEffect(() => { setInput(defaults); load(defaults); /* eslint-disable-next-line */ }, [ticker]);

  const cols = rows && rows.length ? Object.keys(rows[0]) : [];

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input value={input} onChange={(e) => setInput(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") load(input); }}
               className="input-bare flex-1" placeholder="Peer tickers, comma-separated" />
        <button onClick={() => load(input)} disabled={busy} className="btn-primary">
          {busy ? "Loading…" : "Compare"}
        </button>
      </div>
      {err && <div className="text-red text-sm mb-2">{err}</div>}
      {rows && rows.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No comparable data.</div>}
      {rows && rows.length > 0 && (
        <div className="panel overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                {cols.map((c) => <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">{c}</th>)}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60 hover:bg-panel">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 num whitespace-nowrap text-txt/90">
                      {typeof r[c] === "number" ? fmtNum(r[c] as number, 2) : (r[c] ?? "—")}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    {r.Ticker && (
                      <Link href={`/terminal?t=${encodeURIComponent(String(r.Ticker).includes(".") ? String(r.Ticker) : String(r.Ticker) + ".NS")}`}
                            className="text-amber hover:underline">Open →</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[10.5px] text-mut mt-2">EV/EBITDA* uses market cap as an EV proxy (no debt-layer feed on free data).</div>
    </div>
  );
}
