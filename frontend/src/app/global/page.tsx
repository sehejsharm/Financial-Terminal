"use client";

import { useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { Shell } from "@/components/Shell";
import { PageHeader } from "@/components/ui";
import { StatusBadge } from "@/components/StatusBadge";
import { BoardSummary } from "@/components/global/BoardSummary";
import { CrossRates, Heatmap, SessionStrip } from "@/components/global/WorldBoard";
import { api, type Indicator } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

/**
 * Global markets — the WEIF / GLCO / BTMM cluster on one page.
 *
 * Previously three tabs of identical tiles, which meant you could never see
 * equities and the currency that moved them at the same time. It's now a
 * single scrollable board: who's trading, a regional heatmap, commodities,
 * the FX cross-rate matrix, and the rate complex.
 *
 * Every tile streams off the shared QuoteStore socket, so this page adds no
 * polling of its own. Coverage is provider-dependent — non-Indian symbols
 * route through Twelve Data / yfinance, which are rate-limited and (for
 * yfinance) blocked from some cloud IPs. Anything that can't be priced says
 * so rather than showing a confident zero.
 */

const EQUITY = [
  { title: "Americas", syms: ["^GSPC", "^IXIC", "^DJI", "^RUT", "^GSPTSE", "^BVSP"] },
  { title: "Europe & UK", syms: ["^FTSE", "^GDAXI", "^FCHI", "^STOXX50E", "^IBEX", "^FTMC"] },
  { title: "Asia-Pacific", syms: ["^NSEI", "^BSESN", "^N225", "^HSI", "^KS11", "^AXJO", "^STI", "000001.SS"] },
  { title: "Volatility", syms: ["^VIX", "^INDIAVIX"] },
];

const COMMODITIES = [
  { title: "Energy", syms: ["CL=F", "BZ=F", "NG=F", "RB=F"] },
  { title: "Metals", syms: ["GC=F", "SI=F", "HG=F", "PL=F"] },
  { title: "Agriculture", syms: ["ZW=F", "ZC=F", "ZS=F", "SB=F"] },
];

const RATE_COUNTRIES = [
  { code: "US", label: "United States" },
  { code: "IN", label: "India" },
  { code: "EU", label: "Eurozone" },
  { code: "UK", label: "United Kingdom" },
  { code: "JP", label: "Japan" },
];

/** Policy + benchmark rates for one economy. */
function RatePanel() {
  const [country, setCountry] = useState("US");
  const [inds, setInds] = useState<Indicator[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setBusy(true); setErr(null); setInds(null);
    api.macroIndicators(country)
      .then((m) => { if (alive) { setInds(m.data); setAt(m.fetchedAt); } })
      .catch((e) => { if (alive) setErr(e?.detail || "Rate feed unavailable."); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [country]);

  const rates = (inds ?? []).filter((i) =>
    i.unit === "%" || /rate|yield|spread|bond/i.test(i.name));

  return (
    <section className="mb-5">
      <div className="flex flex-wrap items-center gap-2 mb-2 pb-1.5 border-b border-line2">
        <h2 className="heading">Rate complex</h2>
        {RATE_COUNTRIES.map((c) => (
          <button key={c.code} onClick={() => setCountry(c.code)}
                  className={`px-2 py-1 rounded text-[10.5px] tracking-wide border transition-colors ${
                    country === c.code
                      ? "border-amber text-amber bg-amber/10"
                      : "border-line2 text-mut hover:text-txt"}`}>
            {c.label}
          </button>
        ))}
        <div className="flex-1" />
        <StatusBadge kind="delayed" />
        <DataAge at={at} />
      </div>

      {busy && <div className="text-mut text-xs">Loading {country} rates…</div>}
      {err && <div className="hud p-4 text-sm text-mut">{err}</div>}
      {!busy && !err && rates.length === 0 && (
        <div className="hud p-4 text-mut text-sm">
          No rate series available for this economy on the configured macro feed.
        </div>
      )}
      {rates.length > 0 && (
        <div className="hud overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line2">
                <th className="text-left px-3 py-2 font-medium">Series</th>
                <th className="text-right px-3 py-2 font-medium">Latest</th>
                <th className="text-right px-3 py-2 font-medium">Change</th>
                <th className="text-right px-3 py-2 font-medium">Prior</th>
                <th className="text-left px-3 py-2 font-medium">As of</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.name} className="border-b border-line/60 hover:bg-panel2">
                  <td className="px-3 py-2">
                    {r.name}
                    {r.stale && (
                      <span className="ml-2 text-[9px] px-1 rounded border border-amber/50 text-amber uppercase">stale</span>
                    )}
                  </td>
                  <td className="px-3 py-2 num text-right">
                    {r.value != null ? `${fmtNum(r.value, 2)}%` : "—"}
                  </td>
                  <td className={`px-3 py-2 num text-right ${
                    r.change == null ? "text-mut" : r.change >= 0 ? "text-green" : "text-red"}`}>
                    {r.change != null ? `${r.change >= 0 ? "▲" : "▼"} ${fmtNum(Math.abs(r.change), 2)}` : "—"}
                  </td>
                  <td className="px-3 py-2 num text-right text-mut">
                    {r.prior != null ? fmtNum(r.prior, 2) : "—"}
                  </td>
                  <td className="px-3 py-2 text-mut">{r.date ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function GlobalPage() {
  const total = [...EQUITY, ...COMMODITIES].reduce((a, g) => a + g.syms.length, 0);

  return (
    <Shell>
      <PageHeader
        title="GLOBAL MARKETS"
        subtitle={`${total} instruments across equity indices, commodities and
                   currencies, tinted by the size of the day's move.`} />

      <SessionStrip />

      {/* Breadth, coverage and the risk read — off the same tick store the
          tiles use, so it costs no request. Equities only: oil rising is
          risk-on in a demand story and risk-off in a supply shock. */}
      <BoardSummary
        groups={EQUITY.filter((g) => g.title !== "Volatility")}
        volSyms={EQUITY.find((g) => g.title === "Volatility")?.syms ?? []} />

      <Heatmap groups={EQUITY} />
      <Heatmap groups={COMMODITIES} />
      <CrossRates />
      <RatePanel />

      <div className="text-[10.5px] text-mut leading-relaxed">
        Cells are shaded by the size of the day&apos;s move, saturating at ±2% —
        past that the direction matters more than the exact figure. Tiles
        reading &ldquo;···&rdquo; are subscribed but unpriced: the free tier serves
        Indian listings direct from NSE and routes everything else through
        Twelve Data / yfinance, which are rate-limited and sometimes blocked
        from cloud hosts. Session clocks come from each venue&apos;s own timezone
        and handle daylight saving, but do <span className="text-txt">not</span>{" "}
        know public holidays.
      </div>
    </Shell>
  );
}
