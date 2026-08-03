"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";

import { Methodology } from "@/components/Methodology";
import { NewsFeed } from "@/components/news/NewsFeed";
import { ErrorState, Loading, Note, SectionHeader } from "@/components/ui";
import { api, type SentimentResp, type TickerNews } from "@/lib/api";
import type { FeedItem } from "@/lib/newsFeed";
import {
  filterNote, matchLabel, normTitle, sentimentIndex, sentimentNote, summarise,
} from "@/lib/newsSentiment";
import { fmtNum } from "@/lib/utils";

const SENT_STYLE: Record<string, string> = {
  bull: "border-green/60 text-green",
  bear: "border-red/60 text-red",
  neutral: "border-line2 text-mut",
};

const MATCH_STYLE: Record<string, string> = {
  symbol: "border-amber/50 text-amber",
  name: "border-line2 text-mut",
  loose: "border-red/40 text-red/80",
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
 * CN — headlines for one symbol, with an optional model sentiment pass.
 *
 * The list is the shared NewsFeed, so search, recency, source filtering, age
 * headings and story clustering behave exactly as they do on the market wire.
 *
 * What is new is that the entity filter is now visible. The backend does real
 * work deciding which stories are about THIS company — the fix for a search on
 * RELIANCE.NS returning news about Reliance Steel — and reports what it kept,
 * what it dropped and which name it matched on. That was all being discarded,
 * so a reader looking at four headlines had no way to tell whether the company
 * is quiet or twelve namesake stories were filtered out. It can also be turned
 * off, which is the only way to check what the filter is excluding.
 */
export function News({ ticker }: { ticker: string }) {
  const [feed, setFeed] = useState<TickerNews | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [strict, setStrict] = useState(true);
  const [sent, setSent] = useState<SentimentResp | null>(null);
  const [sentBusy, setSentBusy] = useState(false);
  const [sentErr, setSentErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true); setErr(null); setFeed(null);
    api.tickerNews(ticker, 40, strict)
      .then(setFeed)
      .catch((e) => setErr(e?.detail || "Failed to load news."))
      .finally(() => setBusy(false));
  }, [ticker, strict]);

  // The sentiment pass is per ticker, not per filter setting, so it survives a
  // strict toggle — the tags are keyed by title and match either way.
  useEffect(() => { setSent(null); setSentErr(null); }, [ticker]);
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

  const items = feed?.items ?? [];
  // Matched on a NORMALISED title: an exact string compare loses the tag the
  // moment the feed re-encodes an apostrophe, and a lost tag renders as an
  // untagged story rather than as an error.
  const index = useMemo(() => sentimentIndex(sent?.items ?? []), [sent]);
  const summary = useMemo(() => summarise(items, index), [items, index]);

  if (busy && !feed) return <Loading what={`headlines for ${ticker}`} />;
  if (err) return <ErrorState message={err} onRetry={load} />;

  const outcome = {
    entity: feed?.entity ?? null,
    matched: feed?.matched ?? null,
    dropped: feed?.dropped ?? null,
    strict: feed?.strict ?? strict,
  };

  return (
    <div>
      <SectionHeader
        title={outcome.entity ? `News — ${outcome.entity}` : `News — ${ticker}`}
        count={`${items.length} stories`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {outcome.dropped != null && outcome.dropped > 0 && outcome.strict && (
              <span className="text-[10.5px] text-amber/90 whitespace-nowrap">
                {outcome.dropped} namesake{outcome.dropped === 1 ? "" : "s"} filtered out
              </span>
            )}
            <button onClick={() => setStrict((s) => !s)}
                    className={`btn ${strict ? "btn-primary" : "btn-ghost"} text-xs`}
                    title={strict
                      ? "Filtering to this company only — click to see the raw feed"
                      : "Showing the raw feed, including similar-named companies"}>
              {strict ? "This company only" : "Raw feed"}
            </button>
            <button onClick={analyze} disabled={sentBusy}
                    className="btn-ghost flex items-center gap-1.5 text-xs">
              <Sparkles size={12} />
              {sentBusy ? "Analyzing…" : sent ? "Re-analyze" : "Analyze sentiment (AI)"}
            </button>
          </div>
        }
      />

      {summary.score != null && (
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <span className={`text-sm num ${
            summary.score > 0.15 ? "text-green"
              : summary.score < -0.15 ? "text-red" : "text-mut"}`}>
            Sentiment {summary.score > 0 ? "+" : ""}{fmtNum(summary.score, 2)}
            <span className="text-[10px] text-mut ml-1">(−1 bearish … +1 bullish)</span>
            {sent && <TrendBars history={sent.history} />}
          </span>
          <span className="flex flex-wrap gap-1">
            {([["bull", summary.bull], ["bear", summary.bear],
               ["neutral", summary.neutral]] as const)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <span key={k}
                      className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${SENT_STYLE[k]}`}>
                  {n} {k}
                </span>
              ))}
          </span>
          {summary.coveragePct != null && summary.coveragePct < 100 && (
            <span className="text-[10.5px] text-mut num">
              {fmtNum(summary.coveragePct, 0)}% of the list tagged
            </span>
          )}
        </div>
      )}

      {sentErr && <div className="text-red text-[11px] mb-2">{sentErr}</div>}

      <NewsFeed
        items={items}
        badge={(it: FeedItem) => {
          const s = index.get(normTitle(it.title));
          // The provider labels how each story was matched; on the raw feed
          // that is the only thing separating this company from its namesake.
          const m = matchLabel((it as { match?: string | null }).match as never);
          if (!s && !m) return null;
          return (
            <>
              {s && (
                <span className={`inline-block align-middle mr-2 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${SENT_STYLE[s]}`}>
                  {s}
                </span>
              )}
              {m && (
                <span title={m.hint}
                      className={`inline-block align-middle mr-2 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${MATCH_STYLE[m.label]}`}>
                  {m.label}
                </span>
              )}
            </>
          );
        }}
        emptyTitle={strict
          ? `No headlines matched ${outcome.entity || ticker}.`
          : `No recent headlines for ${ticker}.`}
        emptyDetail={strict && (outcome.dropped ?? 0) > 0
          ? `${outcome.dropped} stories came back but none of them were about this
             company. Switch to the raw feed to see them.`
          : `Yahoo, its RSS mirror and a Google News search all came back
             empty for this symbol.`} />

      {/* One line, folded away: the filter's own account of what it dropped
          and what a sentiment score does not mean. It belongs on the page —
          it just doesn't belong above the headlines. */}
      <details className="mt-4 group">
        <summary className="text-[10.5px] text-mut cursor-pointer hover:text-amber list-none
                            inline-flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform">›</span>
          How these headlines were chosen
        </summary>
        <div className="mt-2 flex flex-col gap-1.5">
          <Note>{filterNote(outcome)}</Note>
          {sent && <Note>{sentimentNote(summary)}</Note>}
        </div>
        {sent && <Methodology id="newsSentiment" className="mt-3" />}
      </details>
    </div>
  );
}
