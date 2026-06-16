"use client";

import { useEffect, useState } from "react";

import { api, type NewsItem } from "@/lib/api";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 0) return "";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function News({ ticker }: { ticker: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true); setErr(null); setItems(null);
    api.news(ticker, 15).then(setItems).catch((e) => setErr(e?.detail || "Failed to load news.")).finally(() => setBusy(false));
  }, [ticker]);

  if (busy) return <div className="text-mut text-xs">Loading headlines…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;
  if (!items || items.length === 0) return <div className="panel-2 p-4 text-mut text-sm">No recent headlines for {ticker}.</div>;

  return (
    <div className="space-y-2">
      {items.map((n, i) => (
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
  );
}
