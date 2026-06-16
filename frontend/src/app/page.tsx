"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Shell } from "@/components/Shell";
import { api, type Quote, type Watchlist } from "@/lib/api";
import { curSymbol, fmtNum, fmtPct, humanNumber } from "@/lib/utils";

const SNAPSHOT_TICKERS = [
  "^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX",
  "INR=X", "GC=F", "SI=F", "CL=F",
];
const NAMES: Record<string, string> = {
  "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY",
  "^INDIAVIX": "INDIA VIX", "INR=X": "USD / INR", "GC=F": "GOLD",
  "SI=F": "SILVER", "CL=F": "WTI CRUDE",
};

export default function DashboardPage() {
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({});
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);

  useEffect(() => {
    // Single round-trip — backend fetches all 8 in parallel server-side.
    api.quoteBulk(SNAPSHOT_TICKERS)
      .then((map) => setQuotes(map))
      .catch(() => setQuotes({}));
    api.listWatchlists().then(setWatchlists).catch(() => setWatchlists([]));
  }, []);

  return (
    <Shell>
      <h1 className="heading mb-3">MARKET SNAPSHOT</h1>
      <div className="grid gap-3 mb-8" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {SNAPSHOT_TICKERS.map((t) => {
          const q = quotes[t];
          const cur = curSymbol(q?.currency);
          const cp = q?.change_pct ?? null;
          const tone = cp == null ? "neutral" : cp >= 0 ? "positive" : "negative";
          return (
            <Link key={t} href={`/terminal?t=${encodeURIComponent(t)}`}>
              <MetricCard
                label={NAMES[t] ?? t}
                value={q?.price != null ? `${cur}${fmtNum(q.price, 2)}` : "—"}
                delta={cp != null ? fmtPct(cp) : null}
                tone={tone}
                className="cursor-pointer"
              />
            </Link>
          );
        })}
      </div>

      <h1 className="heading mb-3">WATCHLISTS</h1>
      {watchlists.length === 0 ? (
        <div className="panel-2 p-6 text-mut text-sm">
          No watchlists yet. Create one from the Terminal page, or via the API
          (<code className="text-amber">POST /api/v1/watchlists</code>).
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {watchlists.map((w) => (
            <div key={w.id} className="panel-2 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-amber font-bold uppercase tracking-wider text-sm">{w.name}</div>
                <span className="chip">{w.tickers.length} names</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {w.tickers.map((t) => (
                  <Link
                    key={t}
                    href={`/terminal?t=${encodeURIComponent(t)}`}
                    className="px-2 py-1 text-[11px] border border-line rounded hover:border-amber hover:text-amber transition-colors"
                  >
                    {t}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
