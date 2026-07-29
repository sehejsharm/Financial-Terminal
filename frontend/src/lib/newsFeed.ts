/** Reading logic for the news feed.
 *
 *  The backend hands over a flat, deduplicated, newest-first list from nine
 *  outlets. Everything that turns that into something readable — search,
 *  source and recency filters, age buckets, and grouping the same story as
 *  told by four outlets into one row — happens here, so it can be tested
 *  without a network or a browser.
 */

export type FeedItem = {
  title: string;
  publisher: string;
  link: string;
  summary: string;
  published: string | null;
  /** The feed it arrived on, which is not always the outlet named in it. */
  source?: string | null;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "than", "then", "into",
  "over", "after", "before", "will", "says", "said", "amid", "have", "has",
  "was", "were", "are", "its", "his", "her", "their", "they", "you", "your",
  "but", "not", "all", "can", "may", "new", "now", "get", "gets", "how", "why",
  "what", "when", "who", "week", "day", "days", "year", "years", "here",
  "more", "most", "less", "top", "amp", "per", "cent",
]);

/** Significant words in a headline, lowercased and de-duplicated. */
export function tokens(title: string): Set<string> {
  const words = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

export type Cluster = {
  /** The lead story — the newest member, since the list arrives sorted. */
  lead: FeedItem;
  /** Other outlets carrying what looks like the same story. */
  others: FeedItem[];
  /** Distinct outlets across lead + others. */
  outlets: string[];
};

/**
 * Group headlines that look like the same story.
 *
 * Deliberately crude: shared significant words, greedy, first-match-wins.
 * It is not topic modelling and doesn't pretend to be — the failure mode
 * that matters is over-merging two different stories, so the threshold is
 * set high (three shared words) and a cluster's members stay individually
 * visible and clickable rather than being collapsed away.
 */
export function clusterStories(items: FeedItem[], minShared = 3): Cluster[] {
  const tokenised = items.map((it) => ({ it, tk: tokens(it.title) }));
  const used = new Array(items.length).fill(false);
  const out: Cluster[] = [];

  for (let i = 0; i < tokenised.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const lead = tokenised[i];
    const others: FeedItem[] = [];
    for (let j = i + 1; j < tokenised.length; j++) {
      if (used[j]) continue;
      if (overlap(lead.tk, tokenised[j].tk) >= minShared) {
        used[j] = true;
        others.push(tokenised[j].it);
      }
    }
    const outlets: string[] = [];
    for (const it of [lead.it, ...others]) {
      const name = outletOf(it);
      if (name && !outlets.includes(name)) outlets.push(name);
    }
    out.push({ lead: lead.it, others, outlets });
  }
  return out;
}

/** The name to show for an item: the outlet, falling back to the feed. */
export function outletOf(it: FeedItem): string {
  return (it.publisher || it.source || "").trim() || "Unknown";
}

export type Filters = {
  /** Free text over the title and summary. */
  q?: string;
  /** Feed name, or "all". */
  source?: string;
  /** Only items published within this many hours; 0 or undefined = no limit. */
  withinHours?: number;
};

export function filterItems(items: FeedItem[], f: Filters, now: number): FeedItem[] {
  const q = (f.q || "").trim().toLowerCase();
  const src = f.source && f.source !== "all" ? f.source : null;
  const cutoff = f.withinHours ? now - f.withinHours * 3_600_000 : null;

  return items.filter((it) => {
    if (src && (it.source ?? it.publisher) !== src) return false;
    if (q) {
      const hay = `${it.title} ${it.summary}`.toLowerCase();
      // Every word must appear — a two-word search that ORs its terms
      // returns the whole feed and looks broken.
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (cutoff != null) {
      const t = tsOf(it);
      // An item with NO timestamp is kept: it's a real headline, and
      // dropping it would silently shrink the feed the moment a publisher
      // ships a malformed date.
      if (t != null && t < cutoff) return false;
    }
    return true;
  });
}

export function tsOf(it: FeedItem): number | null {
  if (!it.published) return null;
  const t = Date.parse(it.published);
  return Number.isFinite(t) ? t : null;
}

/** Feed name -> count, ordered by count then name. */
export function sourceCounts(items: FeedItem[]): { name: string; n: number }[] {
  const by = new Map<string, number>();
  for (const it of items) {
    const name = (it.source ?? it.publisher ?? "").trim();
    if (!name) continue;
    by.set(name, (by.get(name) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

export const AGE_BUCKETS = ["Last hour", "Today", "Yesterday", "Earlier", "Undated"] as const;
export type AgeBucket = typeof AGE_BUCKETS[number];

export function bucketOf(it: FeedItem, now: number): AgeBucket {
  const t = tsOf(it);
  if (t == null) return "Undated";
  const age = now - t;
  if (age < 3_600_000) return "Last hour";
  if (age < 24 * 3_600_000) return "Today";
  if (age < 48 * 3_600_000) return "Yesterday";
  return "Earlier";
}

/**
 * How fresh is this feed, in one line.
 *
 * Useful because a page of headlines all six hours old looks identical to a
 * page of live ones until you read the timestamps.
 */
export function freshness(items: FeedItem[], now: number): {
  newestMins: number | null; lastHour: number; total: number; outlets: number;
} {
  const stamps = items.map((it) => tsOf(it)).filter((t): t is number => t != null);
  const newest = stamps.length ? Math.max(...stamps) : null;
  return {
    newestMins: newest == null ? null : Math.max(0, Math.round((now - newest) / 60000)),
    lastHour: items.filter((it) => bucketOf(it, now) === "Last hour").length,
    total: items.length,
    outlets: sourceCounts(items).length,
  };
}
