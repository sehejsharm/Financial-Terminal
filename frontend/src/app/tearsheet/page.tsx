"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { api, type CompRow, type Note, type Quote, type Snapshot } from "@/lib/api";
import { curForTicker, fmtNum, formatPercent, humanNumber } from "@/lib/utils";

/** One-page printable tear sheet: snapshot + valuation + comps + your notes.
 *  Opens in a new tab; use the browser print dialog to save as PDF. */
function TearSheetInner() {
  const sp = useSearchParams();
  const ticker = (sp.get("t") || "RELIANCE.NS").toUpperCase();

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [comps, setComps] = useState<CompRow[] | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      api.snapshot(ticker).then((s) => alive && setSnap(s)),
      api.quote(ticker).then((q) => alive && setQuote(q)),
      api.comps([ticker, "TCS.NS", "INFY.NS", "WIPRO.NS"].filter((v, i, a) => a.indexOf(v) === i))
        .then((c) => alive && setComps(c)),
      api.note(ticker).then((n) => alive && setNote(n)),
    ]).then(() => alive && setReady(true));
    return () => { alive = false; };
  }, [ticker]);

  const cur = curForTicker(ticker, (snap?.currency as string) || quote?.currency);
  const price = (snap?.price ?? quote?.price) ?? null;

  return (
    <div className="max-w-[820px] mx-auto p-8 print:p-0 bg-bg text-txt min-h-screen">
      {/* print helper */}
      <style>{`@media print { body { background: white !important; color: #111 !important; }
        .panel-2, .panel { border-color: #ccc !important; background: white !important; }
        .text-mut { color: #555 !important; } .text-amber { color: #92600a !important; }
        .no-print { display: none !important; } }`}</style>

      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-amber text-xs uppercase tracking-[0.18em]">{ticker}</div>
          <h1 className="text-2xl font-bold">{(snap?.name as string) || ticker}</h1>
          <div className="text-mut text-xs">{(snap?.sector as string) || "—"} / {(snap?.industry as string) || "—"}</div>
        </div>
        <div className="text-right">
          <div className="num text-2xl">{price != null ? `${cur}${fmtNum(price, 2)}` : "—"}</div>
          <div className="text-mut text-[10px]">as of {new Date().toLocaleString()}</div>
        </div>
      </div>

      <button onClick={() => window.print()} className="no-print btn-primary my-3">
        Print / Save as PDF
      </button>

      <div className="grid grid-cols-4 gap-2 my-4 text-center">
        {[
          ["Mkt cap", humanNumber(snap?.market_cap as number, cur)],
          ["P/E", fmtNum(snap?.trailing_pe as number, 1)],
          ["Beta", fmtNum(snap?.beta as number, 2)],
          ["Div yield", formatPercent(snap?.dividend_yield as number)],
          ["ROE", formatPercent(snap?.roe as number, { fraction: true })],
          ["Margin", formatPercent(snap?.profit_margin as number, { fraction: true })],
          ["D/E", snap?.debt_to_equity != null ? `${fmtNum((snap.debt_to_equity as number) / 100, 2)}x` : "—"],
          ["52w", `${fmtNum(snap?.fifty_two_low as number, 0)}–${fmtNum(snap?.fifty_two_high as number, 0)}`],
        ].map(([l, v]) => (
          <div key={l as string} className="panel-2 p-2">
            <div className="label-xs">{l}</div>
            <div className="num text-sm">{v}</div>
          </div>
        ))}
      </div>

      {comps && comps.length > 0 && (
        <>
          <div className="heading mb-1">Comparables</div>
          <table className="w-full text-xs mb-4 panel-2">
            <thead><tr className="border-b border-line text-mut">
              {Object.keys(comps[0]).map((c) => <th key={c} className="text-left px-2 py-1">{c}</th>)}
            </tr></thead>
            <tbody>{comps.map((r, i) => (
              <tr key={i} className="border-b border-line/50">
                {Object.keys(comps[0]).map((c) => (
                  <td key={c} className="px-2 py-1 num">{r[c] == null ? "—" : String(r[c])}</td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </>
      )}

      {note?.text && (
        <>
          <div className="heading mb-1">Research notes</div>
          <div className="panel-2 p-3 text-sm whitespace-pre-wrap mb-4">{note.text}</div>
        </>
      )}

      <div className="text-[10px] text-mut border-t border-line pt-2">
        Motherboard Terminal tear sheet — educational research aid, not investment advice.
        Data from free provider feeds (NSE / FMP / yfinance); verify before use.
        {!ready && " (still loading…)"}
      </div>
    </div>
  );
}

export default function TearSheetPage() {
  return <Suspense><TearSheetInner /></Suspense>;
}
