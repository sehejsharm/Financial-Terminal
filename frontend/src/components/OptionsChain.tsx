"use client";

import { useEffect, useState } from "react";

import { api, type OptionChain, type OptionRow } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

const COLS: { key: string; label: string; digits?: number }[] = [
  { key: "strike", label: "Strike", digits: 1 },
  { key: "lastPrice", label: "Last", digits: 2 },
  { key: "bid", label: "Bid", digits: 2 },
  { key: "ask", label: "Ask", digits: 2 },
  { key: "volume", label: "Vol", digits: 0 },
  { key: "openInterest", label: "OI", digits: 0 },
  { key: "impliedVolatility", label: "IV", digits: 2 },
  { key: "delta", label: "Δ", digits: 3 },
  { key: "gamma", label: "Γ", digits: 4 },
  { key: "theta", label: "Θ", digits: 3 },
  { key: "vega", label: "ν", digits: 3 },
];

function OptTable({ rows, spot }: { rows: OptionRow[]; spot: number }) {
  if (!rows.length) return <div className="panel-2 p-3 text-mut text-xs">No contracts.</div>;
  return (
    <div className="panel overflow-auto max-h-[460px]">
      <table className="w-full text-[11px]">
        <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
          <tr className="border-b border-line">
            {COLS.map((c) => (
              <th key={c.key} className="text-right px-2 py-1.5 font-medium">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const itm = typeof r.strike === "number" && r.strike < spot; // calls ITM below spot
            return (
              <tr key={i} className={`border-b border-line/50 hover:bg-panel ${itm ? "bg-amber/5" : ""}`}>
                {COLS.map((c) => {
                  const v = r[c.key];
                  return (
                    <td key={c.key} className="px-2 py-1 num text-right text-txt/90">
                      {typeof v === "number" ? fmtNum(v, c.digits ?? 2) : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OptionsChain({ ticker }: { ticker: string }) {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>("");
  const [data, setData] = useState<OptionChain | null>(null);
  const [side, setSide] = useState<"calls" | "puts">("calls");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [expiriesLoaded, setExpiriesLoaded] = useState(false);

  useEffect(() => {
    setErr(null); setData(null); setExpiries([]); setExpiry(""); setExpiriesLoaded(false);
    api.optionExpiries(ticker)
      .then((ex) => { setExpiries(ex); if (ex.length) setExpiry(ex[0]); })
      .catch((e) => setErr(e?.detail || "No options for this symbol."))
      .finally(() => setExpiriesLoaded(true));
  }, [ticker]);

  useEffect(() => {
    if (!expiry) return;
    setBusy(true); setErr(null);
    api.optionChain(ticker, expiry)
      .then(setData)
      .catch((e) => setErr(e?.detail || "Failed to load chain."))
      .finally(() => setBusy(false));
  }, [ticker, expiry]);

  if (err && !expiries.length) return <div className="panel-2 p-4 text-mut text-sm">{err}</div>;

  const isIndian = /\.(NS|BO)$/i.test(ticker);
  if (expiriesLoaded && !err && expiries.length === 0) {
    return (
      <div className="panel-2 p-4 text-mut text-sm">
        No option expiries available for <span className="text-amber">{ticker}</span>.
        {isIndian
          ? " NSE F&O chains aren't wired into the free data layer yet — options work for US-listed tickers (e.g. AAPL, SPY)."
          : " The data provider returned no listed expiries for this symbol — it may not have exchange-traded options."}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="input-bare cursor-pointer">
          {expiries.map((e) => <option key={e}>{e}</option>)}
        </select>
        <div className="flex gap-2">
          <button onClick={() => setSide("calls")} className={`btn ${side === "calls" ? "btn-primary" : "btn-ghost"}`}>Calls</button>
          <button onClick={() => setSide("puts")} className={`btn ${side === "puts" ? "btn-primary" : "btn-ghost"}`}>Puts</button>
        </div>
        <div className="flex-1" />
        {data && (
          <div className="flex gap-3 text-[11px] text-mut">
            <span>Spot <span className="num text-txt">{fmtNum(data.spot, 2)}</span></span>
            {data.max_pain != null && <span>Max pain <span className="num text-amber">{fmtNum(data.max_pain, 1)}</span></span>}
          </div>
        )}
      </div>

      {busy && <div className="text-mut text-xs">Loading chain & Greeks…</div>}
      {err && expiries.length > 0 && <div className="text-red text-sm mb-2">{err}</div>}
      {data && !busy && (
        <OptTable rows={side === "calls" ? data.calls : data.puts} spot={data.spot} />
      )}
    </div>
  );
}
