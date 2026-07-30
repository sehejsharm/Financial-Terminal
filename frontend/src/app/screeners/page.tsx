"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { Shell } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { Pager, SortableTh, TableToolbar, useTableControls } from "@/components/tableControls";
import { ScrollX } from "@/components/ScrollX";
import { ScreenBuilder } from "@/components/screeners/ScreenBuilder";
import { Note, PageHeader } from "@/components/ui";
import { api, type ScreenClause, type ScreenResult } from "@/lib/api";
import {
  columnCoverage, columnNote, coverage, coverageNote, isPercent, labelFor,
  sparseColumns,
} from "@/lib/screenResult";

type ScreenDef = {
  label: string;
  desc: string;
  run: () => Promise<ScreenResult>;
};

const SCREENS: ScreenDef[] = [
  // Cloud-data-friendly first — these return rows on the live deployment with
  // no extra API key (filter on market cap + P/E, which NSE always provides).
  { label: "Large Cap", desc: "Market cap > ₹20,000 cr. Works on live data.", run: () => api.preset("Large Cap") },
  { label: "Large Cap Value", desc: "Market cap > ₹50,000 cr, P/E < 25. Works on live data.", run: () => api.preset("Large Cap Value") },
  { label: "PEG Screen", desc: "EPS growth > 20, Sales growth > 15, PEG < 1, low debt.", run: () => api.preset("PEG Screen") },
  { label: "Hidden Gems", desc: "Small-cap (₹500–5000 cr) high-growth names.", run: () => api.preset("Hidden Gems") },
  { label: "Growth", desc: "Large-cap (> ₹5000 cr) consistent growers.", run: () => api.preset("Growth") },
  { label: "Buffett Quality", desc: "Wide-moat quality scored 0–100 (≥ 70).", run: () => api.screenBuffett(70) },
  { label: "Graham Value", desc: "Graham intrinsic value with margin of safety.", run: () => api.screenGraham() },
  { label: "Top ETFs", desc: "ETF universe ranked by trailing return.", run: () => api.screenEtfs() },
];

function fmtCell(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    const out = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return isPercent(key) ? `${out}%` : out;
  }
  return String(v);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(name: string, cols: string[], rows: any[]) {
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `${name.replace(/\s+/g, "_")}_${date}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function tickerOf(r: any): string {
  const t = String(r.ticker ?? r.symbol ?? "").toUpperCase();
  if (!t) return "";
  // NSE names from the Indian universe need the .NS suffix to resolve.
  return t.includes(".") || t.startsWith("^") ? t : `${t}.NS`;
}

export default function ScreenersPage() {
  // active = 0..N-1 preset index, or -1 for the custom builder.
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** Run the builder's screen. Kept separate from run(i) so the builder owns
   *  its own filter state and this page just relays the result. */
  async function runCustom(
    filters: ScreenClause[], match: "all" | "any", sectors: string[],
  ) {
    setActive(-1);
    setBusy(true); setErr(null); setResult(null);
    try {
      setResult(await api.customScreen(
        filters.filter((f) => f.value != null), match, sectors));
    } catch (e: any) {
      setErr(e?.detail || "Screen failed. The data backend may be waking up — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function run(i = active) {
    setActive(i);
    setBusy(true); setErr(null); setResult(null);
    try {
      setResult(await SCREENS[i].run());
    } catch (e: any) {
      setErr(e?.detail || "Screen failed. The data backend may be waking up — try again in a few seconds.");
    } finally {
      setBusy(false);
    }
  }

  // Auto-run the default preset on load — the server keeps the universe scan
  // warm in the background, so this returns in ms instead of a 13s cold scan.
  useEffect(() => {
    run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = result?.rows ?? null;
  const cols = rows && rows.length
    ? Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((c) => c !== "symbol")
    : [];
  const ctl = useTableControls(rows, 25);
  // Coverage is computed for EVERY result, not just empty ones — a screen that
  // returned rows is exactly where a coverage problem hides.
  const cov = result ? coverage(result) : null;
  const sparse = rows && rows.length ? sparseColumns(columnCoverage(rows, cols)) : [];

  return (
    <Shell>
      <PageHeader
        title="SCREENERS"
        subtitle="Fundamental screens over an Indian universe. Presets run a
                  fresh scan on click; Custom builds a filter set from any of
                  the metrics the feed actually populates." />

      <div className="flex flex-wrap gap-2 mb-3">
        {SCREENS.map((s, i) => (
          <button
            key={s.label}
            // Run immediately on preset click. Previously this only set the
            // active tab and kept the PREVIOUS preset's rows on screen, which
            // made every preset look like it returned the identical dataset.
            onClick={() => run(i)}
            disabled={busy}
            className={`btn ${active === i ? "btn-primary" : "btn-ghost"}`}
          >
            {s.label}
          </button>
        ))}
        {/* Never disabled: opening the builder is view-only (no fetch), so
            it must stay reachable even while a preset scan is in flight. */}
        <button onClick={() => { setActive(-1); setResult(null); setErr(null); }}
                className={`btn ${active === -1 ? "btn-primary" : "btn-ghost"}`}>
          Custom
        </button>
      </div>

      {active === -1 && (
        <ScreenBuilder busy={busy} onRun={runCustom} />
      )}

      {err && <div className="text-red text-sm mb-3">{err}</div>}

      {result && rows && rows.length === 0 && cov && (
        <div className="panel-2 p-4 text-mut">
          <div className="mb-2">{result.note || "No matches for this screen."}</div>
          <Note>{coverageNote(cov)}</Note>
        </div>
      )}

      {/* Coverage on EVERY result. A dash cannot distinguish "this company
          doesn't have it" from "the feed doesn't carry it", and the reader
          needs that distinction before ranking anything. */}
      {rows && rows.length > 0 && cov && (
        <div className="mb-3 flex flex-col gap-1.5">
          <Note>{coverageNote(cov)}</Note>
          {columnNote(sparse) && (
            <div className="text-[10.5px] text-amber/90 leading-relaxed max-w-4xl">
              {columnNote(sparse)}
            </div>
          )}
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          <TableToolbar ctl={ctl} placeholder="Filter by name / ticker…" />
          {/* <md: stacked cards — the wide table is unusable at 375px. */}
          <div className="md:hidden flex flex-col gap-2">
            {ctl.pageRows.map((r, i) => {
              const numeric = cols.filter((c) => typeof r[c] === "number").slice(0, 4);
              return (
                <div key={i} className="panel-2 p-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    {tickerOf(r) ? (
                      <Link href={`/terminal?t=${encodeURIComponent(tickerOf(r))}`}
                            className="text-amber font-bold hover:underline">
                        {String(r.ticker ?? r.symbol ?? "")}
                      </Link>
                    ) : (
                      <span className="text-amber font-bold">{String(r.ticker ?? r.symbol ?? "—")}</span>
                    )}
                    <span className="text-xs text-mut truncate">{String(r.name ?? "")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {numeric.map((c) => (
                      <div key={c} className="flex justify-between text-xs">
                        <span className="label-xs">{labelFor(c)}</span>
                        <span className="num">{fmtCell(c, r[c])}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* ScrollX, not a bare overflow container: a screener result is
              twenty-odd columns wide and the ones past the edge were simply
              invisible — no scrollbar rendered until you happened to drag.
              ScrollX fades the edge and says "scroll →" while there is more. */}
          <ScrollX className="panel hidden md:block">
            <table className="w-full text-xs">
              <thead className="text-mut uppercase tracking-wider">
                <tr className="border-b border-line">
                  {cols.map((c) => (
                    <SortableTh key={c} label={labelFor(c)} k={c} ctl={ctl}
                                align={typeof rows[0]?.[c] === "number" ? "right" : "left"} />
                  ))}
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={i} className="border-b border-line/60 hover:bg-panel">
                    {cols.map((c) => (
                      <td key={c} className={`px-3 py-2 num whitespace-nowrap ${typeof r[c] === "number" ? "text-right" : ""}`}>{fmtCell(c, r[c])}</td>
                    ))}
                    <td className="px-3 py-2">
                      {tickerOf(r) && (
                        <Link href={`/terminal?t=${encodeURIComponent(tickerOf(r))}`} className="text-amber hover:underline">
                          Open →
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
          <Pager ctl={ctl} />
        </>
      )}
    </Shell>
  );
}
