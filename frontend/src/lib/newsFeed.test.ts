import { describe, expect, it } from "vitest";

import {
  AGE_BUCKETS, bucketOf, clusterStories, filterItems, freshness, outletOf,
  sourceCounts, tokens, tsOf, type FeedItem,
} from "./newsFeed";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60000).toISOString();

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  title: "A headline", publisher: "Economic Times", link: "https://x/1",
  summary: "", published: ago(10), ...over,
});

describe("tokens", () => {
  it("keeps significant words and drops filler", () => {
    const t = tokens("Reliance shares jump after the earnings beat");
    expect(t.has("reliance")).toBe(true);
    expect(t.has("shares")).toBe(true);
    expect(t.has("earnings")).toBe(true);
    expect(t.has("the")).toBe(false);
    expect(t.has("after")).toBe(false);   // stopword
  });

  it("ignores punctuation and case", () => {
    expect(tokens("RELIANCE's Q1: profit up!").has("reliance")).toBe(true);
  });

  it("survives an empty headline", () => {
    expect(tokens("").size).toBe(0);
  });
});

describe("clusterStories", () => {
  it("groups the same story told by several outlets", () => {
    const items = [
      item({ title: "Reliance profit jumps 12% in quarterly earnings", publisher: "Mint" }),
      item({ title: "Quarterly earnings: Reliance profit climbs 12%", publisher: "Moneycontrol" }),
      item({ title: "Nifty ends flat as banks drag", publisher: "Business Standard" }),
    ];
    const cl = clusterStories(items);
    expect(cl).toHaveLength(2);
    expect(cl[0].others).toHaveLength(1);
    expect(cl[0].outlets).toEqual(["Mint", "Moneycontrol"]);
    expect(cl[1].others).toHaveLength(0);
  });

  it("does NOT merge stories that merely share a company name", () => {
    // Over-merging is the failure that actually hurts: it hides a story.
    const items = [
      item({ title: "Reliance profit jumps in quarterly earnings" }),
      item({ title: "Reliance announces telecom spectrum purchase" }),
    ];
    expect(clusterStories(items)).toHaveLength(2);
  });

  it("keeps the FIRST item as the lead, so a sorted feed leads with newest", () => {
    const items = [
      item({ title: "Reliance profit jumps 12% quarterly earnings", published: ago(5) }),
      item({ title: "Reliance quarterly earnings profit up 12%", published: ago(90) }),
    ];
    const [c] = clusterStories(items);
    expect(tsOf(c.lead)).toBe(Date.parse(ago(5)));
  });

  it("never loses or duplicates an item", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item({ title: `Story number ${i} about markets today`, link: `https://x/${i}` }));
    const cl = clusterStories(items);
    const flat = cl.flatMap((c) => [c.lead, ...c.others]);
    expect(flat).toHaveLength(items.length);
    expect(new Set(flat.map((x) => x.link)).size).toBe(items.length);
  });

  it("handles an empty feed", () => {
    expect(clusterStories([])).toEqual([]);
  });
});

describe("outletOf", () => {
  it("prefers the publisher, falls back to the feed", () => {
    expect(outletOf(item({ publisher: "Mint", source: "Google News" }))).toBe("Mint");
    expect(outletOf(item({ publisher: "", source: "Google News" }))).toBe("Google News");
    expect(outletOf(item({ publisher: "", source: null }))).toBe("Unknown");
  });
});

describe("filterItems", () => {
  const items = [
    item({ title: "Reliance profit up", source: "Mint", published: ago(10) }),
    item({ title: "Nifty ends lower", source: "Moneycontrol", published: ago(600) }),
    item({ title: "Rupee steady", source: "Mint", published: null }),
  ];

  it("filters by source", () => {
    expect(filterItems(items, { source: "Mint" }, NOW)).toHaveLength(2);
    expect(filterItems(items, { source: "all" }, NOW)).toHaveLength(3);
  });

  it("requires EVERY search word, not any of them", () => {
    // ORing the terms returns the whole feed and reads as a broken search.
    expect(filterItems(items, { q: "reliance profit" }, NOW)).toHaveLength(1);
    expect(filterItems(items, { q: "reliance nifty" }, NOW)).toHaveLength(0);
  });

  it("searches the summary too", () => {
    const withSummary = [item({ title: "Markets", summary: "gold hits a record" })];
    expect(filterItems(withSummary, { q: "gold" }, NOW)).toHaveLength(1);
  });

  it("filters by recency but KEEPS undated items", () => {
    // Dropping them would silently shrink the feed whenever a publisher
    // ships a malformed date.
    const out = filterItems(items, { withinHours: 1 }, NOW);
    expect(out.map((i) => i.title)).toEqual(["Reliance profit up", "Rupee steady"]);
  });

  it("an empty filter is a no-op", () => {
    expect(filterItems(items, {}, NOW)).toHaveLength(3);
  });
});

describe("sourceCounts", () => {
  it("counts by feed, most first", () => {
    const out = sourceCounts([
      item({ source: "Mint" }), item({ source: "Mint" }), item({ source: "CNBC" }),
    ]);
    expect(out).toEqual([{ name: "Mint", n: 2 }, { name: "CNBC", n: 1 }]);
  });

  it("falls back to the publisher when there is no feed name", () => {
    expect(sourceCounts([item({ source: null, publisher: "Reuters" })]))
      .toEqual([{ name: "Reuters", n: 1 }]);
  });
});

describe("bucketOf / AGE_BUCKETS", () => {
  it("buckets by age", () => {
    expect(bucketOf(item({ published: ago(30) }), NOW)).toBe("Last hour");
    expect(bucketOf(item({ published: ago(300) }), NOW)).toBe("Today");
    expect(bucketOf(item({ published: ago(30 * 60) }), NOW)).toBe("Yesterday");
    expect(bucketOf(item({ published: ago(5 * 24 * 60) }), NOW)).toBe("Earlier");
    expect(bucketOf(item({ published: null }), NOW)).toBe("Undated");
  });

  it("treats an unparseable date as undated rather than as 1970", () => {
    expect(bucketOf(item({ published: "not a date" }), NOW)).toBe("Undated");
  });

  it("declares buckets newest-first, which is the order the page renders", () => {
    expect([...AGE_BUCKETS]).toEqual(
      ["Last hour", "Today", "Yesterday", "Earlier", "Undated"]);
  });
});

describe("freshness", () => {
  it("reports the age of the newest item and how many are very recent", () => {
    const f = freshness([
      item({ published: ago(7), source: "Mint" }),
      item({ published: ago(120), source: "CNBC" }),
    ], NOW);
    expect(f.newestMins).toBe(7);
    expect(f.lastHour).toBe(1);
    expect(f.total).toBe(2);
    expect(f.outlets).toBe(2);
  });

  it("says nothing rather than zero when nothing is dated", () => {
    expect(freshness([item({ published: null })], NOW).newestMins).toBeNull();
  });

  it("handles an empty feed", () => {
    expect(freshness([], NOW)).toEqual({
      newestMins: null, lastHour: 0, total: 0, outlets: 0,
    });
  });
});
