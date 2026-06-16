"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { WatchlistEditor } from "@/components/WatchlistEditor";
import { api, type Mover, type Quote } from "@/lib/api";
import { curForTicker, fmtNum, fmtPct } from "@/lib/utils";

// All NSE-resolvable so the dashboard fills via the direct NSE provider
// (fast, never blocked). The old INR=X / GC=F / SI=F / CL=F set went through
// Yahoo and timed out on Render free.
const SNAPSHOT_TICKERS = [
  "^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX",
  "^CNXIT", "^CNXFMCG", "^CNXAUTO", "^CNXPHARMA",
  "^CNXMETAL", "^CNXENERGY", "^CNXMIDCAP", "^CNX500",
];
const NAMES: Record<string, string> = {
  "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY",
  "^INDIAVIX": "INDIA VIX", "^CNXIT": "NIFTY IT", "^CNXFMCG": "NIFTY FMCG",
  "^CNXAUTO": "NIFTY AUTO", "^CNXPHARMA": "NIFTY PHARMA",
  "^CNXMETAL": "NIFTY METAL", "^CNXENERGY": "NIFTY ENERGY",
  "^CNXMIDCAP": "NIFTY MIDCAP 100", "^CNX500": "NIFTY 500",
};

function MoversPanel() {
  const [kind, setKind] = useState<"gainers" | "losers">("gainers");
  const [rows, setRows] = useState<Mover[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(true);
    api.movers(kind, 8).then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([])).finally(() => setBusy(false));
  }, [kind]);

  return (
    <div className="panel-2 p-4">
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setKind("gainers")} className={`btn ${kind === "gainers" ? "btn-primary" : "btn-ghost"}`}>Gainers</button>
        <button onClick={() => setKind("losers")} className={`btn ${kind === "losers" ? "btn-primary" : "btn-ghost"}`}>Losers</button>
      </div>
      {busy && <div className="text-mut text-xs">Loading…</div>}
      {!busy && rows.length === 0 && <div className="text-mut text-xs">No data.</div>}
      <div className="flex flex-col gap-1">
        {rows.map((m, i) => {
          const sym = String(m.symbol ?? m.ticker ?? "");
          const cp = Number(m.change_pct ?? m.percent_change ?? 0);
          return (
            <Link key={i} href={`/terminal?t=${encodeURIComponent(sym)}`}
                  className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-panel border border-transparent hover:border-line">
              <span className="text-sm truncate">{String(m.name ?? sym)}</span>
              <span className={`num text-sm ${cp >= 0 ? "text-green" : "text-red"}`}>{fmtPct(cp)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.quoteBulk(SNAPSHOT_TICKERS)
      .then((m) => { setQuotes(m); setLoaded(true); })
      .catch(() => { setQuotes({}); setLoaded(true); });
  }, []);

  return (
    <Shell>
      <h1 className="heading mb-3">MARKET SNAPSHOT</h1>
      <div className="grid gap-3 mb-8" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {SNAPSHOT_TICKERS.map((t) => {
          const q = quotes[t];
          const cur = curForTicker(t, q?.currency);
          const cp = q?.change_pct ?? null;
          const tone = cp == null ? "neutral" : cp >= 0 ? "positive" : "negative";
          const pending = !loaded && !q;
          return (
            <Link key={t} href={`/terminal?t=${encodeURIComponent(t)}`}>
              <MetricCard
                label={NAMES[t] ?? t}
                value={q?.price != null ? `${cur}${fmtNum(q.price, 2)}` : (pending ? "···" : "—")}
                delta={cp != null ? fmtPct(cp) : null}
                tone={tone}
                className={`cursor-pointer ${pending ? "animate-pulse" : ""}`}
              />
            </Link>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 mb-8">
        <div>
          <h1 className="heading mb-3">WATCHLISTS</h1>
          <WatchlistEditor />
        </div>
        <div>
          <h1 className="heading mb-3">MOVERS</h1>
          <MoversPanel />
        </div>
      </div>
    </Shell>
  );
}
