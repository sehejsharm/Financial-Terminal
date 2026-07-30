import { describe, expect, it } from "vitest";

import {
  CONFIGURED_FEEDS, digestNote, feedHealth, mentions, normalize, themes,
  UNIVERSE, type Item,
} from "./wireDigest";

const item = (title: string, over: Partial<Item> = {}): Item => ({
  title, link: `https://example.com/${encodeURIComponent(title)}`,
  source: "Economic Times", published: "2026-06-30T10:00:00Z", ...over,
});

describe("normalize", () => {
  it("flattens case, punctuation and apostrophes", () => {
    expect(normalize("Dr. Reddy's Labs")).toBe(normalize("dr reddys labs"));
  });

  it("pads the ends so whole-word matching works at the edges", () => {
    expect(normalize("Wipro")).toBe(" wipro ");
  });

  it("keeps ampersands, which several company names need", () => {
    expect(normalize("Mahindra & Mahindra")).toContain("mahindra & mahindra");
  });
});

describe("mentions", () => {
  it("recognises a company by its formal name and by an alias", () => {
    const m = mentions([
      item("Reliance Industries posts record quarter"),
      item("Jio adds 3m subscribers"),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0].ticker).toBe("RELIANCE.NS");
    expect(m[0].count).toBe(2);
  });

  it("matches WHOLE WORDS only", () => {
    // A substring rule tags "Titan" inside "titanium" and turns the list into
    // something every entry has to be double-checked against.
    expect(mentions([item("Titanium prices ease on weak demand")])).toEqual([]);
    expect(mentions([item("Titan Company opens 40 stores")])
      .map((x) => x.ticker)).toEqual(["TITAN.NS"]);
  });

  it("REFUSES to tag a group word to one listed company", () => {
    // "Tata" names half a dozen listed companies. Pinning a group story to one
    // is the same fabrication the per-ticker feed had to be fixed for.
    expect(mentions([item("Tata group weighs a new holding structure")])).toEqual([]);
    expect(mentions([item("Adani in talks over a port deal")])).toEqual([]);
    // ...but the specific company still matches.
    expect(mentions([item("Tata Steel lifts output guidance")])
      .map((x) => x.ticker)).toEqual(["TATASTEEL.NS"]);
  });

  it("ranks by how many stories name each company", () => {
    const m = mentions([
      item("Infosys wins a deal"), item("Infosys raises guidance"),
      item("Infosys hires"), item("Wipro wins a deal"),
    ]);
    expect(m.map((x) => x.ticker)).toEqual(["INFY.NS", "WIPRO.NS"]);
    expect(m[0].count).toBe(3);
  });

  it("tags every company named in one headline, not just the first", () => {
    const m = mentions([item("TCS and Infosys both beat estimates")]);
    expect(m.map((x) => x.ticker).sort()).toEqual(["INFY.NS", "TCS.NS"]);
  });

  it("searches the summary as well as the title", () => {
    const m = mentions([item("IT majors report", { summary: "Wipro led the pack." })]);
    expect(m.map((x) => x.ticker)).toEqual(["WIPRO.NS"]);
  });

  it("keeps a headline and link so the tag is checkable", () => {
    const m = mentions([item("Cipla gets USFDA nod")]);
    expect(m[0].headline).toBe("Cipla gets USFDA nod");
    expect(m[0].link).toContain("https://");
  });

  it("returns nothing for an empty or unrecognised wire", () => {
    expect(mentions([])).toEqual([]);
    expect(mentions([item("Some company nobody has heard of raises funds")])).toEqual([]);
  });

  it("has a universe of unique tickers", () => {
    const tickers = UNIVERSE.map((e) => e.ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
  });
});

describe("themes", () => {
  it("finds recurring two-word subjects", () => {
    const items = [
      item("RBI holds rate cut hopes alive"),
      item("Bond market prices a rate cut"),
      item("Economists expect a rate cut in August"),
      item("Steel output rises"),
    ];
    const t = themes(items, 3);
    expect(t.map((x) => x.phrase)).toContain("rate cut");
  });

  it("counts once per STORY, so syndication can't manufacture a theme", () => {
    // The same phrase five times in one headline is one observation.
    const t = themes([
      item("block deal block deal block deal block deal"),
      item("Another block deal"),
    ], 2);
    expect(t.find((x) => x.phrase === "block deal")!.count).toBe(2);
  });

  it("drops stopwords, so the list isn't topped by 'says' and 'after'", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item(`Analyst says the market will be higher after the open ${i}`));
    for (const t of themes(items, 2)) {
      expect(t.phrase).not.toMatch(/\b(says|after|the|will|be)\b/);
    }
  });

  it("ignores bare numbers, which are never a subject", () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      item(`Nifty 500 500 gains ${i}`));
    for (const t of themes(items, 2)) expect(t.phrase).not.toMatch(/^\d+ \d+$/);
  });

  it("respects the minimum count, so a one-off is not a theme", () => {
    expect(themes([item("solar capacity expands")], 3)).toEqual([]);
  });

  it("caps the list and keeps an example for each", () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`alpha beta gamma delta epsilon zeta ${i % 3}`));
    const t = themes(items, 2, 4);
    expect(t.length).toBeLessThanOrEqual(4);
    for (const x of t) expect(x.example.length).toBeGreaterThan(0);
  });
});

describe("feedHealth", () => {
  it("counts items per source, biggest first", () => {
    const h = feedHealth([
      item("a", { source: "Livemint" }), item("b", { source: "Livemint" }),
      item("c", { source: "CNBC" }),
    ]);
    expect(h.sources[0]).toEqual({ name: "Livemint", n: 2 });
    expect(h.total).toBe(3);
  });

  it("names the configured feeds that delivered NOTHING", () => {
    // A quiet page with three feeds down reads exactly like a quiet market.
    const h = feedHealth([item("a", { source: "Livemint" })]);
    expect(h.silent).toContain("Moneycontrol");
    expect(h.silent).not.toContain("Livemint");
  });

  it("treats a labelled variant as the configured feed", () => {
    // Items arrive as "CNBC-TV18" from a feed configured as "CNBC".
    const h = feedHealth([item("a", { source: "CNBC-TV18" })], ["CNBC"]);
    expect(h.silent).toEqual([]);
  });

  it("falls back to the publisher when there is no source label", () => {
    const h = feedHealth([item("a", { source: null, publisher: "Reuters" })]);
    expect(h.sources[0].name).toBe("Reuters");
  });

  it("reports how dominant the largest source is", () => {
    const h = feedHealth([
      item("a", { source: "Livemint" }), item("b", { source: "Livemint" }),
      item("c", { source: "Livemint" }), item("d", { source: "CNBC" }),
    ]);
    expect(h.topSharePct).toBeCloseTo(75, 6);
  });

  it("says every feed is silent on an empty wire", () => {
    const h = feedHealth([]);
    expect(h.silent).toEqual([...CONFIGURED_FEEDS]);
    expect(h.topSharePct).toBeNull();
  });
});

describe("digestNote", () => {
  const wire = [
    item("Reliance Industries posts record quarter"),
    item("Infosys raises guidance"),
  ];
  const note = () => digestNote(mentions(wire), themes(wire, 1),
                                feedHealth(wire));

  it("states that tagging is a fixed list and the counts are a floor", () => {
    expect(note()).toMatch(/FIXED list of the NIFTY 50/);
    expect(note()).toMatch(/a floor rather than a census/);
  });

  it("explains why group words are not matched", () => {
    expect(note()).toMatch(/Group words like “Tata” and “Adani”/);
    expect(note()).toMatch(/would be a fabrication/);
  });

  it("says themes describe what is written about, not what matters", () => {
    expect(note()).toMatch(/being WRITTEN about, which is not the same as what matters/);
  });

  it("distinguishes a quiet market from silent feeds", () => {
    const n = digestNote([], [], feedHealth([item("x", { source: "Livemint" })]));
    expect(n).toMatch(/configured feeds? returned nothing/);
    expect(n).toMatch(/looks identical to a quiet market/);
  });

  it("flags a wire dominated by one outlet", () => {
    const dom = Array.from({ length: 5 }, (_, i) =>
      item(`story ${i}`, { source: "Livemint" }));
    expect(digestNote(mentions(dom), [], feedHealth(dom)))
      .toMatch(/one outlet's editorial priorities/);
  });

  it("says the recognised names are quiet rather than nothing happening", () => {
    const n = digestNote([], [], feedHealth([item("x")]));
    expect(n).toMatch(/those names are quiet rather than that nothing is happening/);
  });
});
