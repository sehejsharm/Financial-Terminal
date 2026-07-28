"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Trash2, Upload, X } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { LiveNumber } from "@/components/LiveNumber";
import { ScrollX } from "@/components/ScrollX";
import { TickerInput } from "@/components/TickerInput";
import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { StressTest } from "@/components/StressTest";
import {
  api,
  type PortfolioHistoryPoint,
  type PortfolioInfo,
  type PortfolioRow,
  type PortfolioSummary,
} from "@/lib/api";
import { useLive } from "@/lib/useLive";
import { useLiveTicks, useQuote } from "@/lib/useQuote";
import { curSymbol, fmtNum, fmtPct, formatPercent, humanNumber } from "@/lib/utils";

/** One holdings row, live: subscribes to its symbol and recomputes price /
 *  value / P&L / day P&L from each tick (falling back to the REST summary
 *  when the socket has nothing yet). Only THIS row re-renders on its tick. */
function LivePositionRow({ p, onClose }: { p: PortfolioRow; onClose: (id: string) => void }) {
  const tick = useQuote(p.ticker);
  const c = curSymbol(p.currency);
  const live = tick && !tick.seeded ? tick.ltp : null; // a real streamed price
  const ltp = live ?? p.price ?? null;
  const value = ltp != null ? ltp * p.qty : p.value ?? null;
  const pnl = ltp != null ? (ltp - p.cost) * p.qty : p.pnl ?? null;
  const pnlPct = ltp != null && p.cost ? ((ltp - p.cost) / p.cost) * 100 : p.pnl_pct ?? null;
  const day = tick?.chg != null && live != null ? tick.chg * p.qty : p.day_pnl ?? null;
  const sign = (n: number | null) => (n != null && n < 0 ? "text-red" : "text-green");
  return (
    <tr className="border-b border-line/60 hover:bg-panel">
      <td className="px-3 py-2">
        <Link href={`/terminal?t=${encodeURIComponent(p.ticker)}`} className="text-amber hover:underline">{p.ticker}</Link>
        <div className="text-mut text-[10px]">{p.sector ?? ""}</div>
      </td>
      <td className="px-3 py-2 num text-right">{fmtNum(p.qty, 0)}</td>
      <td className="px-3 py-2 num text-right">{fmtNum(p.cost, 2)}</td>
      <td className="px-3 py-2 num text-right">
        {ltp != null ? <LiveNumber value={ltp} format="price" ccy={c} /> : "—"}
      </td>
      <td className="px-3 py-2 num text-right">
        {value != null ? <LiveNumber value={value} format="human" ccy={c} /> : "—"}
      </td>
      <td className={`px-3 py-2 num text-right ${sign(pnl)}`}>
        {pnl != null ? <LiveNumber value={pnl} format="human" ccy={c} /> : "—"}
      </td>
      <td className={`px-3 py-2 num text-right ${sign(pnlPct)}`}>
        {pnlPct != null ? fmtPct(pnlPct) : "—"}
      </td>
      <td className={`px-3 py-2 num text-right ${sign(day)}`}>
        {day != null ? <LiveNumber value={day} format="human" ccy={c} /> : "—"}
      </td>
      <td className="px-3 py-2 num text-right">{p.weight != null ? `${fmtNum(p.weight, 1)}%` : "—"}</td>
      <td className="px-3 py-2 text-right">
        <button onClick={() => onClose(p.id)} className="text-mut hover:text-red" title="Close position (with optional sell price)">
          <Trash2 size={13} />
        </button>
      </td>
    </tr>
  );
}

/** Portfolio totals, live: recomputes value / P&L / day P&L from the live
 *  ticks of every holding (one re-render per frame, not per row). Falls back
 *  to each holding's REST price until its socket price arrives. */
function LiveTotals({
  positions, cur, fallback, realizedTotal, factors,
}: {
  positions: PortfolioRow[];
  cur: string;
  fallback: NonNullable<PortfolioSummary["totals"]>;
  realizedTotal: number | null;
  factors: PortfolioSummary["factors"];
}) {
  const ticks = useLiveTicks(positions.map((p) => p.ticker));
  let value = 0, cost = 0, day = 0, priced = 0;
  for (const p of positions) {
    const t = ticks.get(p.ticker.toUpperCase());
    const ltp = (t && !t.seeded ? t.ltp : null) ?? p.price ?? null;
    if (ltp == null) continue;
    value += ltp * p.qty;
    cost += p.cost * p.qty;
    day += t?.chg != null && !t.seeded ? t.chg * p.qty : (p.day_pnl ?? 0);
    priced++;
  }
  // No priced legs yet → show the REST snapshot totals verbatim.
  const V = priced ? value : fallback.value;
  const pnl = priced ? value - cost : fallback.pnl;
  const pnlPct = priced ? (cost ? (pnl / cost) * 100 : null) : fallback.pnl_pct;
  const dayPnl = priced ? day : fallback.day_pnl;
  return (
    <div className={`grid grid-cols-2 ${realizedTotal != null ? "md:grid-cols-5" : "md:grid-cols-4"} gap-3 mb-6`}>
      <MetricCard label="Market value" value={<LiveNumber value={V} format="human" ccy={cur} />} />
      <MetricCard label="Total P&L" value={<LiveNumber value={pnl} format="human" ccy={cur} />}
                  delta={pnlPct != null ? fmtPct(pnlPct) : null}
                  tone={pnl >= 0 ? "positive" : "negative"} />
      <MetricCard label="Day P&L" value={<LiveNumber value={dayPnl} format="human" ccy={cur} />}
                  tone={dayPnl >= 0 ? "positive" : "negative"} />
      {realizedTotal != null && (
        <MetricCard label="Realized P&L" value={humanNumber(realizedTotal, cur)}
                    tone={realizedTotal >= 0 ? "positive" : "negative"} />
      )}
      <MetricCard label="Wtd beta / div yield"
                  value={`${factors?.beta != null ? fmtNum(factors.beta, 2) : "—"} / ${factors?.dividend_yield != null ? formatPercent(factors.dividend_yield) : "—"}`} />
    </div>
  );
}

const PID_KEY = "mb_portfolio_pid";

type ImportRow = { ticker: string; qty: number; cost: number };

/** Client-side CSV parse: header row optional; columns ticker,qty,cost in
 *  order, or mapped by header names (ticker / qty|quantity / cost|price|avg_cost). */
function parseCsv(text: string): { rows: ImportRow[]; skipped: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cells = lines.map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  const rows: ImportRow[] = [];
  const skipped: string[] = [];
  let tIdx = 0, qIdx = 1, cIdx = 2, start = 0;
  if (cells.length > 0) {
    const head = cells[0].map((c) => c.toLowerCase());
    if (head.includes("ticker")) {
      start = 1;
      tIdx = head.indexOf("ticker");
      qIdx = head.findIndex((h) => h === "qty" || h === "quantity");
      cIdx = head.findIndex((h) => h === "cost" || h === "price" || h === "avg_cost");
      if (qIdx < 0 || cIdx < 0) {
        return { rows: [], skipped: ["header must include ticker, qty/quantity, and cost/price/avg_cost columns"] };
      }
    }
  }
  for (let i = start; i < cells.length; i++) {
    const row = cells[i];
    const ticker = (row[tIdx] ?? "").toUpperCase();
    const qty = parseFloat(row[qIdx] ?? "");
    const cost = parseFloat(row[cIdx] ?? "");
    if (!ticker) { skipped.push(`row ${i + 1}: missing ticker`); continue; }
    if (!(qty > 0)) { skipped.push(`row ${i + 1} (${ticker}): invalid qty`); continue; }
    if (!(cost >= 0)) { skipped.push(`row ${i + 1} (${ticker}): invalid cost`); continue; }
    rows.push({ ticker, qty, cost });
  }
  return { rows, skipped };
}

/** Lightweight inline SVG line chart: portfolio value (amber) vs cost basis
 *  (muted, dashed). No charting library — two paths in a viewBox. */
function HistoryChart({ points, ccy = "" }: { points: PortfolioHistoryPoint[]; ccy?: string }) {
  const W = 400, H = 120, PAD = 4;
  const vals = points.flatMap((p) => [p.value, p.cost]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const path = (pick: (p: PortfolioHistoryPoint) => number) =>
    points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-[120px]">
        <path d={path((p) => p.cost)} fill="none" stroke="currentColor" strokeWidth={1}
              strokeDasharray="4 3" vectorEffect="non-scaling-stroke" className="text-mut" />
        <path d={path((p) => p.value)} fill="none" stroke="currentColor" strokeWidth={1.5}
              vectorEffect="non-scaling-stroke" className="text-amber" />
      </svg>
      <div className="flex justify-between text-[10px] text-mut mt-1">
        <span className="num">{points[0].date}</span>
        <span className="num text-amber">{humanNumber(last.value, ccy)}</span>
        <span className="num">{last.date}</span>
      </div>
    </div>
  );
}

/** Lightweight PORT: real positions, live P&L, sector/concentration
 *  breakdown, weighted factor exposure. */
export default function PortfolioPage() {
  const [ticker, setTicker] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pfErr, setPfErr] = useState<string | null>(null);

  // ── multi-portfolio selection (persisted) ────────────────────────────────
  const [pid, setPid] = useState<string | null>(() =>
    typeof localStorage !== "undefined" ? localStorage.getItem(PID_KEY) : null);
  const [portfolios, setPortfolios] = useState<PortfolioInfo[]>([]);

  async function reloadPortfolios() {
    try { setPortfolios(await api.portfolioList()); } catch { /* noop */ }
  }
  useEffect(() => { reloadPortfolios(); }, []);
  useEffect(() => {
    if (pid && typeof localStorage !== "undefined") localStorage.setItem(PID_KEY, pid);
  }, [pid]);
  // If the stored pid no longer exists, fall back to the first portfolio.
  useEffect(() => {
    if (portfolios.length === 0) return;
    if (!pid || !portfolios.some((p) => p.id === pid)) setPid(portfolios[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolios]);

  const { data, busy, updatedAt, refresh } = useLive<PortfolioSummary>(
    () => api.portfolioSummary(pid ?? undefined), 30_000, [pid],
  );

  // ── P&L history (one point per day the portfolio is viewed) ──────────────
  const [history, setHistory] = useState<PortfolioHistoryPoint[] | null>(null);
  const [histTick, setHistTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api.portfolioHistory(pid ?? undefined)
      .then((r) => { if (alive) setHistory(r.points); })
      .catch(() => { if (alive) setHistory(null); });
    return () => { alive = false; };
  }, [pid, histTick]);

  function reloadAll() {
    refresh();
    reloadPortfolios();
    setHistTick((t) => t + 1);
  }

  async function createPortfolio() {
    const name = window.prompt("New portfolio name");
    if (!name?.trim()) return;
    setPfErr(null);
    try {
      const p = await api.portfolioCreate(name.trim());
      setPid(p.id);
      reloadPortfolios();
    } catch (e: any) { setPfErr(e?.detail || "Could not create portfolio."); }
  }

  async function deletePortfolio(p: PortfolioInfo) {
    if (!window.confirm(`Delete portfolio "${p.name}" and all its positions?`)) return;
    setPfErr(null);
    try {
      await api.portfolioDelete(p.id);
      if (pid === p.id) setPid(null);
      reloadPortfolios();
    } catch (e: any) { setPfErr(e?.detail || "Could not delete portfolio."); }
  }

  // ── CSV import ───────────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<{ rows: ImportRow[]; skipped: string[]; name: string } | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  async function onCsvFile(file: File) {
    setImportMsg(null);
    const parsed = parseCsv(await file.text());
    setCsv({ ...parsed, name: file.name });
  }

  async function confirmImport() {
    if (!csv || csv.rows.length === 0) return;
    setPfErr(null);
    try {
      const r = await api.portfolioImport(csv.rows, pid ?? undefined);
      const bits = [`${r.added} added`];
      const skipped = [...csv.skipped, ...r.skipped];
      if (skipped.length) bits.push(`skipped: ${skipped.join("; ")}`);
      setImportMsg(bits.join(" — "));
      setCsv(null);
      reloadAll();
    } catch (e: any) { setPfErr(e?.detail || "Import failed."); }
  }

  async function add() {
    setErr(null);
    const q = parseFloat(qty), c = parseFloat(cost);
    if (!ticker.trim() || !(q > 0) || !(c >= 0)) {
      setErr("Ticker, positive quantity, and cost basis are required.");
      return;
    }
    try {
      await api.addPosition(ticker.trim().toUpperCase(), q, c, pid ?? undefined);
      setTicker(""); setQty(""); setCost("");
      reloadAll();
    } catch (e: any) { setErr(e?.detail || "Could not add position."); }
  }

  async function close(id: string) {
    const raw = window.prompt("Sell price (blank = just remove, no P&L recorded)");
    if (raw === null) return;
    setErr(null);
    const s = raw.trim();
    const sellPrice = s === "" ? undefined : parseFloat(s);
    if (sellPrice !== undefined && !(sellPrice >= 0)) {
      setErr("Sell price must be a non-negative number.");
      return;
    }
    try {
      await api.closePosition(id, { pid: pid ?? undefined, sellPrice });
      reloadAll();
    } catch (e: any) { setErr(e?.detail || "Could not close position."); }
  }

  const t = data?.totals;
  const f = data?.factors;
  // A portfolio can hold mixed-currency positions (e.g. AAPL in $ + RELIANCE
  // in ₹). Only stamp a currency symbol on the AGGREGATE totals when every
  // position shares one currency; otherwise the summed total isn't a single-
  // currency figure, so we render it unsymboled and flag it honestly (per-row
  // values still use each holding's own currency).
  const posCcys = Array.from(
    new Set((data?.positions ?? []).map((p) => p.currency).filter(Boolean) as string[]));
  const mixedCcy = posCcys.length > 1;
  const cur = posCcys.length === 1 ? curSymbol(posCcys[0]) : "";

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-3">
        <h1 className="heading">PORTFOLIO</h1>
        <div className="flex-1" />
        <DataAge at={updatedAt} onRefresh={refresh} busy={busy} />
      </div>

      {/* Portfolio tabs + CSV import */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {portfolios.map((p) => (
          <div key={p.id}
               onClick={() => setPid(p.id)}
               className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs cursor-pointer ${
                 p.id === pid ? "border-amber/60 text-amber bg-panel" : "border-line text-mut hover:text-white"
               }`}>
            <span>{p.name}</span>
            <span className="num text-[10px] opacity-60">{p.positions}</span>
            <button onClick={(e) => { e.stopPropagation(); deletePortfolio(p); }}
                    className="text-mut hover:text-red" title="Delete portfolio">
              <X size={11} />
            </button>
          </div>
        ))}
        <button onClick={createPortfolio} className="btn-ghost text-xs">+ New</button>
        <div className="flex-1" />
        <button onClick={() => fileRef.current?.click()} className="btn-ghost text-xs flex items-center gap-1.5">
          <Upload size={12} /> Import CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv" className="hidden"
               onChange={(e) => {
                 const file = e.target.files?.[0];
                 if (file) onCsvFile(file);
                 e.target.value = "";
               }} />
        {pfErr && <div className="text-red text-xs w-full">{pfErr}</div>}
        {importMsg && <div className="text-mut text-xs w-full">{importMsg}</div>}
      </div>

      {/* CSV import preview */}
      {csv && (
        <div className="panel-2 p-3 mb-5 text-xs">
          <div className="mb-2">
            <span className="text-amber">{csv.name}</span>{" "}
            <span className="text-mut">— {csv.rows.length} position{csv.rows.length === 1 ? "" : "s"} parsed
              {csv.skipped.length > 0 ? `, ${csv.skipped.length} skipped` : ""}</span>
          </div>
          {csv.rows.slice(0, 5).map((r, i) => (
            <div key={i} className="num text-mut">
              {r.ticker} — qty {fmtNum(r.qty, 0)} @ {fmtNum(r.cost, 2)}
            </div>
          ))}
          {csv.rows.length > 5 && <div className="text-mut">… and {csv.rows.length - 5} more</div>}
          {csv.skipped.length > 0 && (
            <div className="text-red mt-1">{csv.skipped.join("; ")}</div>
          )}
          <div className="flex gap-2 mt-2">
            <button onClick={confirmImport} className="btn-primary" disabled={csv.rows.length === 0}>
              Confirm import
            </button>
            <button onClick={() => setCsv(null)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

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

      {t && data && (
        <>
          <LiveTotals positions={data.positions} cur={cur} fallback={t}
                      realizedTotal={data.realized ? data.realized.total : null} factors={f ?? null} />
          {mixedCcy && (
            <div className="text-[10.5px] text-amber/90 -mt-4 mb-6">
              This book holds multiple currencies ({posCcys.join(", ")}) — the totals
              above are un-converted sums shown without a symbol. Each holding&apos;s own
              currency is used in the rows below.
            </div>
          )}
        </>
      )}

      {/* P&L history */}
      {history && (
        <div className="mb-6">
          <div className="heading mb-2">P&L history</div>
          <div className="panel-2 p-4">
            {history.length < 2 ? (
              <div className="text-mut text-sm">
                History accrues one point per day you view the portfolio — check back tomorrow.
              </div>
            ) : (
              <HistoryChart points={history} ccy={cur} />
            )}
          </div>
        </div>
      )}

      {data && data.positions.length === 0 && (
        <div className="panel-2 p-4 text-mut text-sm">
          No positions yet — add your first above, or use Import CSV to bring in
          a whole book at once (columns: ticker, qty, cost). P&L, sector
          breakdown, and factor exposure appear live once positions exist.
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
                {data.positions.map((p) => <LivePositionRow key={p.id} p={p} onClose={close} />)}
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

      {/* Stress test — collapsed by default, it costs a history fetch per holding */}
      {(data?.positions?.length ?? 0) > 0 && (
        <div className="mt-6">
          <StressTest positions={data!.positions} cur={cur} mixedCcy={mixedCcy} />
        </div>
      )}

      {/* Realized events */}
      {data?.realized && data.realized.events.length > 0 && (
        <div className="mt-6">
          <div className="heading mb-2">Realized events</div>
          <div className="panel-2 p-3 flex flex-col gap-1.5 text-xs">
            {[...data.realized.events].reverse().slice(0, 10).map((ev, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="num text-mut w-20">{ev.ts.slice(0, 10)}</span>
                <Link href={`/terminal?t=${encodeURIComponent(ev.ticker)}`} className="text-amber hover:underline">{ev.ticker}</Link>
                <span className="num text-mut">{fmtNum(ev.qty, 0)} @ {fmtNum(ev.sell_price, 2)}</span>
                <span className="flex-1" />
                <span className={`num ${ev.pnl < 0 ? "text-red" : "text-green"}`}>
                  {humanNumber(ev.pnl, cur)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}
