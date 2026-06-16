"use client";

import { useEffect, useState } from "react";

import { News } from "@/components/News";
import { Shell } from "@/components/Shell";
import { api, type NewsItem } from "@/lib/api";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 0) return "";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function Hero({ item }: { item: NewsItem }) {
  return (
    <a href={item.link} target="_blank" rel="noopener noreferrer"
       className="block panel-2 p-5 hover:border-amber transition-colors col-span-2 row-span-2 relative overflow-hidden">
      <div className="absolute top-3 right-3 text-[9px] uppercase tracking-[0.18em] text-amber bg-amber/10 px-2 py-0.5 rounded border border-amber/40">FEATURED</div>
      <div className="text-[10px] text-amber/80 uppercase tracking-wider mb-2">{item.publisher} · {timeAgo(item.published)}</div>
      <div className="text-lg font-bold text-white leading-snug mb-2 pr-12">{item.title}</div>
      <div className="text-sm text-mut line-clamp-4">{item.summary}</div>
    </a>
  );
}

function MiniCard({ item }: { item: NewsItem }) {
  return (
    <a href={item.link} target="_blank" rel="noopener noreferrer"
       className="block panel-2 p-3 hover:border-amber transition-colors">
      <div className="text-[10px] text-amber/80 uppercase tracking-wider mb-1">{item.publisher} · {timeAgo(item.published)}</div>
      <div className="text-sm text-txt font-medium leading-snug line-clamp-3">{item.title}</div>
    </a>
  );
}

export default function NewsPage() {
  const [tab, setTab] = useState<"market" | "ticker">("market");
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticker, setTicker] = useState("RELIANCE.NS");

  useEffect(() => {
    if (tab !== "market") return;
    setBusy(true);
    api.marketNews(30).then(setItems).catch(() => setItems([])).finally(() => setBusy(false));
  }, [tab]);

  const hero = items?.[0];
  const subHero = items?.slice(1, 5) ?? [];
  const rest = items?.slice(5) ?? [];

  return (
    <Shell>
      <h1 className="heading mb-3">NEWS</h1>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setTab("market")} className={`btn ${tab === "market" ? "btn-primary" : "btn-ghost"}`}>Market headlines</button>
        <button onClick={() => setTab("ticker")} className={`btn ${tab === "ticker" ? "btn-primary" : "btn-ghost"}`}>By ticker</button>
      </div>

      {tab === "market" && (
        <>
          {busy && <div className="text-mut text-xs">Loading headlines…</div>}
          {items && items.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No headlines available right now.</div>}

          {hero && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6"
                   style={{ gridAutoRows: "minmax(110px, auto)" }}>
                <Hero item={hero} />
                {subHero.map((it, i) => <MiniCard key={i} item={it} />)}
              </div>

              {rest.length > 0 && (
                <>
                  <div className="heading mb-2">More headlines</div>
                  <div className="space-y-2">
                    {rest.map((n, i) => (
                      <a key={i} href={n.link} target="_blank" rel="noopener noreferrer"
                         className="block panel-2 p-3 hover:border-amber transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-sm text-txt font-medium leading-snug">{n.title}</div>
                          <span className="text-[10px] text-mut whitespace-nowrap mt-0.5">{timeAgo(n.published)}</span>
                        </div>
                        {n.summary && <div className="text-xs text-mut mt-1 line-clamp-2">{n.summary}</div>}
                        <div className="text-[10px] text-amber/80 uppercase tracking-wider mt-1.5">{n.publisher}</div>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {tab === "ticker" && (
        <>
          <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
                 placeholder="Ticker" className="input-bare mb-4 max-w-sm" />
          <News ticker={ticker} />
        </>
      )}
    </Shell>
  );
}
