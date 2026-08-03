"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { api, type CompRow, type Note, type Quote, type Snapshot } from "@/lib/api";
import {
  compCell, compLabel, headerCoverage, isSubject, provenanceNote,
} from "@/lib/tearsheetMeta";
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

  // Stamped ONCE, not read during render: a clock read inside a render drifts
  // between the header and the footer of the same printed page.
  const [printedAt] = useState(() => new Date());
  const [notFound, setNotFound] = useState(false);
  const [suggestions, setSuggestions] = useState<{ symbol: string; name: string }[]>([]);

  useEffect(() => {
    let alive = true;
    setNotFound(false); setSuggestions([]);
    Promise.allSettled([
      api.snapshot(ticker).then((s) => alive && setSnap(s)),
      api.quote(ticker).then((q) => alive && setQuote(q)),
      // Peers by sector+exchange (same source as the terminal Comparables).
      api.peers(ticker)
        .then((p) => api.comps(p.peers))
        .catch(() => api.comps([ticker]))
        .then((c) => alive && setComps(c)),
      api.note(ticker).then((n) => alive && setNote(n)),
    ]).then((results) => {
      if (!alive) return;
      setReady(true);
      // Both quote AND snapshot failed -> the symbol doesn't resolve.
      const [s, q] = results;
      if (s.status === "rejected" && q.status === "rejected") {
        setNotFound(true);
        api.search(ticker).then((hits) => alive && setSuggestions((hits ?? []).slice(0, 5))).catch(() => {});
      }
    });
    return () => { alive = false; };
  }, [ticker]);

  if (notFound) {
    return (
      <div className="max-w-[820px] mx-auto p-8 bg-bg text-txt min-h-screen">
        <h1 className="text-xl font-bold mb-2">Symbol not found: <span className="text-amber">{ticker}</span></h1>
        <p className="text-mut text-sm mb-4">
          No data provider recognizes this ticker. Check the suffix — NSE listings need
          <code className="text-amber"> .NS</code> (e.g. RELIANCE.NS); US listings take none (e.g. AAPL).
        </p>
        {suggestions.length > 0 && (
          <>
            <div className="label-xs mb-2">Did you mean</div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <a key={s.symbol} href={`/tearsheet?t=${encodeURIComponent(s.symbol)}`} className="btn-ghost">
                  {s.symbol} <span className="text-mut normal-case">· {s.name}</span>
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

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
          {/* Deliberately NOT "as of <now>": that was the browser clock at
              render, which on paper is indistinguishable from a live quote.
              The footer says what the number actually is. */}
          <div className="text-mut text-[10px]">last reported price</div>
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
          <table className="w-full text-xs mb-4 panel-2" data-testid="comps">
            <thead><tr className="border-b border-line text-mut">
              {Object.keys(comps[0]).map((c) => (
                <th key={c} className="text-left px-2 py-1">{compLabel(c)}</th>
              ))}
            </tr></thead>
            <tbody>{comps.map((r, i) => {
              const subject = isSubject(r as Record<string, unknown>, ticker);
              return (
                <tr key={i}
                    className={`border-b border-line/50 ${subject ? "text-amber font-semibold" : ""}`}>
                  {Object.keys(comps[0]).map((c) => (
                    <td key={c} className="px-2 py-1 num">{compCell(c, r[c], cur)}</td>
                  ))}
                </tr>
              );
            })}</tbody>
          </table>
        </>
      )}

      {note?.text && (
        <>
          <div className="heading mb-1">Research notes</div>
          <div className="panel-2 p-3 text-sm whitespace-pre-wrap mb-4">{note.text}</div>
        </>
      )}

      <div className="text-[10px] text-mut border-t border-line pt-2 leading-relaxed">
        Motherboard Terminal tear sheet — educational research aid, not
        investment advice. Data from free provider feeds (NSE / FMP / yfinance).{" "}
        {provenanceNote(headerCoverage(snap), printedAt)}
        {!ready && " (still loading…)"}
      </div>
    </div>
  );
}

export default function TearSheetPage() {
  return <Suspense><TearSheetInner /></Suspense>;
}
