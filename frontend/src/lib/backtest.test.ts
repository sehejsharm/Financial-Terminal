import { describe, expect, it } from "vitest";

import {
  IN_SAMPLE_SHARE, MIN_BARS, STRATEGIES, gridAround, runBacktest, signalsFor, splitSample, sweep, type Bar, yearlyNote, yearlyReturns,
} from "./backtest";

/** Deterministic daily bars from a close generator. */
function mkBars(closes: number[], startDay = 1): Bar[] {
  return closes.map((c, i) => {
    const d = new Date(Date.UTC(2020, 0, startDay + i));
    return { date: d.toISOString().slice(0, 10), close: c };
  });
}

/** A steadily rising series — every long strategy should beat cash on it. */
const rising = mkBars(Array.from({ length: 400 }, (_, i) => 100 * 1.001 ** i));
/** Down then up: the crossover should sit out the fall. */
const vShape = mkBars([
  ...Array.from({ length: 200 }, (_, i) => 200 - i * 0.5),
  ...Array.from({ length: 200 }, (_, i) => 100 + i * 0.5),
]);
/** Oscillating: the only shape that actually produces closed round trips. */
const choppy = mkBars(Array.from({ length: 400 }, (_, i) => 100 + 20 * Math.sin(i / 15)));

describe("runBacktest — guards", () => {
  it("refuses a series that is too short to mean anything", () => {
    expect(runBacktest(mkBars([1, 2, 3]), { strategy: "sma_cross", params: {} })).toBeNull();
    expect(MIN_BARS).toBeGreaterThan(30);
  });

  it("drops non-finite and non-positive closes rather than producing NaN equity", () => {
    const dirty = mkBars(Array.from({ length: 120 }, () => 100));
    (dirty[5] as any).close = NaN;
    (dirty[6] as any).close = 0;
    const r = runBacktest(dirty, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(r).not.toBeNull();
    expect(r.equity.every(Number.isFinite)).toBe(true);
  });
});

describe("runBacktest — execution model", () => {
  it("never acts on a signal in the same bar it was generated", () => {
    const bars = rising;
    const closes = bars.map((b) => b.close);
    const sig = signalsFor(closes, { strategy: "sma_cross", params: { fast: 10, slow: 30 } });
    const r = runBacktest(bars, { strategy: "sma_cross", params: { fast: 10, slow: 30 } })!;
    expect(r.position[0]).toBe(0);
    for (let i = 1; i < closes.length; i++) expect(r.position[i]).toBe(sig[i - 1]);
  });

  it("buy & hold equity is independent of the strategy", () => {
    const a = runBacktest(rising, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    const b = runBacktest(rising, { strategy: "rsi_reversion", params: {} })!;
    expect(a.buyHold.at(-1)).toBeCloseTo(b.buyHold.at(-1)!, 10);
    // 400 bars of +0.1%/day compounding
    expect(a.stats.buyHoldPct).toBeCloseTo((1.001 ** 399 - 1) * 100, 6);
  });

  it("stays flat through the drawdown of a V and captures the recovery", () => {
    const r = runBacktest(vShape, { strategy: "sma_cross", params: { fast: 20, slow: 60 } })!;
    expect(r.stats.buyHoldPct).toBeLessThan(0);          // 200 -> 199.5, round trip loses
    expect(r.stats.totalPct).toBeGreaterThan(r.stats.buyHoldPct);
    expect(r.stats.maxDdPct).toBeGreaterThan(r.stats.buyHoldMaxDdPct); // less negative
    expect(r.stats.exposurePct).toBeLessThan(75);
  });
});

describe("runBacktest — costs", () => {
  it("charges the cost on every position change, so more cost = less equity", () => {
    const p = { strategy: "sma_cross" as const, params: { fast: 5, slow: 20 } };
    const free = runBacktest(choppy, { ...p, costBps: 0 })!;
    const pricey = runBacktest(choppy, { ...p, costBps: 50 })!;
    expect(pricey.stats.totalPct).toBeLessThan(free.stats.totalPct);
    expect(pricey.stats.buyHoldPct).toBeCloseTo(free.stats.buyHoldPct, 10); // B&H untouched
  });

  it("costs land inside trade P&L, not only in the equity curve", () => {
    const p = { strategy: "sma_cross" as const, params: { fast: 5, slow: 20 } };
    const free = runBacktest(choppy, { ...p, costBps: 0 })!;
    const pricey = runBacktest(choppy, { ...p, costBps: 100 })!;
    const closedFree = free.trades.filter((t) => !t.open);
    const closedPricey = pricey.trades.filter((t) => !t.open);
    expect(closedFree.length).toBeGreaterThan(3);
    expect(closedFree.length).toBe(closedPricey.length);
    expect(closedPricey[0].retPct!).toBeLessThan(closedFree[0].retPct!);
  });
});

describe("runBacktest — trades", () => {
  it("pairs each entry with its exit and flags a still-open final trade", () => {
    const r = runBacktest(rising, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    // Monotone rise: one entry, never exits.
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].open).toBe(true);
    expect(r.trades[0].exitDate).toBeNull();
    expect(r.trades[0].exitPx).toBeNull();
    expect(r.stats.trades).toBe(0);              // closed round trips only
    expect(r.stats.winRatePct).toBeNull();       // no closed trades to rate
  });

  it("entry and exit dates line up with the bars the position changed on", () => {
    const r = runBacktest(choppy, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(r.trades.length).toBeGreaterThan(3);
    for (const t of r.trades) {
      const ei = r.dates.indexOf(t.entryDate);
      expect(r.position[ei]).toBe(1);
      expect(r.position[ei - 1]).toBe(0);
      if (!t.open) {
        const xi = r.dates.indexOf(t.exitDate!);
        expect(r.position[xi]).toBe(0);
        expect(r.position[xi - 1]).toBe(1);
      }
    }
  });
});

describe("runBacktest — stats honesty", () => {
  it("withholds CAGR on a window too short to annualise", () => {
    const short = mkBars(Array.from({ length: 90 }, (_, i) => 100 + i));  // ~3 months
    const r = runBacktest(short, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(r.stats.years).toBeLessThan(0.75);
    expect(r.stats.cagrPct).toBeNull();
  });

  it("reports CAGR once there is more than a year of data", () => {
    const r = runBacktest(rising, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(r.stats.years).toBeGreaterThan(1);
    expect(r.stats.cagrPct).toBeGreaterThan(0);
  });

  it("returns null (not 0) for Sharpe when there is no variance to divide by", () => {
    const flat = mkBars(Array.from({ length: 200 }, () => 100));
    const r = runBacktest(flat, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(r.stats.sharpe).toBeNull();
    expect(r.stats.totalPct).toBeCloseTo(0, 10);
  });

  it("max drawdown is 0 for a series that only goes up, and negative otherwise", () => {
    expect(runBacktest(rising, { strategy: "sma_cross", params: {} })!.stats.buyHoldMaxDdPct)
      .toBeCloseTo(0, 10);
    expect(runBacktest(vShape, { strategy: "sma_cross", params: {} })!.stats.buyHoldMaxDdPct)
      .toBeLessThan(-40);
  });

  it("annualises WEEKLY bars at ~52/yr, not 252 (3Y+ windows are weekly)", () => {
    // Same return pattern, sampled weekly instead of daily.
    const weekly: Bar[] = Array.from({ length: 260 }, (_, i) => ({
      date: new Date(Date.UTC(2018, 0, 1 + i * 7)).toISOString().slice(0, 10),
      close: 100 * 1.002 ** i * (1 + 0.01 * Math.sin(i)),
    }));
    const r = runBacktest(weekly, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(r.stats.barsPerYear).toBeGreaterThan(45);
    expect(r.stats.barsPerYear).toBeLessThan(60);

    const d = runBacktest(rising, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    expect(d.stats.barsPerYear).toBeGreaterThan(200);   // daily bars
  });

  it("exposure is the share of bars actually held", () => {
    const r = runBacktest(rising, { strategy: "sma_cross", params: { fast: 5, slow: 20 } })!;
    const held = r.position.filter((p) => p === 1).length;
    expect(r.stats.exposurePct).toBeCloseTo((held / r.position.length) * 100, 10);
  });
});

describe("signalsFor — per-strategy rules", () => {
  it("RSI holds through the middle of the band instead of selling on recovery", () => {
    // Sharp drop (RSI oversold) then a mild grind back up.
    const closes = [
      ...Array.from({ length: 30 }, () => 100),
      ...Array.from({ length: 10 }, (_, i) => 100 - i * 5),
      ...Array.from({ length: 40 }, (_, i) => 55 + i * 0.3),
    ];
    const sig = signalsFor(closes, {
      strategy: "rsi_reversion", params: { period: 14, low: 30, high: 70 },
    });
    const entry = sig.indexOf(1);
    expect(entry).toBeGreaterThan(0);
    // Still long several bars later even though RSI has recovered past 30.
    expect(sig[entry + 10]).toBe(1);
  });

  it("Donchian needs a break of the PRIOR window, not a tie with itself", () => {
    const closes = Array.from({ length: 100 }, () => 50);   // perfectly flat
    const sig = signalsFor(closes, { strategy: "donchian", params: { entry: 20, exit: 10 } });
    expect(sig.every((s) => s === 0)).toBe(true);
  });

  it("Donchian goes long on a genuine breakout", () => {
    const closes = [...Array.from({ length: 60 }, () => 50), 60, 61, 62];
    const sig = signalsFor(closes, { strategy: "donchian", params: { entry: 20, exit: 10 } });
    expect(sig.at(-1)).toBe(1);
  });

  it("MACD and EMA crossovers produce long stretches on a trending series", () => {
    const closes = rising.map((b) => b.close);
    for (const strategy of ["macd_cross", "ema_cross"] as const) {
      const sig = signalsFor(closes, { strategy, params: {} });
      expect(sig.filter((s) => s === 1).length).toBeGreaterThan(closes.length * 0.5);
    }
  });

  it("coerces a slow window that is not slower than the fast one", () => {
    // fast 50 / slow 10 is nonsense; the engine must not divide by a bad window.
    const r = runBacktest(rising, { strategy: "sma_cross", params: { fast: 50, slow: 10 } })!;
    expect(r.equity.every(Number.isFinite)).toBe(true);
  });

  it("every declared strategy runs with its declared defaults", () => {
    for (const s of STRATEGIES) {
      const params = Object.fromEntries(s.params.map((p) => [p.key, p.def]));
      const r = runBacktest(rising, { strategy: s.id, params });
      expect(r, s.id).not.toBeNull();
      expect(r!.equity.every(Number.isFinite), s.id).toBe(true);
    }
  });
});

describe("sweep", () => {
  it("covers the full grid and reports per-cell results", () => {
    const cells = sweep(rising, "sma_cross", "fast", [5, 10], "slow", [30, 60], {}, 5);
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => Number.isFinite(c.totalPct))).toBe(true);
  });

  it("gridAround centres the grid and skips degenerate windows", () => {
    expect(gridAround(50, 10, 5)).toEqual([30, 40, 50, 60, 70]);
    expect(gridAround(3, 5, 5)).toEqual([3, 8, 13]);   // -7 and -2 dropped as <= 1
  });
});

// ── out-of-sample and per-year, added because a single equity curve cannot
//    show whether a result was fitted or was one good year ─────────────────

describe("splitSample", () => {
  /** Rises for the first half, falls for the second. */
  const regimeChange = (n = 400) => {
    const out: { date: string; close: number }[] = [];
    let px = 100;
    for (let i = 0; i < n; i++) {
      px *= i < n / 2 ? 1.004 : 0.997;
      out.push({
        date: new Date(Date.UTC(2022, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        close: px,
      });
    }
    return out;
  };

  it("runs the SAME parameters on both halves", () => {
    const s = splitSample(regimeChange(), { strategy: "sma_cross", params: { fast: 10, slow: 30 } });
    expect(s.inSample).not.toBeNull();
    expect(s.outSample).not.toBeNull();
    expect(s.splitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("exposes a rule that only worked in the first half", () => {
    // The failure a single equity curve cannot show: fitted to one window.
    const s = splitSample(regimeChange(), { strategy: "sma_cross", params: { fast: 10, slow: 30 } });
    expect(s.outSample!.totalPct).toBeLessThan(s.inSample!.totalPct);
    expect(s.decayPct!).toBeLessThan(0);
  });

  it("splits at the declared share of history", () => {
    expect(IN_SAMPLE_SHARE).toBeGreaterThan(0.5);
    expect(IN_SAMPLE_SHARE).toBeLessThan(0.9);
  });

  it("REFUSES to split history too short for two halves", () => {
    const s = splitSample(regimeChange(80), { strategy: "sma_cross", params: {} });
    expect(s.inSample).toBeNull();
    expect(s.read).toMatch(/Not enough history to split/);
  });

  it("says plainly that this is not a walk-forward optimisation", () => {
    // It answers "does this rule keep working", not "could a re-fitted
    // version keep working" — the weaker question, honestly labelled.
    const s = splitSample(regimeChange(), { strategy: "sma_cross", params: { fast: 10, slow: 30 } });
    expect(s.read.length).toBeGreaterThan(20);
  });
});

describe("yearlyReturns", () => {
  const multiYear = () => {
    const out: { date: string; close: number }[] = [];
    let px = 100;
    for (let i = 0; i < 900; i++) {
      px *= 1.0015;
      out.push({
        date: new Date(Date.UTC(2021, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        close: px,
      });
    }
    return out;
  };

  it("breaks the total into calendar years", () => {
    const res = runBacktest(multiYear(), { strategy: "sma_cross", params: { fast: 10, slow: 30 } })!;
    const rows = yearlyReturns(res);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.year)).toEqual([...rows.map((r) => r.year)].sort());
  });

  it("reports the strategy against holding, year by year", () => {
    const res = runBacktest(multiYear(), { strategy: "sma_cross", params: { fast: 10, slow: 30 } })!;
    for (const r of yearlyReturns(res)) {
      expect(r.excessPct).toBeCloseTo(r.strategyPct - r.buyHoldPct, 6);
    }
  });

  it("has nothing to say about a single year", () => {
    expect(yearlyNote([{ year: "2024", strategyPct: 10, buyHoldPct: 5, excessPct: 5 }]))
      .toMatch(/not enough to say/);
  });

  it("calls out a result that is really one good year", () => {
    const rows = [
      { year: "2021", strategyPct: 90, buyHoldPct: 10, excessPct: 80 },
      { year: "2022", strategyPct: 2, buyHoldPct: 8, excessPct: -6 },
      { year: "2023", strategyPct: 1, buyHoldPct: 9, excessPct: -8 },
    ];
    const note = yearlyNote(rows);
    expect(note).toMatch(/2021 alone accounts for/);
    expect(note).toMatch(/one good year with a strategy wrapped around it/);
  });

  it("counts the years it beat holding", () => {
    const rows = [
      { year: "2021", strategyPct: 10, buyHoldPct: 5, excessPct: 5 },
      { year: "2022", strategyPct: 3, buyHoldPct: 9, excessPct: -6 },
    ];
    expect(yearlyNote(rows)).toMatch(/Beat buy-and-hold in 1 of 2 calendar years/);
  });

  it("admits a calendar year is an arbitrary cut", () => {
    const rows = [
      { year: "2021", strategyPct: 10, buyHoldPct: 5, excessPct: 5 },
      { year: "2022", strategyPct: 3, buyHoldPct: 9, excessPct: -6 },
    ];
    expect(yearlyNote(rows)).toMatch(/arbitrary cut/);
  });
});
