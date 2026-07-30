import { describe, expect, it } from "vitest";

import {
  alignReturns, betaFit, betaNote, isSignificant, matrix, matrixNote,
  MIN_OBSERVATIONS, pairs, pearson, readMatrix, REDUNDANT_R,
  significanceThreshold, WEAK_FIT, type Series,
} from "./correlation";

/** N consecutive weekdays as ISO dates, oldest first. */
function dates(n: number, startDay = 1): string[] {
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2026, 0, startDay + i)).toISOString().slice(0, 10));
}

const series = (ticker: string, closes: number[], startDay = 1): Series =>
  ({ ticker, dates: dates(closes.length, startDay), closes });

/** A price path from a list of daily returns. */
const path = (rets: number[], base = 100) => {
  const out = [base];
  for (const r of rets) out.push(out[out.length - 1] * (1 + r));
  return out;
};

const wave = (n: number, amp = 0.01, phase = 0) =>
  Array.from({ length: n }, (_, i) => amp * Math.sin((i + phase) / 3));

describe("alignReturns", () => {
  it("intersects on shared dates and differences to returns", () => {
    const a = alignReturns([
      series("A", [100, 110, 121]), series("B", [50, 55, 60.5])]);
    expect(a.shared).toBe(2);
    expect(a.returns[0][0]).toBeCloseTo(0.1, 8);
    expect(a.returns[1][0]).toBeCloseTo(0.1, 8);
  });

  it("REPORTS what the intersection cost, and who caused it", () => {
    // Adding one short-history ticker silently truncates every pair in the
    // grid — the number is valid and describes a window the reader didn't ask
    // for, and nothing used to say so.
    const a = alignReturns([
      series("LONG", Array(250).fill(0).map((_, i) => 100 + i)),
      series("LONG2", Array(250).fill(0).map((_, i) => 100 + i)),
      series("SHORT", Array(40).fill(0).map((_, i) => 100 + i), 211),
    ]);
    expect(a.longest).toBe(249);
    expect(a.shared).toBeLessThan(60);
    expect(a.limitedBy).toBe("SHORT");
  });

  it("names no limiter when every series is the same length", () => {
    expect(alignReturns([series("A", [1, 2, 3]), series("B", [4, 5, 6])]).limitedBy)
      .toBeNull();
  });

  it("does not let a zero close produce an infinite return", () => {
    const a = alignReturns([series("A", [100, 0, 100]), series("B", [1, 2, 3])]);
    expect(a.returns[0].every(Number.isFinite)).toBe(true);
  });

  it("handles fewer than two usable series", () => {
    expect(alignReturns([]).returns).toEqual([]);
    expect(alignReturns([series("A", [1, 2])]).returns).toEqual([]);
  });
});

describe("pearson", () => {
  const n = 60;
  it("is 1 for a series against itself and -1 against its negation", () => {
    const r = wave(n);
    expect(pearson(r, r)!).toBeCloseTo(1, 8);
    expect(pearson(r, r.map((x) => -x))!).toBeCloseTo(-1, 8);
  });

  it("REFUSES below the minimum sample rather than returning noise", () => {
    const short = wave(MIN_OBSERVATIONS - 1);
    expect(pearson(short, short)).toBeNull();
  });

  it("returns null, not NaN, when a series never moves", () => {
    expect(pearson(wave(n), Array(n).fill(0))).toBeNull();
  });

  it("stays inside [-1, 1] despite floating point", () => {
    const r = wave(n);
    expect(Math.abs(pearson(r, r.map((x) => x * 3))!)).toBeLessThanOrEqual(1);
  });
});

describe("significanceThreshold / isSignificant", () => {
  it("shrinks as the sample grows", () => {
    expect(significanceThreshold(60)!).toBeGreaterThan(significanceThreshold(250)!);
  });

  it("puts a small correlation on 60 days below the bar", () => {
    // 0.18 on sixty observations is not distinguishable from zero, and the old
    // grid presented it as a finding.
    expect(isSignificant(0.18, 60)).toBe(false);
    expect(isSignificant(0.62, 60)).toBe(true);
  });

  it("treats a negative correlation by magnitude", () => {
    expect(isSignificant(-0.62, 60)).toBe(true);
    expect(isSignificant(-0.05, 60)).toBe(false);
  });

  it("is null for a sample too small to have one", () => {
    expect(significanceThreshold(2)).toBeNull();
    expect(isSignificant(0.99, 2)).toBe(false);
  });
});

describe("matrix", () => {
  const n = 80;
  const base = wave(n);
  const build = () => matrix(alignReturns([
    series("A", path(base)),
    series("B", path(base.map((x) => x * 2))),          // perfectly correlated
    series("C", path(base.map((x) => -x))),             // perfectly inverse
  ]));

  it("has ones down the diagonal and is symmetric", () => {
    const m = build();
    for (let i = 0; i < m.tickers.length; i++) {
      expect(m.values[i][i]).toBe(1);
      for (let j = 0; j < m.tickers.length; j++) {
        expect(m.values[i][j]).toBeCloseTo(m.values[j][i]!, 10);
      }
    }
  });

  it("finds the correlations the construction implies", () => {
    const m = build();
    expect(m.values[0][1]!).toBeCloseTo(1, 6);
    expect(m.values[0][2]!).toBeCloseTo(-1, 6);
  });

  it("carries the sample size and its significance bar", () => {
    const m = build();
    expect(m.n).toBeGreaterThan(MIN_OBSERVATIONS);
    expect(m.threshold).toBeCloseTo(significanceThreshold(m.n)!, 10);
  });
});

describe("pairs / readMatrix", () => {
  const n = 120;
  const base = wave(n);
  const m = matrix(alignReturns([
    series("A", path(base)),
    series("B", path(base.map((x) => x * 1.02))),   // ~1.0 with A
    series("C", path(wave(n, 0.01, 40))),           // out of phase
  ]));

  it("lists every off-diagonal pair once, strongest first", () => {
    const ps = pairs(m);
    expect(ps).toHaveLength(3);            // 3 choose 2
    expect(ps[0].r).toBeGreaterThanOrEqual(ps[ps.length - 1].r);
    // Never a self-pair.
    expect(ps.every((p) => p.a !== p.b)).toBe(true);
  });

  it("flags a pair that is one trade wearing two tickers", () => {
    const r = readMatrix(m);
    expect(r.redundant.map((p) => [p.a, p.b].sort().join("/"))).toContain("A/B");
    expect(r.redundant.every((p) => p.r >= REDUNDANT_R)).toBe(true);
  });

  it("counts INDEPENDENT bets, not tickers", () => {
    // Ten names at an average correlation of 0.8 behave like about 1.2
    // positions. A reader counting tickers thinks they hold ten.
    const same = wave(200);
    const ten = matrix(alignReturns(
      Array.from({ length: 10 }, (_, i) =>
        series(`T${i}`, path(same.map((x) => x * (1 + i * 0.001)))))));
    const r = readMatrix(ten);
    expect(r.count).toBe(10);
    expect(r.effectiveBets!).toBeLessThan(2);
  });

  it("reports effective bets near N when nothing is correlated", () => {
    const independent = matrix(alignReturns(
      Array.from({ length: 4 }, (_, i) =>
        series(`T${i}`, path(Array.from({ length: 150 },
          (_, k) => 0.01 * Math.sin(k * (i + 1) * 1.7)))))));
    const r = readMatrix(independent);
    expect(r.effectiveBets!).toBeGreaterThan(2);
  });

  it("names the most and least correlated pairs", () => {
    const r = readMatrix(m);
    expect(r.mostCorrelated!.r).toBeGreaterThanOrEqual(r.leastCorrelated!.r);
  });

  it("returns nothing measurable from a single ticker", () => {
    const r = readMatrix({ tickers: ["A"], values: [[1]], n: 100, threshold: 0.2 });
    expect(r.averageR).toBeNull();
    expect(r.effectiveBets).toBeNull();
  });
});

describe("matrixNote", () => {
  const n = 150;
  const base = wave(n);
  const a = alignReturns([
    series("A", path(base)), series("B", path(base.map((x) => x * 1.01)))]);
  const m = matrix(a);

  it("states the shared window the numbers came from", () => {
    expect(matrixNote(m, readMatrix(m), a)).toMatch(new RegExp(`${m.n} trading days ALL`));
  });

  it("names the ticker truncating everything else", () => {
    const short = alignReturns([
      series("LONG", path(wave(250))),
      series("LONG2", path(wave(250))),
      series("SHORT", path(wave(40)), 200),
    ]);
    const note = matrixNote(matrix(short), readMatrix(matrix(short)), short);
    expect(note).toMatch(/SHORT has the shortest history and truncates every pair/);
  });

  it("states the level below which a cell is indistinguishable from zero", () => {
    expect(matrixNote(m, readMatrix(m), a))
      .toMatch(/not distinguishable from zero/);
  });

  it("says counting tickers overstates diversification", () => {
    const note = matrixNote(m, readMatrix(m), a);
    expect(note).toMatch(/independent positions/);
    expect(note).toMatch(/counting tickers overstates diversification/);
  });

  it("warns that correlations converge in a selloff", () => {
    expect(matrixNote(m, readMatrix(m), a))
      .toMatch(/converge towards 1 in a selloff/);
  });

  it("REFUSES the whole grid when the shared window is too short", () => {
    const tiny = alignReturns([
      series("A", path(wave(10))), series("B", path(wave(10)))]);
    const note = matrixNote(matrix(tiny), readMatrix(matrix(tiny)), tiny);
    expect(note).toMatch(/would be noise, so they are not computed/);
  });
});

describe("betaFit", () => {
  const n = 200;
  const bench = wave(n);

  it("recovers the slope it was built with", () => {
    const asset = bench.map((x) => x * 1.5);
    const f = betaFit("A", asset, bench);
    expect(f.beta!).toBeCloseTo(1.5, 6);
    expect(f.rSquared!).toBeCloseTo(1, 6);
  });

  it("reports a LOW R² when the benchmark explains nothing", () => {
    // The failure this catches: a beta of 1.8 explaining 4% of the variance is
    // an artefact, and without R² it looks like a beta explaining 80%.
    const noise = Array.from({ length: n }, (_, i) => 0.01 * Math.sin(i * 2.399));
    const f = betaFit("NOISE", noise, bench);
    expect(f.rSquared!).toBeLessThan(WEAK_FIT);
  });

  it("separates the intercept from the slope", () => {
    const asset = bench.map((x) => x * 1.2 + 0.001);   // 0.1%/day of alpha
    expect(betaFit("A", asset, bench).alphaPct!).toBeCloseTo(0.1, 4);
  });

  it("refuses below the minimum sample", () => {
    const f = betaFit("A", wave(10), wave(10));
    expect(f.beta).toBeNull();
    expect(f.n).toBe(10);
  });

  it("refuses when the benchmark never moved", () => {
    expect(betaFit("A", wave(n), Array(n).fill(0)).beta).toBeNull();
  });

  it("gives a negative beta for an inverse asset", () => {
    expect(betaFit("A", bench.map((x) => -x), bench).beta!).toBeCloseTo(-1, 6);
  });
});

describe("betaNote", () => {
  const n = 200;
  const bench = wave(n);
  const good = betaFit("GOOD", bench.map((x) => x * 1.2), bench);
  const weak = betaFit("WEAK",
    Array.from({ length: n }, (_, i) => 0.01 * Math.sin(i * 2.399)), bench);

  it("explains why R² is shown next to beta", () => {
    const note = betaNote([good], "^NSEI");
    expect(note).toMatch(/an artefact of the regression, not a sensitivity/);
  });

  it("names the tickers whose beta means little", () => {
    const note = betaNote([good, weak], "^NSEI");
    expect(note).toMatch(/WEAK/);
    expect(note).toMatch(new RegExp(`R² under ${WEAK_FIT}`));
  });

  it("says nothing about weak fits when there aren't any", () => {
    expect(betaNote([good], "^NSEI")).not.toMatch(/R² under/);
  });

  it("explains the difference from the provider beta elsewhere in the app", () => {
    const note = betaNote([good], "^NSEI");
    expect(note).toMatch(/five years of monthly returns/);
    expect(note).toMatch(/neither is more correct/);
  });

  it("says so when nothing can be regressed", () => {
    expect(betaNote([betaFit("A", [], [])], "^NSEI"))
      .toMatch(/No series has enough overlap/);
  });
});
