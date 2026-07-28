import { describe, expect, it } from "vitest";

import {
  alignedReturns, applyShock, estimateBeta, findWorstWindows, replayWindow,
  WEAK_R2, windowReturn, type Series, type SeriesMap,
} from "./stress";

const day = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
const mk = (closes: number[], offset = 0): Series => ({
  dates: closes.map((_, i) => day(i + offset)), closes,
});

describe("windowReturn", () => {
  const s = mk([100, 110, 121, 133.1]);
  it("measures first-to-last close inside the window", () => {
    expect(windowReturn(s, day(0), day(3))!).toBeCloseTo(0.331, 6);
    expect(windowReturn(s, day(1), day(2))!).toBeCloseTo(0.1, 6);
  });
  it("returns null when the window isn't covered", () => {
    expect(windowReturn(s, day(50), day(60))).toBeNull();
    expect(windowReturn(s, day(2), day(2))).toBeNull();   // needs two points
  });
  it("returns null on non-positive prices rather than an infinity", () => {
    expect(windowReturn(mk([0, 100]), day(0), day(1))).toBeNull();
  });
});

describe("findWorstWindows", () => {
  // A calm stretch, one deep crash, a recovery, then a second smaller dip.
  const closes = [
    ...Array.from({ length: 40 }, () => 100),
    ...Array.from({ length: 10 }, (_, i) => 100 - i * 5),      // -50%: the crash
    ...Array.from({ length: 40 }, (_, i) => 50 + i * 1.5),
    ...Array.from({ length: 10 }, (_, i) => 110 - i * 1.5),    // milder dip
    ...Array.from({ length: 30 }, () => 95),
  ];
  const bench = mk(closes);

  it("finds the deepest stretch first", () => {
    const w = findWorstWindows(bench, 10, 3);
    expect(w.length).toBeGreaterThan(0);
    expect(w[0].benchRet).toBeLessThan(-0.3);
    expect(w[0].bars).toBe(10);
  });

  it("returns DISTINCT crashes, not the same one shifted by a day", () => {
    const w = findWorstWindows(bench, 10, 3);
    const idx = w.map((x) => bench.dates.indexOf(x.from));
    for (let i = 0; i < idx.length; i++) {
      for (let j = i + 1; j < idx.length; j++) {
        expect(Math.abs(idx[i] - idx[j])).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("is sorted worst-first", () => {
    const w = findWorstWindows(bench, 10, 3);
    for (let i = 1; i < w.length; i++) {
      expect(w[i].benchRet).toBeGreaterThanOrEqual(w[i - 1].benchRet);
    }
  });

  it("returns nothing when the history is shorter than the window", () => {
    expect(findWorstWindows(mk([1, 2, 3]), 30)).toEqual([]);
  });
});

describe("replayWindow", () => {
  const w = { from: day(0), to: day(2), benchRet: -0.2, bars: 2, label: "test" };
  const series: SeriesMap = {
    "A.NS": mk([100, 90, 80]),        // -20%
    "B.NS": mk([100, 100, 110]),      // +10%
  };
  const positions = [
    { ticker: "A.NS", value: 6000 },
    { ticker: "B.NS", value: 4000 },
  ];

  it("weights each leg by its current value", () => {
    const r = replayWindow(positions, series, w);
    expect(r.legs.find((l) => l.ticker === "A.NS")!.pnl).toBeCloseTo(-1200, 6);
    expect(r.legs.find((l) => l.ticker === "B.NS")!.pnl).toBeCloseTo(400, 6);
    expect(r.pnl).toBeCloseTo(-800, 6);
    expect(r.portfolioRet).toBeCloseTo(-0.08, 6);
    expect(r.coveragePct).toBe(100);
  });

  it("EXCLUDES a holding with no history instead of assuming it was flat", () => {
    const r = replayWindow([...positions, { ticker: "NOHIST", value: 10000 }], series, w);
    const leg = r.legs.find((l) => l.ticker === "NOHIST")!;
    expect(leg.unmodelled).toBe(true);
    expect(leg.ret).toBeNull();
    expect(leg.pnl).toBeNull();
    // The loss is still -8% of the MODELLED slice, not diluted to -4% of the
    // total by pretending the unknown half held its value.
    expect(r.portfolioRet).toBeCloseTo(-0.08, 6);
    expect(r.modelledValue).toBe(10000);
    expect(r.totalValue).toBe(20000);
    expect(r.coveragePct).toBe(50);
  });

  it("names the worst and best legs", () => {
    const r = replayWindow(positions, series, w);
    expect(r.worst!.ticker).toBe("A.NS");
    expect(r.best!.ticker).toBe("B.NS");
  });

  it("survives a portfolio it can model nothing of", () => {
    const r = replayWindow([{ ticker: "X", value: 100 }], {}, w);
    expect(r.coveragePct).toBe(0);
    expect(r.portfolioRet).toBe(0);
    expect(r.worst).toBeNull();
  });

  it("survives zero-value positions without dividing by zero", () => {
    const r = replayWindow([{ ticker: "A.NS", value: 0 }], series, w);
    expect(Number.isFinite(r.portfolioRet)).toBe(true);
    expect(r.coveragePct).toBe(0);
  });
});

describe("estimateBeta", () => {
  const bench = Array.from({ length: 200 }, (_, i) => Math.sin(i / 3) * 0.01);

  it("recovers an exact beta with R² of 1 on a noiseless multiple", () => {
    const asset = bench.map((r) => r * 1.5);
    const fit = estimateBeta(asset, bench)!;
    expect(fit.beta).toBeCloseTo(1.5, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.n).toBe(200);
  });

  it("reports a LOW R² when the holding barely tracks the benchmark", () => {
    // Deterministic, benchmark-independent wiggle.
    const asset = bench.map((_, i) => Math.cos(i * 1.7) * 0.02);
    const fit = estimateBeta(asset, bench)!;
    expect(fit.r2).toBeLessThan(WEAK_R2);
  });

  it("refuses to fit too few points", () => {
    expect(estimateBeta([0.01, 0.02], [0.01, 0.02])).toBeNull();
  });

  it("refuses a benchmark with no variance rather than dividing by zero", () => {
    const flat = new Array(100).fill(0);
    expect(estimateBeta(bench.slice(0, 100), flat)).toBeNull();
    expect(estimateBeta(flat, bench.slice(0, 100))).toBeNull();
  });
});

describe("alignedReturns", () => {
  it("only uses dates both series have", () => {
    const a: Series = { dates: [day(0), day(1), day(2), day(3)], closes: [100, 110, 121, 133.1] };
    const b: Series = { dates: [day(0), day(2), day(3)], closes: [50, 55, 60.5] };
    const { a: ra, b: rb } = alignedReturns(a, b);
    expect(ra).toHaveLength(rb.length);
    expect(ra).toHaveLength(2);            // 0->2 and 2->3
    expect(ra[0]).toBeCloseTo(0.21, 10);   // 100 -> 121, the gap is skipped
    expect(rb[0]).toBeCloseTo(0.1, 10);
  });

  it("returns nothing when the series never overlap", () => {
    const { a } = alignedReturns(mk([1, 2, 3]), mk([1, 2, 3], 500));
    expect(a).toHaveLength(0);
  });
});

describe("applyShock", () => {
  const fits = {
    "A.NS": { beta: 1.5, r2: 0.7, n: 250 },
    "B.NS": { beta: 0.4, r2: 0.05, n: 250 },
    "C.NS": null,
  };
  const positions = [
    { ticker: "A.NS", value: 5000 },
    { ticker: "B.NS", value: 5000 },
    { ticker: "C.NS", value: 5000 },
  ];

  it("pushes the shock through each beta and value-weights the result", () => {
    const r = applyShock(positions, fits, -10);
    expect(r.legs[0].ret).toBeCloseTo(-0.15, 10);
    expect(r.legs[1].ret).toBeCloseTo(-0.04, 10);
    expect(r.pnl).toBeCloseTo(-950, 6);
    expect(r.portfolioRet).toBeCloseTo(-0.095, 10);
    expect(r.portfolioBeta).toBeCloseTo(0.95, 10);
  });

  it("excludes an unfittable holding and reports the coverage gap", () => {
    const r = applyShock(positions, fits, -10);
    expect(r.legs[2].unmodelled).toBe(true);
    expect(r.legs[2].pnl).toBeNull();
    expect(r.modelledValue).toBe(10000);
    expect(r.totalValue).toBe(15000);
    expect(r.coveragePct).toBeCloseTo(66.67, 1);
  });

  it("FLAGS weak fits rather than quietly using them", () => {
    const r = applyShock(positions, fits, -10);
    expect(r.weakFits).toEqual(["B.NS"]);
  });

  it("is symmetric — an up shock mirrors the down one", () => {
    const down = applyShock(positions, fits, -10);
    const up = applyShock(positions, fits, 10);
    expect(up.pnl).toBeCloseTo(-down.pnl, 6);
  });

  it("handles an entirely unmodellable portfolio", () => {
    const r = applyShock([{ ticker: "C.NS", value: 100 }], fits, -20);
    expect(r.coveragePct).toBe(0);
    expect(r.portfolioBeta).toBeNull();
    expect(r.portfolioRet).toBe(0);
  });
});
