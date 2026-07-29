"use client";

import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { NewsFeed } from "@/components/news/NewsFeed";
import { ErrorState, Loading } from "@/components/ui";
import { api, type NewsItem, type SentimentResp } from "@/lib/api";
import type { FeedItem } from "@/lib/newsFeed";
import { fmtNum } from "@/lib/utils";

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

/**
 * Headlines for one symbol, with an optional AI sentiment pass.
 *
 * The list is the shared NewsFeed — same search, recency filter, source
 * filter, age headings and story clustering as the market wire. A ticker's
 * news used to be a plain list that behaved differently from the news page
 * for no reason anyone had chosen.
 */
export function News({ ticker }: { ticker: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<SentimentResp | null>(null);
  const [sentBusy, setSentBusy] = useState(false);
  const [sentErr, setSentErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true); setErr(null); setItems(null); setSent(null); setSentErr(null);
    api.news(ticker, 40)
      .then(setItems)
      .catch((e) => setErr(e?.detail || "Failed to load news."))
      .finally(() => setBusy(false));
  }, [ticker]);
  useEffect(() => { load(); }, [load]);

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

  if (busy && !items) return <Loading what={`headlines for ${ticker}`} />;
  if (err) return <ErrorState message={err} onRetry={load} />;

  const sentimentOf = (it: FeedItem) =>
    sent?.items.find((s) => s.title === it.title)?.sentiment;

  const counts = (["bull", "bear", "neutral"] as const).map((k) => ({
    k, n: (items ?? []).filter((i) => sentimentOf(i) === k).length,
  }));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {sent?.score != null && (
          <span className={`text-sm num ${sent.score > 0.15 ? "text-green" : sent.score < -0.15 ? "text-red" : "text-mut"}`}>
            Sentiment {sent.score > 0 ? "+" : ""}{fmtNum(sent.score, 2)}
            <span className="text-[10px] text-mut ml-1">(−1 bearish … +1 bullish, AI-tagged)</span>
            <TrendBars history={sent.history} />
          </span>
        )}
        {sent && (
          <span className="flex flex-wrap gap-1">
            {counts.filter((c) => c.n > 0).map(({ k, n }) => (
              <span key={k}
                    className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${SENT_STYLE[k]}`}>
                {n} {k}
              </span>
            ))}
          </span>
        )}
        <div className="flex-1" />
        {sentErr && <span className="text-red text-[11px]">{sentErr}</span>}
        <button onClick={analyze} disabled={sentBusy}
                className="btn-ghost flex items-center gap-1.5 text-xs">
          <Sparkles size={12} />
          {sentBusy ? "Analyzing…" : sent ? "Re-analyze" : "Analyze sentiment (AI)"}
        </button>
      </div>

      <NewsFeed
        items={items ?? []}
        badge={(it) => {
          const s = sentimentOf(it);
          if (!s) return null;
          return (
            <span className={`inline-block align-middle mr-2 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${SENT_STYLE[s]}`}>
              {s}
            </span>
          );
        }}
        emptyTitle={`No recent headlines for ${ticker}.`}
        emptyDetail="Yahoo, its RSS mirror and a Google News search all came back
                     empty for this symbol." />
    </div>
  );
}
