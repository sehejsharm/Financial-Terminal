"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { Shell } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { Pager, SortableTh, TableToolbar, useTableControls } from "@/components/tableControls";
import { api, type ScreenResult } from "@/lib/api";

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

const PCT_KEYS = new Set(["roe", "roce", "eps_growth", "sales_growth", "promoter", "ytd_return", "return_1y", "margin_of_safety", "mos"]);

function fmtCell(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    const out = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return PCT_KEYS.has(key) ? `${out}%` : out;
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
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  useEffect(() => { run(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const rows = result?.rows ?? null;
  const cols = rows && rows.length
    ? Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((c) => c !== "symbol")
    : [];
  const ctl = useTableControls(rows, 25);

  return (
    <Shell>
      <h1 className="heading mb-3">SCREENERS</h1>

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
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="text-mut text-xs flex-1">{SCREENS[active].desc}</div>
        <StatusBadge kind="delayed" />
        {result?.as_of && <DataAge at={result.as_of} prefix="Scan data" />}
        {rows && rows.length > 0 && (
          <button onClick={() => exportCsv(SCREENS[active].label, cols, rows)} className="btn-ghost">
            Export CSV
          </button>
        )}
        <button onClick={() => run()} disabled={busy} className="btn-primary">
          {busy ? "Scanning…" : "Run screen"}
        </button>
      </div>

      {err && <div className="text-red text-sm mb-3">{err}</div>}

      {result && rows && rows.length === 0 && (
        <div className="panel-2 p-4 text-mut">
          <div>{result.note || "No matches for this screen."}</div>
          {typeof result.scanned === "number" && (
            <div className="text-xs mt-2 opacity-80">
              Scanned {result.scanned} names
              {typeof result.evaluable === "number" ? `, ${result.evaluable} returned usable data` : ""}.
            </div>
          )}
        </div>
      )}

      {/* ROCE availability note on EVERY preset, not just empty states:
          free providers only supply real ROCE for FMP-covered names, so the
          column is often all "—" — say so instead of looking broken. */}
      {rows && rows.length > 0 && cols.includes("roce") && rows.every((r) => r.roce == null) && (
        <div className="text-[10.5px] text-amber/90 mb-2">
          ROCE is unavailable for these names on free data (FMP key-metrics covers
          mostly US listings; NSE names lack a free ROCE source) — the column shows
          “—” rather than an ROE substitute.
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          <TableToolbar ctl={ctl} placeholder="Filter by name / ticker…" />
          <div className="panel overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-mut uppercase tracking-wider">
                <tr className="border-b border-line">
                  {cols.map((c) => (
                    <SortableTh key={c} label={c.replace(/_/g, " ")} k={c} ctl={ctl}
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
          </div>
          <Pager ctl={ctl} />
        </>
      )}
    </Shell>
  );
}
