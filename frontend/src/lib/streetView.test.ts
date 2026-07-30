import { describe, expect, it } from "vitest";

import {
  consensusLabel, holderConcentration, ownershipNote, parseRecommendations,
  recTrend, streetNote, type Frameish,
} from "./streetView";

function recs(rows: Array<[string, number, number, number, number, number]>): Frameish {
  return {
    columns: ["period", "strongBuy", "buy", "hold", "sell", "strongSell"],
    rows: rows.map(([period, sb, b, h, s, ss]) => ({
      period, strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss,
    })),
  };
}

describe("parseRecommendations", () => {
  it("counts each bucket and scores the consensus", () => {
    // 4 strong buy, 4 buy, 2 hold -> (4+8+6)/10 = 1.8
    const [p] = parseRecommendations(recs([["0m", 4, 4, 2, 0, 0]]));
    expect(p.total).toBe(10);
    expect(p.score).toBeCloseTo(1.8, 6);
    expect(p.bullishPct).toBeCloseTo(80, 6);
  });

  it("sorts periods oldest first, and -2m IS older than -1m", () => {
    // A plain string sort puts "-1m" before "-2m" and reverses the trend.
    const out = parseRecommendations(recs([
      ["0m", 1, 1, 1, 0, 0], ["-2m", 1, 1, 1, 0, 0], ["-1m", 1, 1, 1, 0, 0],
    ]));
    expect(out.map((p) => p.period)).toEqual(["-2m", "-1m", "0m"]);
  });

  it("folds provider synonyms into the same bucket", () => {
    const f: Frameish = {
      columns: ["period", "outperform", "neutral", "underweight"],
      rows: [{ period: "0m", outperform: 5, neutral: 3, underweight: 2 }],
    };
    const [p] = parseRecommendations(f);
    expect(p.counts.buy).toBe(5);
    expect(p.counts.hold).toBe(3);
    expect(p.counts.sell).toBe(2);
  });

  it("drops periods with no ratings at all", () => {
    expect(parseRecommendations(recs([["0m", 0, 0, 0, 0, 0]]))).toEqual([]);
  });

  it("handles an empty or missing frame", () => {
    expect(parseRecommendations(null)).toEqual([]);
    expect(parseRecommendations({ columns: [], rows: [] })).toEqual([]);
  });
});

describe("consensusLabel", () => {
  it("bands the 1-to-5 score", () => {
    expect(consensusLabel(1.2)).toBe("Strong buy");
    expect(consensusLabel(2.1)).toBe("Buy");
    expect(consensusLabel(3.0)).toBe("Hold");
    expect(consensusLabel(4.2)).toBe("Sell");
    expect(consensusLabel(4.8)).toBe("Strong sell");
    expect(consensusLabel(null)).toBeNull();
  });
});

describe("recTrend", () => {
  it("reads a FALLING score as an upgrade", () => {
    // The scale runs 1 (strong buy) to 5 (strong sell). Reading the sign the
    // natural way calls an upgrade cycle a downgrade.
    const t = recTrend(parseRecommendations(recs([
      ["-2m", 0, 2, 8, 0, 0],   // score 2.8
      ["0m", 6, 4, 0, 0, 0],    // score 1.4
    ])));
    expect(t.scoreChange!).toBeLessThan(0);
    expect(t.direction).toBe("upgrading");
  });

  it("reads a rising score as a downgrade", () => {
    const t = recTrend(parseRecommendations(recs([
      ["-2m", 6, 4, 0, 0, 0], ["0m", 0, 2, 8, 0, 0],
    ])));
    expect(t.direction).toBe("downgrading");
  });

  it("calls a tiny move unchanged rather than a cycle", () => {
    const t = recTrend(parseRecommendations(recs([
      ["-1m", 5, 5, 0, 0, 0], ["0m", 5, 5, 0, 0, 0],
    ])));
    expect(t.direction).toBe("unchanged");
  });

  it("tracks the change in coverage", () => {
    const t = recTrend(parseRecommendations(recs([
      ["-1m", 2, 2, 1, 0, 0], ["0m", 4, 4, 2, 0, 0],
    ])));
    expect(t.coverageChange).toBe(5);
  });

  it("survives an empty history", () => {
    expect(recTrend([]).direction).toBeNull();
  });
});

describe("streetNote", () => {
  it("reports coverage, consensus and direction", () => {
    const note = streetNote(recTrend(parseRecommendations(recs([
      ["-2m", 0, 2, 8, 0, 0], ["0m", 6, 4, 0, 0, 0],
    ]))));
    expect(note).toMatch(/10 analysts covering/);
    expect(note).toMatch(/Strong buy|Buy/);
    expect(note).toMatch(/shifted towards buy/);
  });

  it("says what a rating is and is not good for", () => {
    const note = streetNote(recTrend(parseRecommendations(recs([["0m", 5, 5, 0, 0, 0]]))));
    expect(note).toMatch(/poor timing signal/);
    expect(note).toMatch(/structurally long/);
  });

  it("says so when there is nothing", () => {
    expect(streetNote(recTrend([]))).toMatch(/No recommendation history/);
  });
});

// ── ownership ───────────────────────────────────────────────────────────

function holders(rows: Array<[string, number]>, pctCol = "% Out"): Frameish {
  return {
    columns: ["Holder", pctCol, "Shares"],
    rows: rows.map(([h, p]) => ({ Holder: h, [pctCol]: p, Shares: 1000 })),
  };
}

describe("holderConcentration", () => {
  it("sums the largest five and names the largest", () => {
    const c = holderConcentration(holders([
      ["Alpha Fund", 9.2], ["Beta Fund", 6.1], ["Gamma", 4.4],
      ["Delta", 3.0], ["Epsilon", 2.2], ["Zeta", 1.1],
    ]));
    expect(c.top5Pct).toBeCloseTo(24.9, 6);
    expect(c.top1Pct).toBeCloseTo(9.2, 6);
    expect(c.largest!.name).toBe("Alpha Fund");
    expect(c.n).toBe(6);
  });

  it("normalises a provider that sends fractions", () => {
    // 0.0512 and 5.12 are the same stake; treating the first as 0.05% would
    // report a heavily-held register as almost unowned.
    const c = holderConcentration(holders([["A", 0.0512], ["B", 0.0304]]));
    expect(c.top1Pct).toBeCloseTo(5.12, 6);
  });

  it("decides the scale for the COLUMN, not row by row", () => {
    // A genuine 1.0% holding beside a 12% one must stay 1.0%. A per-row
    // "at or below 1 means fraction" rule turns it into 100%.
    const c = holderConcentration(holders([["Small", 1], ["Big", 12]]));
    expect(c.largest!.name).toBe("Big");
    expect(c.top1Pct).toBeCloseTo(12, 6);
    expect(c.top5Pct).toBeCloseTo(13, 6);
  });

  it("reports the column it read, for the caveat", () => {
    expect(holderConcentration(holders([["A", 5]], "pctHeld")).basis).toBe("pctHeld");
  });

  it("returns nothing usable when there is no percentage column", () => {
    const f: Frameish = { columns: ["Holder", "Shares"], rows: [{ Holder: "A", Shares: 5 }] };
    const c = holderConcentration(f);
    expect(c.top5Pct).toBeNull();
    expect(c.n).toBe(1);
  });

  it("handles an empty frame", () => {
    expect(holderConcentration(null).n).toBe(0);
  });
});

describe("ownershipNote", () => {
  it("states the concentration and that stakes do not sum to 100", () => {
    const note = ownershipNote(holderConcentration(holders([
      ["Alpha Fund", 9.2], ["Beta", 6.1], ["Gamma", 4.4],
    ])));
    expect(note).toMatch(/Alpha Fund/);
    expect(note).toMatch(/do not sum to 100%/);
    expect(note).toMatch(/filings lag/);
  });

  it("flags a stake big enough to be an overhang", () => {
    const note = ownershipNote(holderConcentration(holders([["Whale", 18]])));
    expect(note).toMatch(/stabiliser until it is an overhang/);
  });

  it("says so when there is no percentage column", () => {
    const f: Frameish = { columns: ["Holder"], rows: [{ Holder: "A" }] };
    expect(ownershipNote(holderConcentration(f)))
      .toMatch(/no percentage column/);
  });

  it("says so when nothing is disclosed", () => {
    expect(ownershipNote(holderConcentration(null)))
      .toMatch(/No institutional holdings/);
  });
});
