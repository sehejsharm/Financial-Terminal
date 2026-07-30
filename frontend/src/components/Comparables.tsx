"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Methodology } from "@/components/Methodology";
import { ScrollX } from "@/components/ScrollX";
import { Note } from "@/components/ui";
import { api, type CompRow } from "@/lib/api";
import {
  compareAll, findSubject, peerNote, sortComps,
} from "@/lib/peerAnalysis";
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
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Request-id guard: only the latest comps request may apply (fast ticker
  // switching or repeated Compare clicks must not let a slow older response
  // overwrite a newer one).
  const reqRef = useRef(0);

  function load(peerStr: string) {
    const ts = peerStr.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!ts.length) return;
    const reqId = ++reqRef.current;
    setBusy(true); setErr(null);
    api.comps(ts)
      .then((r) => { if (reqRef.current === reqId) setRows(r); })
      .catch((e) => { if (reqRef.current === reqId) setErr(e?.detail || "Comps failed."); })
      .finally(() => { if (reqRef.current === reqId) setBusy(false); });
  }

  useEffect(() => {
    let alive = true;
    reqRef.current++; // invalidate any in-flight comps for the previous ticker
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
  const subjectKey = ticker.split(".")[0].toUpperCase();
  // The comparison, which is the entire point of the screen and was the one
  // thing it did not show: where this name sits against the peer median.
  const comparisons = rows && rows.length ? compareAll(rows, ticker) : [];
  const shown = rows && sort ? sortComps(rows, sort.key, sort.dir) : rows;

  function toggleSort(key: string) {
    setSort((cur) => (cur && cur.key === key
      ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "Ticker" || key === "Name" ? "asc" : "asc" }));
  }

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

      {comparisons.length > 0 && findSubject(rows!, ticker) && (
        <>
          <div className="grid gap-2.5 mb-2"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {comparisons.map((c) => (
              <div key={c.key} className="hud p-3" title={
                c.n < 3 ? "Too few peers report this metric to compare"
                  : `Peer median ${fmtNum(c.peerMedian!, 2)} across ${c.n} names`}>
                <div className="label-xs truncate">{c.label}</div>
                <div className="num text-lg text-txt mt-0.5">
                  {c.value == null ? "—"
                    : `${fmtNum(c.value, 2)}${c.unit === "%" ? "%" : "x"}`}
                </div>
                <div className="text-[10px] mt-1 leading-relaxed">
                  {c.premiumPct == null ? (
                    <span className="text-mut">
                      {c.peerMedian == null ? "no peer median"
                        : `median ${fmtNum(c.peerMedian, 2)} · too few peers`}
                    </span>
                  ) : (
                    <>
                      <span className={
                        c.verdict === "expensive" || c.verdict === "weak" ? "text-red"
                          : c.verdict === "cheap" || c.verdict === "strong" ? "text-green"
                          : "text-mut"}>
                        {c.premiumPct >= 0 ? "+" : ""}{fmtNum(c.premiumPct, 0)}% vs median
                      </span>
                      <span className="text-mut">
                        {" "}· {c.verdict} · rank {c.rank}/{c.n}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Note>{peerNote(comparisons, subjectKey, rows!.length)}</Note>
          <div className="mb-3" />
        </>
      )}
      {rows && rows.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No comparable data.</div>}
      {/* <md: card layout — the metric matrix clips badly at 375px. */}
      {rows && rows.length > 0 && (
        <div className="md:hidden flex flex-col gap-2">
          {rows.map((r, i) => {
            const numeric = cols.filter((c) => typeof r[c] === "number").slice(0, 4);
            const t = r.Ticker ? String(r.Ticker) : null;
            const href = t ? `/terminal?t=${encodeURIComponent(t.includes(".") ? t : `${t}.NS`)}` : null;
            return (
              <div key={i} className="panel-2 p-3">
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-amber font-bold">{t ?? "—"}</span>
                  {href && <Link href={href} className="text-amber text-xs hover:underline">Open →</Link>}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {numeric.map((c) => (
                    <div key={c} className="flex justify-between text-xs">
                      <span className="label-xs">{c}</span>
                      <span className="num">{fmtNum(r[c] as number, 2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="hidden md:block">
        <ScrollX className="panel">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                {cols.map((c) => (
                  <th key={c} onClick={() => toggleSort(c)}
                      className="text-left px-3 py-2 font-medium whitespace-nowrap
                                 cursor-pointer hover:text-amber select-none">
                    {c}
                    {sort?.key === c && (sort.dir === "asc" ? " ▲" : " ▼")}
                  </th>
                ))}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {shown!.map((r, i) => (
                <tr key={i}
                    className={`border-b border-line/60 hover:bg-panel ${
                      String(r.Ticker ?? "").toUpperCase() === subjectKey
                        ? "bg-amber/10" : ""}`}>
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
        </div>
      )}
      <Note>
        <span className="block mt-2">
          EV/EBITDA* uses market cap as an enterprise-value proxy — the free
          feed carries no debt layer for the peer set, so a heavily indebted
          peer looks cheaper on that column than it is. Multiples above five
          times the peer median are nulled rather than shown, because at that
          distance they are almost always a provider error rather than a
          valuation.
        </span>
      </Note>
      <Methodology id="comparables" className="mt-3" />
    </div>
  );
}
