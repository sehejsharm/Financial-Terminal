"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";

import { ChipToggle, EmptyState } from "@/components/ui";
import { timeAgoShort, useNow } from "@/lib/clock";
import {
  AGE_BUCKETS, bucketOf, clusterStories, filterItems, freshness, outletOf,
  sourceCounts, type Cluster, type FeedItem,
} from "@/lib/newsFeed";

/**
 * The reading surface for a list of headlines.
 *
 * This is a place to READ, so the headline is the object on the page and
 * everything else recedes: outlet, age and coverage are one quiet line, the
 * summary is grey and the chrome is nearly invisible until hovered.
 *
 * Two structural things it does. The same story reaches four outlets, and
 * showing it four times buries three other stories — so copies fold into the
 * lead with the others named underneath, still individually clickable. And a
 * page of headlines all six hours old looks exactly like a page of live ones
 * until you read every timestamp, so age is a heading rather than a detail.
 *
 * The one piece of emphasis is deliberate: the most-covered story in the
 * newest bucket is set larger. That is not decoration — how many independent
 * outlets ran a story is the only importance signal a wire actually carries.
 */

const RECENCY = [
  { id: "1", label: "1h" },
  { id: "6", label: "6h" },
  { id: "24", label: "24h" },
  { id: "0", label: "All" },
] as const;

const DENSITY = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
] as const;

/**
 * A stable colour per outlet, from the name.
 *
 * Not decoration: with six feeds interleaved, a colour makes the source
 * legible at a glance where an all-grey uppercase label does not. Hashed
 * rather than mapped so a new feed gets a colour without a code change, and
 * confined to hues that stay readable on both themes.
 */
const HUES = [8, 32, 48, 96, 168, 200, 232, 280, 320];
function outletHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

function OutletMark({ name }: { name: string }) {
  const hue = outletHue(name);
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span aria-hidden className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: `hsl(${hue} 70% 55%)` }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function Story({ cluster, now, compact, badge, lead }: {
  cluster: Cluster; now: number; compact?: boolean;
  badge?: (it: FeedItem) => ReactNode;
  /** The one story set large — the most-covered item in the newest bucket. */
  lead?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { lead: item, others, outlets } = cluster;

  return (
    <article className={`group border-b border-line2/70 last:border-b-0 ${
      lead ? "pb-4 mb-1" : ""}`}>
      <a href={item.link} target="_blank" rel="noopener noreferrer"
         className="block py-3 -mx-2 px-2 rounded hover:bg-panel2/60 transition-colors">
        {/* Byline: outlet, age, and how many outlets carried it. One quiet
            line so the headline below is unambiguously the object. */}
        <div className="flex items-center gap-2 text-[10.5px] text-mut mb-1.5">
          <span className="min-w-0 max-w-[45%]">
            <OutletMark name={outletOf(item)} />
          </span>
          <span aria-hidden className="text-line2">·</span>
          <span className="num whitespace-nowrap shrink-0">
            {timeAgoShort(item.published, now)}
          </span>
          {others.length > 0 && (
            <>
              <span aria-hidden className="text-line2">·</span>
              <span className="text-amber/90 whitespace-nowrap shrink-0">
                {outlets.length} outlets
              </span>
            </>
          )}
          <span className="flex-1" />
          <ExternalLink size={11}
                        className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
        </div>

        <h3 className={`text-txt font-medium leading-snug group-hover:text-amber
                        transition-colors ${
          lead ? "text-[17px] md:text-[19px]" : "text-[14.5px]"}`}>
          {badge?.(item)}{item.title}
        </h3>

        {!compact && item.summary && (
          <p className={`text-mut mt-1.5 leading-relaxed ${
            lead ? "text-[13px] line-clamp-3" : "text-xs line-clamp-2"}`}>
            {item.summary}
          </p>
        )}
      </a>

      {others.length > 0 && (
        <div className="pb-2.5 -mt-1">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
                  className="flex items-center gap-1 text-[10.5px] text-mut hover:text-amber transition-colors">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Also covered by {others.length}{" "}
            {others.length === 1 ? "outlet" : "outlets"}
          </button>
          {open && (
            <div className="mt-2 pl-4 border-l border-line2 grid gap-2">
              {others.map((o, i) => (
                <a key={i} href={o.link} target="_blank" rel="noopener noreferrer"
                   className="block group/o">
                  <div className="text-[10px] text-mut mb-0.5">
                    <OutletMark name={outletOf(o)} />
                  </div>
                  <div className="text-xs text-mut group-hover/o:text-txt transition-colors leading-snug">
                    {o.title}
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function NewsFeed({
  items, emptyTitle = "No headlines right now.", emptyDetail, compact, badge,
  query, onQueryChange,
}: {
  items: FeedItem[];
  emptyTitle?: string;
  emptyDetail?: string;
  /** Hide summaries — used where the feed is a side panel, not the page. */
  compact?: boolean;
  /** Optional prefix for a headline (the ticker view tags sentiment here). */
  badge?: (it: FeedItem) => ReactNode;
  /** Controlled search text, for a parent that drives the filter. Omit both
   *  and the box keeps its own state, as every caller expects. */
  query?: string;
  onQueryChange?: (q: string) => void;
}) {
  const now = useNow();
  const [ownQ, setOwnQ] = useState("");
  const controlled = query != null && onQueryChange != null;
  const q = controlled ? query : ownQ;
  const setQ = controlled ? onQueryChange : setOwnQ;
  const [source, setSource] = useState("all");
  const [within, setWithin] = useState("0");
  const [density, setDensity] = useState<string>("comfortable");
  const dense = density === "compact" || compact;

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

  // The one story set large: most-covered in the newest bucket that has one.
  // Ties keep the newest, which is what a wire would do.
  const leadKey = useMemo(() => {
    const first = buckets[0]?.[1];
    if (!first?.length) return null;
    let best = 0;
    for (let i = 1; i < first.length; i++) {
      if (first[i].outlets.length > first[best].outlets.length) best = i;
    }
    return `${buckets[0][0]}-${best}`;
  }, [buckets]);

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
        {!compact && (
          <ChipToggle options={DENSITY} value={density} onChange={setDensity} />
        )}
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

      {/* One line of provenance, kept small: a page of six-hour-old headlines
          reads exactly like a live one otherwise. */}
      <div className="text-[10.5px] text-mut mb-4">
        {fresh.newestMins == null
          ? `${fresh.total} headlines, none carrying a timestamp.`
          : `${fresh.total} from ${fresh.outlets} `
            + `${fresh.outlets === 1 ? "source" : "sources"} · newest `
            + `${fresh.newestMins}m ago · ${fresh.lastHour} in the last hour`}
        {filtered.length !== items.length && ` · showing ${filtered.length}`}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={items.length ? "Nothing matches those filters." : emptyTitle}
          detail={items.length
            ? "Widen the time window or clear the search."
            : emptyDetail} />
      ) : (
        buckets.map(([bucket, list]) => (
          <section key={bucket} className="mb-7">
            {/* Sticky so the age of what you're reading stays on screen
                through a long scroll — the whole point of bucketing. */}
            <div className="sticky top-0 z-10 flex items-center gap-2.5 py-1.5 mb-1
                            bg-bg/95 backdrop-blur-sm">
              <span className="text-[11px] uppercase tracking-[0.14em] text-amber/90">
                {bucket}
              </span>
              <span className="text-[10px] text-mut num">{list.length}</span>
              <span className="flex-1 h-px bg-line2" />
            </div>
            <div className="mb-stagger">
              {list.map((c, i) => (
                <Story key={`${bucket}-${i}`} cluster={c} now={now}
                       compact={dense} badge={badge}
                       lead={!dense && `${bucket}-${i}` === leadKey} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
