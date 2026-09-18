/** INV-01 and INV-12: risk ratios and trade counts.
 *
 *  These live in vitest rather than pytest because the metrics they guard are
 *  computed in TypeScript. The Python suite in tests/invariants/ covers the
 *  backend-computed rules; together they are the invariant suite the hardening
 *  brief asks for. Splitting by language rather than by concern is not ideal,
 *  but the alternative — asserting on numbers the frontend recomputes anyway —
 *  would test a copy instead of the thing that ships.
 *
 *  INV-01: Sortino >= Sharpe whenever downside deviation is non-zero.
 *
 *  This is arithmetic, not a heuristic. Both ratios divide the same annualised
 *  excess return; Sharpe divides by the deviation of ALL returns, Sortino by the
 *  deviation of the downside only. Measured over the same sample, the downside
 *  half cannot disperse more than the whole, so the Sortino denominator is the
 *  smaller one and the ratio is the larger. Sortino < Sharpe means the
 *  denominator is not what it claims to be.
 *
 *  The codebase contains both the right and the wrong implementation:
 *
 *    riskMetrics.ts   sqrt( sum(negative excess^2) / N )   <- N is the FULL sample
 *    backtest.ts      stdev( returns.filter(r => r < 0) )  <- subset's own stdev
 *
 *  The second measures how much the losses differ FROM EACH OTHER, which is a
 *  different quantity entirely and is unbounded relative to total volatility.
 *  With a few losses of unequal size it exceeds total sigma and Sortino drops
 *  below Sharpe — the audit's observed 0.61 against 0.77 (defect #23).
 */

import { describe, expect, it } from "vitest";

import { riskReport } from "../riskMetrics";

/** The correct downside deviation: RMS of shortfalls below the target,
 *  measured over the whole sample. */
function downsideDeviation(returns: number[], mar = 0): number {
  const shortfalls = returns.map((r) => Math.min(r - mar, 0));
  const sumSq = shortfalls.reduce((a, s) => a + s * s, 0);
  return Math.sqrt(sumSq / returns.length);
}

/** Population standard deviation — what backtest.ts's `stdev` does. */
function stdev(xs: number[]): number {
  if (!xs.length) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/** A series with few but unequal losses — the shape that breaks the wrong
 *  formula. Mostly small gains, three losses of very different size. */
const UNEQUAL_LOSSES = [
  0.004, 0.003, 0.005, 0.002, 0.004, 0.003, 0.006, 0.002, 0.004, 0.003,
  -0.002, 0.004, 0.003, 0.005, -0.045, 0.002, 0.004, 0.003, -0.011, 0.004,
  0.003, 0.005, 0.002, 0.004, 0.003, 0.006, 0.002, 0.004, 0.003, 0.005,
];

describe("INV-01 — Sortino >= Sharpe", () => {
  it("holds for the shared risk engine", () => {
    const m = riskReport(UNEQUAL_LOSSES, 252, 0);
    expect(m.sharpe).not.toBeNull();
    expect(m.sortino).not.toBeNull();
    expect(m.sortino!).toBeGreaterThanOrEqual(m.sharpe!);
  });

  it("holds across a range of series shapes", () => {
    // Deterministic pseudo-series: no Math.random, so a failure is reproducible.
    for (let seed = 1; seed <= 12; seed++) {
      const xs = Array.from({ length: 200 }, (_, i) =>
        (Math.sin(i * seed * 0.7) * 0.02) + 0.0008);
      const m = riskReport(xs, 252, 0);
      if (m.sharpe == null || m.sortino == null) continue;
      expect(m.sortino, `seed ${seed}`).toBeGreaterThanOrEqual(m.sharpe - 1e-9);
    }
  });

  it("pins WHY the backtest formula can invert the ratio", () => {
    // Not a test of production code — a demonstration that the two denominators
    // are different quantities, so the fix is "use the other one", not "clamp".
    const correct = downsideDeviation(UNEQUAL_LOSSES);
    const asBacktestDoesIt = stdev(UNEQUAL_LOSSES.filter((r) => r < 0));
    const totalSigma = stdev(UNEQUAL_LOSSES);

    expect(correct).toBeLessThanOrEqual(totalSigma);        // always true
    expect(asBacktestDoesIt).toBeGreaterThan(correct);      // the bug
    // And here is the impossible outcome it produces:
    expect(asBacktestDoesIt).toBeGreaterThan(totalSigma);
  });
});

describe("INV-01 — the backtest engine specifically", () => {
  it.fails(
    "backtest stats must not report Sortino below Sharpe (defect #23)",
    async () => {
      // it.fails = vitest's strict xfail: this flips to a suite FAILURE the
      // moment the defect is fixed, forcing the marker to be removed.
      const { runBacktest } = await import("../backtest");
      const bars = [] as { date: string; close: number }[];
      let px = 100;
      for (let i = 0; i < 300; i++) {
        px *= 1 + UNEQUAL_LOSSES[i % UNEQUAL_LOSSES.length];
        bars.push({
          date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
          close: px,
        });
      }
      // A fast/slow pair that stays invested almost throughout, so the daily
      // return series the ratios are computed from is the price series itself.
      const res = runBacktest(bars, {
        strategy: "sma_cross", params: { fast: 2, slow: 5 }, costBps: 0,
      });
      const s = res?.stats;
      if (!s || s.sharpe == null || s.sortino == null) {
        throw new Error("no stats produced — cannot evaluate the invariant");
      }
      expect(s.sortino).toBeGreaterThanOrEqual(s.sharpe);
    },
  );
});
