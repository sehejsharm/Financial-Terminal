import { describe, expect, it } from "vitest";

import {
  CONE_WINDOWS, expectedMove, logReturns, MIN_CONE_SAMPLES, percentile,
  percentileRank, rankLabel, realizedVol, rollingVol, termShape, volProfile,
  type VolBar,
} from "./vol";

function mkBars(closes: number[]): VolBar[] {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    close: c,
  }));
}

/** Deterministic pseudo-random walk — no Math.random, so tests never flake. */
function walk(n: number, dailyVol: number, seed = 1): number[] {
  let s = seed, px = 100;
  const out = [px];
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s / 2147483648) || 1e-9;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = s / 2147483648;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    px *= Math.exp(z * dailyVol);
    out.push(px);
  }
  return out;
}

describe("logReturns", () => {
  it("computes log returns and drops non-positive prices", () => {
    const r = logReturns([100, 110]);
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(logReturns([100, 0, 100])).toHaveLength(0);
    expect(logReturns([100])).toHaveLength(0);
  });
});

describe("realizedVol", () => {
  it("recovers the volatility it was generated with", () => {
    const closes = walk(2000, 0.01);                  // 1%/day
    const v = realizedVol(logReturns(closes), 1500);
    const expected = 0.01 * Math.sqrt(252) * 100;     // ~15.9%
    expect(v).toBeGreaterThan(expected * 0.85);
    expect(v).toBeLessThan(expected * 1.15);
  });

  it("returns NaN — not 0 — when the window cannot be filled", () => {
    expect(realizedVol([0.01, 0.02], 30)).toBeNaN();
    expect(realizedVol([0.01, 0.02], 1)).toBeNaN();
  });

  it("scales with the annualisation factor", () => {
    const rets = logReturns(walk(400, 0.01));
    const daily = realizedVol(rets, 200, 252);
    const weekly = realizedVol(rets, 200, 52);
    expect(daily / weekly).toBeCloseTo(Math.sqrt(252 / 52), 6);
  });

  it("is zero for a perfectly flat series", () => {
    expect(realizedVol(logReturns(new Array(100).fill(100)), 50)).toBeCloseTo(0, 12);
  });
});

describe("rollingVol", () => {
  it("emits one observation per full window", () => {
    const rets = new Array(100).fill(0).map((_, i) => (i % 2 ? 0.01 : -0.01));
    expect(rollingVol(rets, 20)).toHaveLength(81);   // 100 - 20 + 1
    expect(rollingVol(rets, 100)).toHaveLength(1);
    expect(rollingVol(rets, 101)).toHaveLength(0);
  });

  it("its last value equals realizedVol over the same window", () => {
    const rets = logReturns(walk(300, 0.012));
    const roll = rollingVol(rets, 30);
    expect(roll.at(-1)).toBeCloseTo(realizedVol(rets, 30), 10);
  });
});

describe("percentile / percentileRank", () => {
  it("interpolates between samples", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
  });

  it("is order-independent and ignores non-finite values", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, NaN, 3], 50)).toBe(2);
  });

  it("ranks the max at ~100 and the min at ~0", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileRank(xs, 10)).toBeGreaterThan(90);
    expect(percentileRank(xs, 1)).toBeLessThan(10);
    expect(percentileRank(xs, 5.5)).toBeCloseTo(50, 5);
    expect(percentileRank([], 5)).toBeNaN();
  });
});

describe("volProfile", () => {
  const bars = mkBars(walk(700, 0.011));

  it("refuses a series too short to say anything about", () => {
    expect(volProfile(mkBars([100, 101, 102]))).toBeNull();
  });

  it("builds a cone with ordered percentile bands", () => {
    const p = volProfile(bars)!;
    expect(p).not.toBeNull();
    expect(p.points.length).toBeGreaterThan(3);
    for (const pt of p.points) {
      expect(pt.min).toBeLessThanOrEqual(pt.p5);
      expect(pt.p5).toBeLessThanOrEqual(pt.p25);
      expect(pt.p25).toBeLessThanOrEqual(pt.p50);
      expect(pt.p50).toBeLessThanOrEqual(pt.p75);
      expect(pt.p75).toBeLessThanOrEqual(pt.p95);
      expect(pt.p95).toBeLessThanOrEqual(pt.max);
      expect(pt.samples).toBeGreaterThanOrEqual(MIN_CONE_SAMPLES);
    }
  });

  it("SKIPS windows the history cannot support instead of faking them", () => {
    const short = mkBars(walk(120, 0.01));
    const p = volProfile(short)!;
    expect(p.skipped).toContain(252);
    expect(p.points.map((x) => x.window)).not.toContain(252);
    // and every window it did report is genuinely covered
    expect(p.points.length + p.skipped.length).toBe(CONE_WINDOWS.length);
  });

  it("the current reading is the last rolling observation, and its rank agrees", () => {
    const p = volProfile(bars)!;
    const rets = logReturns(bars.map((b) => b.close));
    for (const pt of p.points) {
      const roll = rollingVol(rets, pt.window, p.barsPerYear);
      expect(pt.current).toBeCloseTo(roll.at(-1)!, 10);
      expect(pt.rank).toBeCloseTo(percentileRank(roll, pt.current), 6);
    }
  });

  it("infers ~52 bars/year for WEEKLY history rather than assuming 252", () => {
    const weekly: VolBar[] = walk(300, 0.02).map((c, i) => ({
      date: new Date(Date.UTC(2018, 0, 1 + i * 7)).toISOString().slice(0, 10),
      close: c,
    }));
    const p = volProfile(weekly)!;
    expect(p.barsPerYear).toBeGreaterThan(45);
    expect(p.barsPerYear).toBeLessThan(60);

    const daily = volProfile(mkBars(walk(300, 0.02)))!;
    expect(daily.barsPerYear).toBeGreaterThan(200);
  });

  it("reports a calm name as lower vol than a wild one at every window", () => {
    const calm = volProfile(mkBars(walk(600, 0.004, 7)))!;
    const wild = volProfile(mkBars(walk(600, 0.025, 7)))!;
    for (let i = 0; i < calm.points.length; i++) {
      expect(wild.points[i].p50).toBeGreaterThan(calm.points[i].p50);
    }
  });
});

describe("termShape", () => {
  it("calls a big short-over-long spread backwardation", () => {
    // Calm for a year, then a violent last month: short windows spike.
    const closes = [...walk(500, 0.004, 3), ...walk(40, 0.05, 9).map((c) => c * 1)];
    const p = volProfile(mkBars(closes))!;
    const t = termShape(p);
    expect(t.shortVol).toBeGreaterThan(t.longVol);
    expect(t.label).toBe("backwardation");
  });

  it("calls a near-equal term structure flat", () => {
    const p = volProfile(mkBars(walk(800, 0.01, 11)))!;
    const t = termShape(p);
    if (Math.abs(t.spread) < 2) expect(t.label).toBe("flat");
    expect(t.spread).toBeCloseTo(t.shortVol - t.longVol, 12);
  });
});

describe("labels and expected move", () => {
  it("maps ranks to plain English without claiming to know an unknown", () => {
    expect(rankLabel(95)).toBe("extreme");
    expect(rankLabel(80)).toBe("elevated");
    expect(rankLabel(50)).toBe("normal");
    expect(rankLabel(15)).toBe("subdued");
    expect(rankLabel(2)).toBe("very low");
    expect(rankLabel(NaN)).toBe("unknown");
  });

  it("scales the 1-sigma move with the square root of time", () => {
    const one = expectedMove(100, 20, 1);
    const four = expectedMove(100, 20, 4);
    expect(four / one).toBeCloseTo(2, 10);
    expect(expectedMove(100, 20, 252)).toBeCloseTo(20, 10);   // 1 year => 20%
    expect(expectedMove(NaN, 20, 5)).toBeNaN();
    expect(expectedMove(100, 20, 0)).toBeNaN();
  });
});
