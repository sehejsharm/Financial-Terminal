"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import { ChipToggle, EmptyState, Note } from "@/components/ui";
import { timeAgoShort, useNow } from "@/lib/clock";
import {
  AGE_BUCKETS, bucketOf, clusterStories, filterItems, freshness, outletOf,
  sourceCounts, type Cluster, type FeedItem,
} from "@/lib/newsFeed";

/**
 * The reading surface for a list of headlines.
 *
 * Two things make this more than a list. First, the same story reaches four
 * outlets, and showing it four times buries three other stories — so copies
 * are folded into the lead item with the other outlets named underneath,
 * still individually clickable. Second, a page of headlines all six hours
 * old looks exactly like a page of live ones until you read every timestamp,
 * so age is a heading rather than a detail.
 */

const RECENCY = [
  { id: "1", label: "1h" },
  { id: "6", label: "6h" },
  { id: "24", label: "24h" },
  { id: "0", label: "All" },
] as const;

function Row({ cluster, now, compact, badge }: {
  cluster: Cluster; now: number; compact?: boolean;
  badge?: (it: FeedItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { lead, others, outlets } = cluster;

  return (
    <div className="panel-2 mb-lift hover:border-amber/60 transition-colors">
      <a href={lead.link} target="_blank" rel="noopener noreferrer"
         className="block px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-amber/80 mb-1 truncate">
              {outletOf(lead)}
              {others.length > 0 && (
                <span className="text-mut normal-case tracking-normal">
                  {" "}· {outlets.length} outlets
                </span>
              )}
            </div>
            <div className="text-sm text-txt font-medium leading-snug">
              {badge?.(lead)}{lead.title}
            </div>
            {!compact && lead.summary && (
              <div className="text-xs text-mut mt-1 line-clamp-2 leading-relaxed">
                {lead.summary}
              </div>
            )}
          </div>
          <span className="text-[10px] text-mut whitespace-nowrap mt-0.5 shrink-0">
            {timeAgoShort(lead.published, now)}
          </span>
        </div>
      </a>

      {others.length > 0 && (
        <div className="px-3.5 pb-2.5">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
                  className="flex items-center gap-1 text-[10.5px] text-mut hover:text-amber">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {others.length} more {others.length === 1 ? "outlet" : "outlets"} on this story
          </button>
          {open && (
            <div className="mt-1.5 pl-4 border-l border-line2 grid gap-1.5">
              {others.map((o, i) => (
                <a key={i} href={o.link} target="_blank" rel="noopener noreferrer"
                   className="block group">
                  <span className="text-[10px] uppercase tracking-wider text-mut group-hover:text-amber">
                    {outletOf(o)}
                  </span>
                  <span className="text-xs text-mut group-hover:text-txt ml-2">
                    {o.title}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NewsFeed({
  items, emptyTitle = "No headlines right now.", emptyDetail, compact, badge,
}: {
  items: FeedItem[];
  emptyTitle?: string;
  emptyDetail?: string;
  /** Hide summaries — used where the feed is a side panel, not the page. */
  compact?: boolean;
  /** Optional prefix for a headline (the ticker view tags sentiment here). */
  badge?: (it: FeedItem) => ReactNode;
}) {
  const now = useNow();
  const [q, setQ] = useState("");
  const [source, setSource] = useState("all");
  const [within, setWithin] = useState("0");

  const sources = useMemo(() => sourceCounts(items), [items]);
  const filtered = useMemo(
    () => filterItems(items, { q, source, withinHours: Number(within) || 0 }, now),
    [items, q, source, within, now]);
  // Cluster ACROSS the whole filtered list, then bucket by the lead's age.
  // Bucketing first split a syndicated story that straddled an hour
  // boundary — the same headline appeared once under "Last hour" and again
  // under "Today", which is exactly what clustering exists to prevent.
  const clusters = useMemo(() => clusterStories(filtered), [filtered]);
  const buckets = useMemo(() => {
    const by = new Map<string, Cluster[]>();
    for (const c of clusters) {
      const b = bucketOf(c.lead, now);
      if (!by.has(b)) by.set(b, []);
      by.get(b)!.push(c);
    }
    return AGE_BUCKETS.filter((b) => by.has(b)).map((b) => [b, by.get(b)!] as const);
  }, [clusters, now]);
  const fresh = useMemo(() => freshness(items, now), [items, now]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="relative flex-1 min-w-[200px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mut" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Filter headlines…"
                 className="input-bare !py-1.5 !pl-7 text-xs w-full" />
        </label>
        <ChipToggle options={RECENCY} value={within} onChange={setWithin} />
        {sources.length > 1 && (
          <select value={source} onChange={(e) => setSource(e.target.value)}
                  className="input-bare !py-1.5 text-xs cursor-pointer max-w-[220px]">
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s.name} value={s.name}>{s.name} ({s.n})</option>
            ))}
          </select>
        )}
      </div>

      <div className="text-[10.5px] text-mut mb-3">
        {fresh.newestMins == null
          ? `${fresh.total} headlines, none carrying a timestamp.`
          : `${fresh.total} headlines from ${fresh.outlets} `
            + `${fresh.outlets === 1 ? "source" : "sources"}; newest `
            + `${fresh.newestMins}m old, ${fresh.lastHour} in the last hour.`}
        {filtered.length !== items.length && ` Showing ${filtered.length}.`}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={items.length ? "Nothing matches those filters." : emptyTitle}
          detail={items.length
            ? "Widen the time window or clear the search."
            : emptyDetail} />
      ) : (
        buckets.map(([bucket, list]) => (
          <section key={bucket} className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="label-xs">{bucket}</span>
              <span className="text-[10px] text-mut num">{list.length}</span>
              <span className="flex-1 h-px bg-line2" />
            </div>
            <div className="grid gap-2 mb-stagger">
              {list.map((c, i) => (
                <Row key={`${bucket}-${i}`} cluster={c} now={now} compact={compact}
                     badge={badge} />
              ))}
            </div>
          </section>
        ))
      )}

      <Note>
        Stories carried by several outlets are folded together by shared
        headline words — a crude match, tuned to under-merge rather than
        over-merge, so two different stories about the same company stay
        apart. Every copy stays clickable under &ldquo;more outlets&rdquo;.
      </Note>
    </>
  );
}
