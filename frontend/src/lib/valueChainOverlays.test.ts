import { describe, expect, it } from "vitest";

import { mergeEntities } from "./valueChainGraph";
import {
  bareSymbol, buildOverlayIndex, overlayFor, symbolMatchesEntity, textMentionsEntity,
} from "./valueChainOverlays";

const chain = {
  suppliers: [{ name: "HPCL", ticker: "HINDPETRO.NS" }, { name: "Saudi Aramco", ticker: "2222.SR" }],
  customers: [{ name: "Tata Motors", ticker: "TATAMOTORS.NS" }],
  competitors: [{ name: "Tata Steel" }],
};
const entities = mergeEntities(chain);

describe("textMentionsEntity", () => {
  it("matches the full company name in a headline", () => {
    expect(textMentionsEntity("Saudi Aramco raises OSP for Asian buyers", "Saudi Aramco")).toBe(true);
  });
  it("is punctuation and case insensitive", () => {
    expect(textMentionsEntity("TATA MOTORS' Q3 sales jump", "Tata Motors")).toBe(true);
  });
  it("NEVER matches a sibling company on a shared first word", () => {
    // The expensive false positive: badging Tata Motors with Tata Steel news.
    expect(textMentionsEntity("Tata Steel cuts output at Jamshedpur", "Tata Motors")).toBe(false);
    expect(textMentionsEntity("Tata Motors unveils new EV", "Tata Steel")).toBe(false);
  });
  it("ignores generic industry words used as node names", () => {
    expect(textMentionsEntity("Retail sales rebound in December", "Retail")).toBe(false);
    expect(textMentionsEntity("Energy stocks rally", "Energy")).toBe(false);
  });
  it("ignores very short names", () => {
    expect(textMentionsEntity("BP posts record profit", "BP")).toBe(false);
  });
  it("tolerates a corporate suffix on either side", () => {
    expect(textMentionsEntity("Reliance Industries Ltd beats estimates", "Reliance Industries")).toBe(true);
  });
});

describe("symbolMatchesEntity", () => {
  it("matches the AI ticker hint ignoring the exchange suffix", () => {
    const hpcl = entities.find((e) => e.name === "HPCL")!;
    expect(symbolMatchesEntity("HINDPETRO", hpcl)).toBe(true);
    expect(symbolMatchesEntity("HINDPETRO.NS", hpcl)).toBe(true);
  });
  it("falls back to the squashed name when there is no ticker hint", () => {
    const steel = entities.find((e) => e.name === "Tata Steel")!;
    expect(symbolMatchesEntity("TATASTEEL", steel)).toBe(true);
  });
  it("does not match a different company", () => {
    const hpcl = entities.find((e) => e.name === "HPCL")!;
    expect(symbolMatchesEntity("TATAMOTORS", hpcl)).toBe(false);
  });
  it("handles empty input", () => {
    expect(symbolMatchesEntity("", entities[0])).toBe(false);
    expect(bareSymbol(null)).toBe("");
  });
});

describe("buildOverlayIndex", () => {
  it("flags a node the user actually holds", () => {
    const idx = buildOverlayIndex(entities, {
      positions: [{ ticker: "TATAMOTORS.NS", qty: 100, value: 90000, pnl_pct: 12.5 }],
    });
    const tm = entities.find((e) => e.name === "Tata Motors")!;
    expect(overlayFor(idx, tm.key)?.held?.qty).toBe(100);
    expect(overlayFor(idx, tm.key)?.held?.pnlPct).toBe(12.5);
    // and does NOT bleed onto the similarly-named competitor
    const ts = entities.find((e) => e.name === "Tata Steel")!;
    expect(overlayFor(idx, ts.key)?.held).toBeUndefined();
  });

  it("attaches bulk/block deals to the right node with a side", () => {
    const idx = buildOverlayIndex(entities, {
      bulk: [{ symbol: "HINDPETRO", clientName: "LIC", buySell: "BUY", quantity: 250000, date: "2026-07-20" }],
    });
    const hpcl = entities.find((e) => e.name === "HPCL")!;
    const d = overlayFor(idx, hpcl.key)!.deals[0];
    expect(d).toMatchObject({ kind: "bulk", side: "buy", label: "LIC" });
  });

  it("attaches insider disclosures", () => {
    const idx = buildOverlayIndex(entities, {
      insider: [{ symbol: "TATAMOTORS", person: "N. Chandrasekaran", type: "Sell", value: 12000000 }],
    });
    const tm = entities.find((e) => e.name === "Tata Motors")!;
    expect(overlayFor(idx, tm.key)!.deals[0]).toMatchObject({ kind: "insider", side: "sell" });
  });

  it("matches headlines to the node they name, and only that node", () => {
    const idx = buildOverlayIndex(entities, {
      news: [
        { title: "Saudi Aramco lifts crude prices", link: "a", published: "2026-07-20T10:00:00Z" },
        { title: "Tata Steel output steady", link: "b", published: "2026-07-20T09:00:00Z" },
      ],
    });
    const aramco = entities.find((e) => e.name === "Saudi Aramco")!;
    const tm = entities.find((e) => e.name === "Tata Motors")!;
    expect(overlayFor(idx, aramco.key)!.news).toHaveLength(1);
    expect(overlayFor(idx, tm.key)!.news).toHaveLength(0);   // Tata Steel != Tata Motors
  });

  it("marks only UNSEEN headlines as fresh (that's what pulses)", () => {
    const seen = new Set(["old"]);
    const idx = buildOverlayIndex(entities, {
      news: [
        { title: "Saudi Aramco signs supply deal", link: "old", published: null },
      ],
      seenLinks: seen,
    });
    const aramco = entities.find((e) => e.name === "Saudi Aramco")!;
    expect(overlayFor(idx, aramco.key)!.fresh).toBeFalsy();

    const idx2 = buildOverlayIndex(entities, {
      news: [{ title: "Saudi Aramco signs supply deal", link: "brand-new", published: null }],
      seenLinks: seen,
    });
    expect(overlayFor(idx2, aramco.key)!.fresh).toBe(true);
  });

  it("sorts headlines newest-first and caps the list", () => {
    const news = Array.from({ length: 9 }, (_, i) => ({
      title: `Saudi Aramco update ${i}`, link: `l${i}`,
      published: `2026-07-${10 + i}T00:00:00Z`,
    }));
    const idx = buildOverlayIndex(entities, { news });
    const aramco = entities.find((e) => e.name === "Saudi Aramco")!;
    const got = overlayFor(idx, aramco.key)!.news;
    expect(got).toHaveLength(5);
    expect(got[0].link).toBe("l8");   // newest first
  });

  it("returns an empty overlay for every node when there are no sources", () => {
    const idx = buildOverlayIndex(entities, {});
    for (const e of entities) {
      expect(overlayFor(idx, e.key)).toEqual({ deals: [], news: [] });
    }
  });
});
