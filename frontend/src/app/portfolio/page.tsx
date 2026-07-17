"use client";

import Link from "next/link";
import { useState } from "react";
import { Trash2 } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { ScrollX } from "@/components/ScrollX";
import { TickerInput } from "@/components/TickerInput";
import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { api, type PortfolioSummary } from "@/lib/api";
import { useLive } from "@/lib/useLive";
import { curSymbol, fmtNum, fmtPct, formatPercent, humanNumber } from "@/lib/utils";

/** Lightweight PORT: real positions, live P&L, sector/concentration
 *  breakdown, weighted factor exposure. */
export default function PortfolioPage() {
  const [ticker, setTicker] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data, busy, updatedAt, refresh } = useLive<PortfolioSummary>(
    () => api.portfolioSummary(), 30_000,
  );

  async function add() {
    setErr(null);
    const q = parseFloat(qty), c = parseFloat(cost);
    if (!ticker.trim() || !(q > 0) || !(c >= 0)) {
      setErr("Ticker, positive quantity, and cost basis are required.");
      return;
    }
    try {
      await api.addPosition(ticker.trim().toUpperCase(), q, c);
      setTicker(""); setQty(""); setCost("");
      refresh();
    } catch (e: any) { setErr(e?.detail || "Could not add position."); }
  }

  async function del(id: string) {
    try { await api.deletePosition(id); refresh(); } catch { /* noop */ }
  }

  const t = data?.totals;
  const f = data?.factors;

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-3">
        <h1 className="heading">PORTFOLIO</h1>
        <div className="flex-1" />
        <DataAge at={updatedAt} onRefresh={refresh} busy={busy} />
      </div>

      {/* Add position */}
      <div className="panel-2 p-3 mb-5 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-[160px]">
          <span className="label-xs">Ticker</span>
          <TickerInput value={ticker} onCommit={setTicker} placeholder="RELIANCE.NS / AAPL" />
        </label>
        <label className="flex flex-col gap-1 w-28">
          <span className="label-xs">Quantity</span>
          <input value={qty} onChange={(e) => setQty(e.target.value)} type="number" className="input-bare" />
        </label>
        <label className="flex flex-col gap-1 w-32">
          <span className="label-xs">Cost / share</span>
          <input value={cost} onChange={(e) => setCost(e.target.value)} type="number" className="input-bare" />
        </label>
        <button onClick={add} className="btn-primary">Add position</button>
        {err && <div className="text-red text-xs w-full">{err}</div>}
      </div>

      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <MetricCard label="Market value" value={humanNumber(t.value)} />
          <MetricCard label="Total P&L" value={humanNumber(t.pnl)}
                      delta={t.pnl_pct != null ? fmtPct(t.pnl_pct) : null}
                      tone={t.pnl >= 0 ? "positive" : "negative"} />
          <MetricCard label="Day P&L" value={humanNumber(t.day_pnl)}
                      tone={t.day_pnl >= 0 ? "positive" : "negative"} />
          <MetricCard label="Wtd beta / div yield"
                      value={`${f?.beta != null ? fmtNum(f.beta, 2) : "—"} / ${f?.dividend_yield != null ? formatPercent(f.dividend_yield) : "—"}`} />
        </div>
      )}

      {data && data.positions.length === 0 && (
        <div className="panel-2 p-4 text-mut text-sm">
          No positions yet — add your first above. P&L, sector breakdown, and
          factor exposure appear live once positions exist.
        </div>
      )}

      {data && data.positions.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
          <ScrollX className="panel">
            <table className="w-full text-xs">
              <thead className="text-mut uppercase tracking-wider">
                <tr className="border-b border-line">
                  {["Ticker", "Qty", "Cost", "Price", "Value", "P&L", "P&L %", "Day P&L", "Weight", ""].map((h) => (
                    <th key={h} className={`px-3 py-2 font-medium whitespace-nowrap ${h === "Ticker" ? "text-left" : "text-right"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.positions.map((p) => {
                  const c = curSymbol(p.currency);
                  return (
                    <tr key={p.id} className="border-b border-line/60 hover:bg-panel">
                      <td className="px-3 py-2">
                        <Link href={`/terminal?t=${encodeURIComponent(p.ticker)}`} className="text-amber hover:underline">{p.ticker}</Link>
                        <div className="text-mut text-[10px]">{p.sector ?? ""}</div>
                      </td>
                      <td className="px-3 py-2 num text-right">{fmtNum(p.qty, 0)}</td>
                      <td className="px-3 py-2 num text-right">{fmtNum(p.cost, 2)}</td>
                      <td className="px-3 py-2 num text-right">{p.price != null ? `${c}${fmtNum(p.price, 2)}` : "—"}</td>
                      <td className="px-3 py-2 num text-right">{p.value != null ? humanNumber(p.value, c) : "—"}</td>
                      <td className={`px-3 py-2 num text-right ${p.pnl != null && p.pnl < 0 ? "text-red" : "text-green"}`}>
                        {p.pnl != null ? humanNumber(p.pnl, c) : "—"}
                      </td>
                      <td className={`px-3 py-2 num text-right ${p.pnl_pct != null && p.pnl_pct < 0 ? "text-red" : "text-green"}`}>
                        {p.pnl_pct != null ? fmtPct(p.pnl_pct) : "—"}
                      </td>
                      <td className={`px-3 py-2 num text-right ${p.day_pnl != null && p.day_pnl < 0 ? "text-red" : "text-green"}`}>
                        {p.day_pnl != null ? humanNumber(p.day_pnl, c) : "—"}
                      </td>
                      <td className="px-3 py-2 num text-right">{p.weight != null ? `${fmtNum(p.weight, 1)}%` : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => del(p.id)} className="text-mut hover:text-red" title="Remove position">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollX>

          <div>
            <div className="heading mb-2">Sector allocation</div>
            <div className="panel-2 p-4 flex flex-col gap-2">
              {(data.sectors ?? []).map((s) => (
                <div key={s.sector}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span>{s.sector}</span>
                    <span className="num text-mut">{fmtNum(s.weight, 1)}%</span>
                  </div>
                  <div className="h-1.5 bg-panel rounded overflow-hidden">
                    <div className="h-full bg-amber/70" style={{ width: `${Math.min(100, s.weight)}%` }} />
                  </div>
                </div>
              ))}
              {f?.top_weight != null && f.top_weight > 30 && (
                <div className="text-[10.5px] text-amber mt-2">
                  Concentration: largest position is {fmtNum(f.top_weight, 1)}% of the book.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
