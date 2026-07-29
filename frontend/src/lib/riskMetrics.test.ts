import { describe, expect, it } from "vitest";

import {
  describe as describeStats, drawdown, equityCurve, histogram, MIN_OBS,
  percentile, relativeReport, riskReport, rollingVol, stdev,
} from "./riskMetrics";

/** Deterministic returns — no Math.random, so nothing can flake. */
function series(n: number, mu: number, sigma: number, seed = 1): number[] {
  let s = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s / 2147483648) || 1e-9;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = s / 2147483648;
    out.push(mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  return out;
}

const flat = new Array(60).fill(0);

describe("stdev / describe", () => {
  it("computes the SAMPLE standard deviation", () => {
    // sd of [2,4,4,4,5,5,7,9] with n-1 is ~2.1381
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])!).toBeCloseTo(2.13809, 4);
  });

  it("needs two points", () => {
    expect(stdev([1])).toBeNull();
    expect(stdev([])).toBeNull();
  });

  it("reports EXCESS kurtosis — 0 for a normal-ish sample", () => {
    const s = describeStats(series(4000, 0, 0.01));
    expect(s.kurtosis!).toBeGreaterThan(-0.4);
    expect(s.kurtosis!).toBeLessThan(0.4);
    expect(Math.abs(s.skew!)).toBeLessThan(0.25);
  });

  it("detects a fat left tail as negative skew and positive excess kurtosis", () => {
    const s = describeStats([...new Array(200).fill(0.001), -0.25]);
    expect(s.skew!).toBeLessThan(0);
    expect(s.kurtosis!).toBeGreaterThan(3);
  });

  it("withholds shape stats on a tiny sample rather than reporting noise", () => {
    const s = describeStats([0.01, -0.02, 0.03]);
    expect(s.skew).toBeNull();
    expect(s.kurtosis).toBeNull();
    expect(s.n).toBe(3);
  });

  it("withholds shape stats when there is no variance", () => {
    expect(describeStats(flat).skew).toBeNull();
  });

  it("survives an empty input", () => {
    expect(describeStats([])).toEqual({
      n: 0, mean: null, stdev: null, skew: null, kurtosis: null,
    });
  });
});

describe("equityCurve / drawdown", () => {
  it("compounds returns", () => {
    expect(equityCurve([0.1, 0.1]).at(-1)!).toBeCloseTo(1.21, 10);
  });

  it("measures the deepest peak-to-trough fall", () => {
    // 1 -> 1.5 -> 0.75 is a 50% drawdown from the peak.
    const d = drawdown([0.5, -0.5]);
    expect(d.maxPct).toBeCloseTo(-50, 8);
  });

  it("is zero for a series that only rises", () => {
    expect(drawdown([0.01, 0.01, 0.01]).maxPct).toBe(0);
  });

  it("counts the LONGEST underwater run, not the last one", () => {
    // down 3, recover above the peak, then down 1.
    const d = drawdown([-0.1, -0.1, -0.1, 1.0, -0.05]);
    expect(d.periods).toBe(3);
  });
});

describe("percentile", () => {
  it("interpolates", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });
  it("handles degenerate input", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("riskReport", () => {
  const r = series(1000, 0.0004, 0.011);
  const rep = riskReport(r, 252);

  it("refuses a sample too small to describe", () => {
    const tiny = riskReport(series(MIN_OBS - 1, 0.001, 0.01), 252);
    expect(tiny.sharpe).toBeNull();
    expect(tiny.annVolPct).toBeNull();
    expect(tiny.n).toBe(MIN_OBS - 1);
  });

  it("recovers the volatility it was generated with", () => {
    const expected = 0.011 * Math.sqrt(252) * 100;   // ~17.5%
    expect(rep.annVolPct!).toBeGreaterThan(expected * 0.85);
    expect(rep.annVolPct!).toBeLessThan(expected * 1.15);
  });

  it("ANNUALISES with the periods-per-year it is given", () => {
    // The same series read as weekly must not report the daily figure.
    const daily = riskReport(r, 252).annVolPct!;
    const weekly = riskReport(r, 52).annVolPct!;
    expect(daily / weekly).toBeCloseTo(Math.sqrt(252 / 52), 6);
  });

  it("total return matches straight compounding", () => {
    const growth = r.reduce((a, x) => a * (1 + x), 1);
    expect(rep.totalPct!).toBeCloseTo((growth - 1) * 100, 6);
  });

  it("converts the risk-free rate to a PERIOD rate before subtracting", () => {
    // Subtracting an annual 6% from each daily return would drive Sharpe
    // hugely negative; the correct conversion barely moves it.
    const withRf = riskReport(r, 252, 0.06);
    expect(withRf.sharpe!).toBeLessThan(rep.sharpe!);
    expect(withRf.sharpe!).toBeGreaterThan(rep.sharpe! - 1.5);
  });

  it("Sortino exceeds Sharpe when the downside is milder than total vol", () => {
    const mild = [...new Array(200).fill(0.002), ...new Array(50).fill(-0.001)];
    const m = riskReport(mild, 252);
    expect(m.sortino!).toBeGreaterThan(m.sharpe!);
  });

  it("VaR is a loss and CVaR is at least as bad", () => {
    expect(rep.var95Pct!).toBeLessThan(0);
    expect(rep.cvar95Pct!).toBeLessThanOrEqual(rep.var95Pct!);
  });

  it("hit rate, best and worst agree with the raw series", () => {
    expect(rep.hitRatePct!).toBeCloseTo(
      (r.filter((x) => x > 0).length / r.length) * 100, 8);
    expect(rep.bestPct!).toBeCloseTo(Math.max(...r) * 100, 8);
    expect(rep.worstPct!).toBeCloseTo(Math.min(...r) * 100, 8);
  });

  it("returns nulls instead of NaN for a flat series", () => {
    const f = riskReport(flat, 252);
    expect(f.annVolPct).toBe(0);
    expect(f.sharpe).toBeNull();     // no volatility to divide by
    expect(f.sortino).toBeNull();    // no downside at all
    expect(f.calmar).toBeNull();     // no drawdown
    expect(f.maxDdPct).toBe(0);
  });

  it("never emits NaN or Infinity on any of these shapes", () => {
    const shapes = [
      series(300, 0.001, 0.02), flat,
      new Array(60).fill(-0.01),
      new Array(60).fill(0.01),
      [...new Array(59).fill(0), -0.9],
    ];
    for (const s of shapes) {
      for (const [k, v] of Object.entries(riskReport(s, 252))) {
        if (typeof v === "number") {
          expect(Number.isFinite(v), `${k} = ${v}`).toBe(true);
        }
      }
    }
  });

  it("guards a nonsense periods-per-year", () => {
    expect(riskReport(series(100, 0.001, 0.01), 0).sharpe).toBeNull();
  });
});

describe("relativeReport", () => {
  const bench = series(600, 0.0004, 0.01, 5);

  it("recovers an exact beta with R2 of 1 on a noiseless multiple", () => {
    const asset = bench.map((r) => r * 1.4);
    const rel = relativeReport(asset, bench, 252);
    expect(rel.beta!).toBeCloseTo(1.4, 10);
    expect(rel.r2!).toBeCloseTo(1, 10);
  });

  it("a pure multiple has near-zero alpha", () => {
    const rel = relativeReport(bench.map((r) => r * 1.4), bench, 252);
    expect(Math.abs(rel.alphaPct!)).toBeLessThan(1e-6);
  });

  it("detects added alpha", () => {
    const asset = bench.map((r) => r + 0.0004);   // constant edge each period
    const rel = relativeReport(asset, bench, 252);
    expect(rel.beta!).toBeCloseTo(1, 10);
    expect(rel.alphaPct!).toBeCloseTo(0.0004 * 252 * 100, 6);
  });

  it("tracking a benchmark exactly gives zero tracking error", () => {
    const rel = relativeReport([...bench], bench, 252);
    expect(rel.trackingErrorPct!).toBeCloseTo(0, 10);
    expect(rel.informationRatio).toBeNull();   // 0/0 is not a ratio
  });

  it("up and down capture are 100% for an exact tracker", () => {
    const rel = relativeReport([...bench], bench, 252);
    expect(rel.upCapturePct!).toBeCloseTo(100, 8);
    expect(rel.downCapturePct!).toBeCloseTo(100, 8);
  });

  it("a defensive asset captures less of the downside", () => {
    const asset = bench.map((r) => (r < 0 ? r * 0.5 : r));
    const rel = relativeReport(asset, bench, 252);
    expect(rel.downCapturePct!).toBeCloseTo(50, 6);
    expect(rel.upCapturePct!).toBeCloseTo(100, 6);
  });

  it("refuses too small a sample and a zero-variance benchmark", () => {
    expect(relativeReport(series(5, 0, 0.01), series(5, 0, 0.01), 252).beta).toBeNull();
    expect(relativeReport(series(60, 0, 0.01), new Array(60).fill(0), 252).beta).toBeNull();
  });
});

describe("histogram", () => {
  it("bins every observation exactly once", () => {
    const r = series(500, 0, 0.02);
    const h = histogram(r, 20);
    expect(h).toHaveLength(20);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(r.length);
  });

  it("puts the maximum inside the LAST bin rather than off the end", () => {
    const h = histogram([0, 1, 2, 3, 4], 4);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(5);
    expect(h.at(-1)!.count).toBeGreaterThan(0);
  });

  it("returns nothing when there is no spread to bin", () => {
    expect(histogram(flat, 10)).toEqual([]);
    expect(histogram([0.01], 10)).toEqual([]);
  });
});

describe("rollingVol", () => {
  it("is null until the window fills, then matches a direct computation", () => {
    const r = series(120, 0, 0.01);
    const rv = rollingVol(r, 30, 252);
    expect(rv.slice(0, 29).every((v) => v == null)).toBe(true);
    const direct = stdev(r.slice(-30))! * Math.sqrt(252) * 100;
    expect(rv.at(-1)!).toBeCloseTo(direct, 8);
  });

  it("is aligned to the input length", () => {
    expect(rollingVol(series(50, 0, 0.01), 10, 252)).toHaveLength(50);
  });
});
