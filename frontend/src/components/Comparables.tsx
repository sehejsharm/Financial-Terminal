"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ScrollX } from "@/components/ScrollX";
import { api, type CompRow } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

/** Peer relative-valuation matrix. Peer set comes from the backend's
 *  sector + exchange map (AAPL gets US tech peers, RELIANCE.NS gets NSE
 *  energy peers — never cross-exchange). Explicit `peers` (from the ⌘K
 *  command line, e.g. "RELIANCE TCS INFY CF") overrides; the input stays
 *  fully editable either way. */
export function Comparables({ ticker, peers }: { ticker: string; peers?: string[] }) {
  const [input, setInput] = useState("");
  const [basis, setBasis] = useState<string | null>(null);
  const [rows, setRows] = useState<CompRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load(peerStr: string) {
    const ts = peerStr.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!ts.length) return;
    setBusy(true); setErr(null);
    api.comps(ts).then(setRows).catch((e) => setErr(e?.detail || "Comps failed.")).finally(() => setBusy(false));
  }

  useEffect(() => {
    let alive = true;
    setRows(null); setBasis(null);
    if (peers && peers.length) {
      const s = [ticker, ...peers.filter((p) => p !== ticker)].join(", ");
      setInput(s); load(s);
      return;
    }
    api.peers(ticker)
      .then((p) => {
        if (!alive) return;
        const s = p.peers.join(", ");
        setInput(s); setBasis(p.basis === "sector+exchange" ? p.sector : null);
        load(s);
      })
      .catch(() => {
        if (!alive) return;
        const s = ticker; // peers endpoint down — compare the subject alone
        setInput(s); load(s);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, peers?.join(",")]);

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
      {basis && (
        <div className="text-[10.5px] text-mut mb-2">
          Peers auto-selected by sector ({basis}) + exchange — edit the list above to customize.
        </div>
      )}
      {err && <div className="text-red text-sm mb-2">{err}</div>}
      {rows && rows.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No comparable data.</div>}
      {rows && rows.length > 0 && (
        <ScrollX className="panel">
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
        </ScrollX>
      )}
      <div className="text-[10.5px] text-mut mt-2">EV/EBITDA* uses market cap as an EV proxy (no debt-layer feed on free data).</div>
    </div>
  );
}
