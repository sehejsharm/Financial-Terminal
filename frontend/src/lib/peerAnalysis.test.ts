import { describe, expect, it } from "vitest";

import {
  COMP_METRICS, compareAll, compareMetric, findSubject, median, MIN_PEERS,
  peerNote, sortComps, type CompRowish,
} from "./peerAnalysis";

const PE = COMP_METRICS.find((m) => m.key === "P/E")!;
const ROE = COMP_METRICS.find((m) => m.key === "ROE%")!;

function set(pes: Array<[string, number | null]>): CompRowish[] {
  return pes.map(([t, pe]) => ({ Ticker: t, Name: t, "P/E": pe }));
}

describe("median", () => {
  it("takes the middle of an odd set and the mean of the middle two", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is unmoved by an outlier that would wreck a mean", () => {
    // One peer whose earnings collapsed carries a P/E of 180. A mean would
    // report every other name as a huge discount.
    const xs = [18, 20, 22, 24, 180];
    expect(median(xs)).toBe(22);
    expect(xs.reduce((a, b) => a + b) / xs.length).toBeGreaterThan(50);
  });

  it("handles an empty set", () => {
    expect(median([])).toBeNull();
  });
});

describe("findSubject", () => {
  it("matches even though the endpoint strips the exchange suffix", () => {
    const rows = set([["RELIANCE", 24], ["ONGC", 8]]);
    expect(findSubject(rows, "RELIANCE.NS")?.Ticker).toBe("RELIANCE");
  });

  it("is case insensitive and returns null when absent", () => {
    expect(findSubject(set([["aapl", 30]]), "AAPL")?.Ticker).toBe("aapl");
    expect(findSubject(set([["AAPL", 30]]), "MSFT")).toBeNull();
  });
});

describe("compareMetric", () => {
  const rows = set([
    ["SUBJ", 30], ["A", 20], ["B", 22], ["C", 18], ["D", 24],
  ]);

  it("measures the premium against the peer MEDIAN", () => {
    const c = compareMetric(rows, "SUBJ", PE);
    expect(c.peerMedian).toBe(22);
    expect(c.premiumPct).toBeCloseTo(((30 - 22) / 22) * 100, 6);
    expect(c.verdict).toBe("expensive");
  });

  it("calls a low multiple cheap", () => {
    const c = compareMetric(set([["SUBJ", 12], ["A", 20], ["B", 22], ["C", 24]]),
                            "SUBJ", PE);
    expect(c.verdict).toBe("cheap");
    expect(c.premiumPct!).toBeLessThan(0);
  });

  it("calls a small gap IN LINE rather than a position", () => {
    // A 4% premium is noise, not a valuation view.
    const c = compareMetric(set([["SUBJ", 20.8], ["A", 20], ["B", 22], ["C", 18]]),
                            "SUBJ", PE);
    expect(c.verdict).toBe("in line");
  });

  it("reads a QUALITY metric the other way round", () => {
    // High ROE is strong; high P/E is expensive. Same arithmetic, opposite
    // meaning, and treating them alike would call a great business dear.
    const rows2: CompRowish[] = [
      { Ticker: "SUBJ", "ROE%": 28 }, { Ticker: "A", "ROE%": 14 },
      { Ticker: "B", "ROE%": 16 }, { Ticker: "C", "ROE%": 12 },
    ];
    expect(compareMetric(rows2, "SUBJ", ROE).verdict).toBe("strong");
  });

  it("ranks the subject within the peers", () => {
    const c = compareMetric(rows, "SUBJ", PE);
    expect(c.rank).toBe(5);      // highest P/E of five
    expect(c.n).toBe(5);
  });

  it("REFUSES a verdict when too few peers report the metric", () => {
    const thin = set([["SUBJ", 30], ["A", 20]]);
    const c = compareMetric(thin, "SUBJ", PE);
    expect(c.verdict).toBeNull();
    expect(c.premiumPct).toBeNull();
    expect(MIN_PEERS).toBeGreaterThan(2);
  });

  it("still reports the median it could compute", () => {
    const thin = set([["SUBJ", 30], ["A", 20]]);
    expect(compareMetric(thin, "SUBJ", PE).peerMedian).toBe(25);
  });

  it("ignores peers with no value for the metric", () => {
    const rows2 = set([["SUBJ", 30], ["A", 20], ["B", null], ["C", 22], ["D", 18]]);
    expect(compareMetric(rows2, "SUBJ", PE).n).toBe(4);
  });

  it("returns nothing rather than dividing by a zero median", () => {
    const rows2 = set([["SUBJ", 0], ["A", 0], ["B", 0], ["C", 0]]);
    expect(compareMetric(rows2, "SUBJ", PE).premiumPct).toBeNull();
  });
});

describe("compareAll", () => {
  it("skips metrics no peer reports", () => {
    const rows = set([["SUBJ", 30], ["A", 20], ["B", 22], ["C", 18]]);
    const out = compareAll(rows, "SUBJ");
    expect(out.map((c) => c.key)).toEqual(["P/E"]);
  });
});

describe("peerNote", () => {
  const many = set([["SUBJ", 30], ["A", 20], ["B", 22], ["C", 18], ["D", 24]]);

  it("says the name is dear when most multiples say so", () => {
    const note = peerNote(compareAll(many, "SUBJ"), "SUBJ", many.length);
    expect(note).toMatch(/trades above the peer median/);
  });

  it("warns that a discount is not automatically an opportunity", () => {
    const cheap = set([["SUBJ", 12], ["A", 20], ["B", 22], ["C", 24]]);
    const note = peerNote(compareAll(cheap, "SUBJ"), "SUBJ", cheap.length);
    expect(note).toMatch(/below the peer median/);
    expect(note).toMatch(/not automatically an opportunity/);
    expect(note).toMatch(/does not adjust/);
  });

  it("refuses to summarise a set that is too small", () => {
    const note = peerNote([], "SUBJ", 2);
    expect(note).toMatch(/not a comparison/);
  });

  it("says so when no multiple is comparable", () => {
    expect(peerNote([], "SUBJ", 6)).toMatch(/No valuation multiple/);
  });
});

describe("sortComps", () => {
  const rows = set([["A", 20], ["B", null], ["C", 12]]);

  it("sorts numerically", () => {
    expect(sortComps(rows, "P/E", "asc").map((r) => r.Ticker))
      .toEqual(["C", "A", "B"]);
  });

  it("keeps missing values LAST in both directions", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(sortComps(rows, "P/E", dir).at(-1)!.Ticker).toBe("B");
    }
  });

  it("sorts text columns too", () => {
    expect(sortComps(rows, "Ticker", "desc").map((r) => r.Ticker))
      .toEqual(["C", "B", "A"]);
  });

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.Ticker);
    sortComps(rows, "P/E", "desc");
    expect(rows.map((r) => r.Ticker)).toEqual(before);
  });
});
