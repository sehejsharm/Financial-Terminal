"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { LiveNumber } from "@/components/LiveNumber";
import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { api, type Indicator } from "@/lib/api";
import { useQuote, useQuotes } from "@/lib/useQuote";
import { curForTicker, fmtNum, fmtPct } from "@/lib/utils";

/**
 * Global markets — the Bloomberg WEIF / GLCO / BTMM cluster.
 *
 *   WEIF  world equity indices
 *   GLCO  global commodities (energy / metals / agriculture)
 *   BTMM  FX majors + the rate complex
 *
 * Every tile streams off the shared QuoteStore socket, so this page adds no
 * new polling. Coverage is provider-dependent — non-Indian symbols route
 * through Twelve Data / yfinance, which are rate-limited and (for yfinance)
 * blocked from some cloud IPs. Tiles that can't be priced say so rather than
 * rendering a confident-looking zero.
 */

type Tile = { sym: string; label: string };
type Group = { title: string; note?: string; tiles: Tile[] };

// ── WEIF ────────────────────────────────────────────────────────────────────
const EQUITY: Group[] = [
  {
    title: "Americas",
    tiles: [
      { sym: "^GSPC", label: "S&P 500" },
      { sym: "^IXIC", label: "Nasdaq Composite" },
      { sym: "^DJI", label: "Dow Jones" },
      { sym: "^RUT", label: "Russell 2000" },
      { sym: "^GSPTSE", label: "TSX (Canada)" },
      { sym: "^BVSP", label: "Bovespa (Brazil)" },
    ],
  },
  {
    title: "EMEA",
    tiles: [
      { sym: "^FTSE", label: "FTSE 100" },
      { sym: "^GDAXI", label: "DAX" },
      { sym: "^FCHI", label: "CAC 40" },
      { sym: "^STOXX50E", label: "Euro Stoxx 50" },
      { sym: "^IBEX", label: "IBEX 35" },
      { sym: "^TASI.SR", label: "Tadawul" },
    ],
  },
  {
    title: "Asia-Pacific",
    tiles: [
      { sym: "^NSEI", label: "NIFTY 50" },
      { sym: "^BSESN", label: "SENSEX" },
      { sym: "^N225", label: "Nikkei 225" },
      { sym: "^HSI", label: "Hang Seng" },
      { sym: "^KS11", label: "KOSPI" },
      { sym: "^AXJO", label: "ASX 200" },
    ],
  },
  {
    title: "Volatility",
    note: "Fear gauges — these move inversely to their index.",
    tiles: [
      { sym: "^VIX", label: "VIX (S&P)" },
      { sym: "^INDIAVIX", label: "India VIX" },
    ],
  },
];

// ── GLCO ────────────────────────────────────────────────────────────────────
const COMMODITIES: Group[] = [
  {
    title: "Energy",
    tiles: [
      { sym: "CL=F", label: "WTI Crude" },
      { sym: "BZ=F", label: "Brent Crude" },
      { sym: "NG=F", label: "Natural Gas" },
      { sym: "RB=F", label: "RBOB Gasoline" },
    ],
  },
  {
    title: "Metals",
    tiles: [
      { sym: "GC=F", label: "Gold" },
      { sym: "SI=F", label: "Silver" },
      { sym: "HG=F", label: "Copper" },
      { sym: "PL=F", label: "Platinum" },
    ],
  },
  {
    title: "Agriculture",
    tiles: [
      { sym: "ZW=F", label: "Wheat" },
      { sym: "ZC=F", label: "Corn" },
      { sym: "ZS=F", label: "Soybeans" },
      { sym: "SB=F", label: "Sugar" },
    ],
  },
];

// ── BTMM ────────────────────────────────────────────────────────────────────
const FX: Group[] = [
  {
    title: "Majors",
    tiles: [
      { sym: "EURUSD=X", label: "EUR / USD" },
      { sym: "GBPUSD=X", label: "GBP / USD" },
      { sym: "USDJPY=X", label: "USD / JPY" },
      { sym: "USDCHF=X", label: "USD / CHF" },
    ],
  },
  {
    title: "Asia & commodity blocs",
    tiles: [
      { sym: "USDINR=X", label: "USD / INR" },
      { sym: "USDCNY=X", label: "USD / CNY" },
      { sym: "AUDUSD=X", label: "AUD / USD" },
      { sym: "USDCAD=X", label: "USD / CAD" },
    ],
  },
];

const RATE_COUNTRIES = [
  { code: "US", label: "United States" },
  { code: "IN", label: "India" },
  { code: "EU", label: "Eurozone" },
  { code: "UK", label: "United Kingdom" },
  { code: "JP", label: "Japan" },
];

/** One streaming tile. Subscribes to its own symbol so a tick re-renders only
 *  this card, never the whole grid. */
function QuoteTile({ sym, label }: Tile) {
  const tick = useQuote(sym);
  const cur = curForTicker(sym, tick?.ccy);
  const cp = tick?.chgPct ?? null;
  const has = tick?.ltp != null;
  return (
    <Link href={`/terminal?t=${encodeURIComponent(sym)}`}>
      <MetricCard
        label={label}
        value={has
          ? <LiveNumber value={tick!.ltp} format="price" ccy={cur} />
          : <span className="text-mut text-base">—</span>}
        delta={cp != null ? <LiveNumber value={cp} format="pct" /> : null}
        tone={cp == null ? "neutral" : cp >= 0 ? "positive" : "negative"}
        title={has ? undefined : "No price from the configured free providers for this symbol."}
        className="cursor-pointer"
      />
    </Link>
  );
}

function TileGrid({ groups }: { groups: Group[] }) {
  // One bulk subscription for the whole board; cells read individually.
  useQuotes(groups.flatMap((g) => g.tiles.map((t) => t.sym)));
  const total = groups.reduce((a, g) => a + g.tiles.length, 0);
  return (
    <>
      {groups.map((g) => (
        <div key={g.title} className="mb-6">
          <div className="flex items-baseline gap-3 mb-2">
            <h2 className="heading">{g.title}</h2>
            {g.note && <span className="text-[11px] text-mut">{g.note}</span>}
          </div>
          <div className="grid gap-3"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {g.tiles.map((t) => <QuoteTile key={t.sym} {...t} />)}
          </div>
        </div>
      ))}
      <div className="text-[10.5px] text-mut">
        {total} instruments streaming off the shared socket. Tiles showing “—”
        aren&apos;t broken: the free provider tier doesn&apos;t price that symbol from
        this host. Indian listings come direct from NSE and are the most reliable.
      </div>
    </>
  );
}

/** BTMM rate complex: policy + benchmark rates for one economy. */
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

  // The rate complex is the subset of macro indicators quoted in percent.
  const rates = (inds ?? []).filter((i) =>
    i.unit === "%" || /rate|yield|spread|bond/i.test(i.name));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="heading">Rate complex</h2>
        {RATE_COUNTRIES.map((c) => (
          <button key={c.code} onClick={() => setCountry(c.code)}
                  className={`btn ${country === c.code ? "btn-primary" : "btn-ghost"}`}>
            {c.label}
          </button>
        ))}
        <div className="flex-1" />
        <StatusBadge kind="delayed" />
        <DataAge at={at} />
      </div>
      {busy && <div className="text-mut text-xs">Loading {country} rates…</div>}
      {err && <div className="panel-2 p-4 text-sm text-mut">{err}</div>}
      {!busy && !err && rates.length === 0 && (
        <div className="panel-2 p-4 text-mut text-sm">
          No rate series available for this economy on the configured macro feed.
        </div>
      )}
      {rates.length > 0 && (
        <div className="panel overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                <th className="text-left px-3 py-2 font-medium">Series</th>
                <th className="text-right px-3 py-2 font-medium">Latest</th>
                <th className="text-right px-3 py-2 font-medium">Change</th>
                <th className="text-right px-3 py-2 font-medium">Prior</th>
                <th className="text-left px-3 py-2 font-medium">As of</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.name} className="border-b border-line/60 hover:bg-panel">
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
    </div>
  );
}

const TABS = [
  { key: "weif", label: "WEIF · Equity indices" },
  { key: "glco", label: "GLCO · Commodities" },
  { key: "btmm", label: "BTMM · FX & rates" },
] as const;

export default function GlobalPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("weif");
  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="heading">GLOBAL MARKETS</h1>
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
                    className={`btn ${tab === t.key ? "btn-primary" : "btn-ghost"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "weif" && <TileGrid groups={EQUITY} />}
      {tab === "glco" && <TileGrid groups={COMMODITIES} />}
      {tab === "btmm" && (
        <>
          <TileGrid groups={FX} />
          <RatePanel />
        </>
      )}
    </Shell>
  );
}
