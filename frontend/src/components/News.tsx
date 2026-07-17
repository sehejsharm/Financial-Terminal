"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { api, type NewsItem, type SentimentResp } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 0) return "";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const SENT_STYLE: Record<string, string> = {
  bull: "border-green/60 text-green",
  bear: "border-red/60 text-red",
  neutral: "border-line2 text-mut",
};

/** Tiny inline sentiment-trend sparkline from the rollup history. */
function TrendBars({ history }: { history: SentimentResp["history"] }) {
  if (history.length < 2) return null;
  const recent = history.slice(-20);
  return (
    <span className="inline-flex items-end gap-[2px] h-4 ml-2" title="Sentiment trend (older → newer)">
      {recent.map((h, i) => (
        <span key={i}
              className={h.score >= 0 ? "bg-green/70" : "bg-red/70"}
              style={{ width: 3, height: `${Math.max(2, Math.abs(h.score) * 14 + 2)}px` }} />
      ))}
    </span>
  );
}

export function News({ ticker }: { ticker: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<SentimentResp | null>(null);
  const [sentBusy, setSentBusy] = useState(false);
  const [sentErr, setSentErr] = useState<string | null>(null);

  const load = () => {
    setBusy(true); setErr(null); setItems(null); setSent(null); setSentErr(null);
    api.news(ticker, 15).then(setItems).catch((e) => setErr(e?.detail || "Failed to load news.")).finally(() => setBusy(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [ticker]);

  // Explicit button (not auto) — each analysis is a Groq call; results are
  // server-cached 30 min per ticker.
  async function analyze() {
    setSentBusy(true); setSentErr(null);
    try {
      setSent(await api.sentiment(ticker));
    } catch (e: any) {
      setSentErr(e?.detail || "Sentiment analysis failed.");
    } finally {
      setSentBusy(false);
    }
  }

  if (busy) return <div className="text-mut text-xs animate-pulse">Loading headlines…</div>;
  if (err) {
    return (
      <div className="panel-2 p-4 text-sm">
        <div className="text-red mb-2">{err}</div>
        <button onClick={load} className="btn-ghost text-xs">Retry</button>
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div className="panel-2 p-4 text-mut text-sm flex items-center gap-3">
        <span>No recent headlines for {ticker}.</span>
        <button onClick={load} className="btn-ghost text-xs shrink-0">Retry</button>
      </div>
    );
  }

  const label = (title: string) =>
    sent?.items.find((s) => s.title === title)?.sentiment;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        {sent?.score != null && (
          <span className={`text-sm num ${sent.score > 0.15 ? "text-green" : sent.score < -0.15 ? "text-red" : "text-mut"}`}>
            Sentiment {sent.score > 0 ? "+" : ""}{fmtNum(sent.score, 2)}
            <span className="text-[10px] text-mut ml-1">(−1 bearish … +1 bullish, AI-tagged)</span>
            <TrendBars history={sent.history} />
          </span>
        )}
        <div className="flex-1" />
        {sentErr && <span className="text-red text-[11px]">{sentErr}</span>}
        <button onClick={analyze} disabled={sentBusy} className="btn-ghost flex items-center gap-1.5 text-xs">
          <Sparkles size={12} />
          {sentBusy ? "Analyzing…" : sent ? "Re-analyze" : "Analyze sentiment (AI)"}
        </button>
      </div>

      <div className="space-y-2">
        {items.map((n, i) => {
          const s = label(n.title);
          return (
            <a key={i} href={n.link} target="_blank" rel="noopener noreferrer"
               className="block panel-2 p-3 hover:border-amber transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm text-txt font-medium leading-snug">
                  {s && (
                    <span className={`inline-block align-middle mr-2 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${SENT_STYLE[s]}`}>
                      {s}
                    </span>
                  )}
                  {n.title}
                </div>
                <span className="text-[10px] text-mut whitespace-nowrap mt-0.5">{timeAgo(n.published)}</span>
              </div>
              {n.summary && <div className="text-xs text-mut mt-1 line-clamp-2">{n.summary}</div>}
              <div className="text-[10px] text-amber/80 uppercase tracking-wider mt-1.5">{n.publisher}</div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
