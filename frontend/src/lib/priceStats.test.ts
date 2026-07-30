import { describe, expect, it } from "vitest";

import {
  horizonReturns, performanceNote, rideStats, toBars, ytdReturn,
} from "./priceStats";

const DAY = 86_400_000;

/** Daily candles ending on `end`, closes given oldest-first. */
function candles(closes: number[], end = Date.UTC(2026, 5, 30)) {
  return closes.map((close, i) => ({
    time: new Date(end - (closes.length - 1 - i) * DAY).toISOString(),
    close,
  }));
}

describe("toBars", () => {
  it("reads the shapes the providers actually send", () => {
    const mixed = [
      { Date: "2026-01-02", Close: 100 },
      { time: "2026-01-03", close: 101 },
      { t: 1767398400, c: 102 },          // seconds
      { time: 1767484800000, close: 103 }, // milliseconds
    ];
    expect(toBars(mixed)).toHaveLength(4);
  });

  it("sorts ascending whatever order it received", () => {
    const bars = toBars([
      { time: "2026-01-03", close: 101 },
      { time: "2026-01-02", close: 100 },
    ]);
    expect(bars.map((b) => b.close)).toEqual([100, 101]);
  });

  it("drops unusable rows rather than letting a zero close through", () => {
    // A zero or negative close would produce an infinite return.
    const bars = toBars([
      { time: "2026-01-02", close: 0 },
      { time: "2026-01-03", close: -5 },
      { time: "bad-date", close: 10 },
      { time: "2026-01-06", close: 10 },
    ]);
    expect(bars).toHaveLength(1);
  });

  it("handles null and empty input", () => {
    expect(toBars(null)).toEqual([]);
    expect(toBars([])).toEqual([]);
  });
});

describe("horizonReturns", () => {
  // 400 sessions rising 0.1% a day.
  const bars = toBars(candles(
    Array.from({ length: 400 }, (_, i) => 100 * 1.001 ** i)));

  it("measures back in DAYS, not in bars", () => {
    // Counting back "20 bars" gives a different date on every exchange once
    // holidays differ, and two names stop being comparable.
    const r = horizonReturns(bars);
    const oneMonth = r.find((x) => x.key === "1m")!;
    expect(oneMonth.fromDate).toBe(
      new Date(bars[bars.length - 1].t - 30 * DAY).toISOString().slice(0, 10));
  });

  it("computes the arithmetic you can check", () => {
    const flat = toBars(candles([100, 100, 100, 110]));
    // Three days of history: the 1-week window doesn't fit.
    expect(horizonReturns(flat).find((x) => x.key === "1w")!.pct).toBeNull();
  });

  it("REFUSES a horizon longer than the history rather than shortening it", () => {
    // Measuring from the oldest bar and calling a four-month move a "1 year
    // return" is the failure this prevents.
    const short = toBars(candles(Array.from({ length: 40 }, () => 100)));
    const r = horizonReturns(short);
    expect(r.find((x) => x.key === "1y")!.pct).toBeNull();
    expect(r.find((x) => x.key === "1w")!.pct).not.toBeNull();
  });

  it("takes the last bar at or before the cutoff, not the next one after", () => {
    // A window whose start lands on a holiday must not shorten the period.
    const end = Date.UTC(2026, 5, 30);
    const sparse = [
      { time: new Date(end - 40 * DAY).toISOString(), close: 100 },
      { time: new Date(end - 8 * DAY).toISOString(), close: 110 },
      { time: new Date(end).toISOString(), close: 120 },
    ];
    const r = horizonReturns(toBars(sparse));
    const week = r.find((x) => x.key === "1w")!;
    expect(week.pct).toBeCloseTo(((120 / 110) - 1) * 100, 6);
  });

  it("returns nulls for a series too short to measure", () => {
    expect(horizonReturns([]).every((r) => r.pct === null)).toBe(true);
  });
});

describe("ytdReturn", () => {
  it("measures from the last close of the previous year", () => {
    const bars = toBars([
      { time: "2025-12-31", close: 100 },
      { time: "2026-01-02", close: 105 },
      { time: "2026-06-30", close: 120 },
    ]);
    const y = ytdReturn(bars);
    expect(y.pct).toBeCloseTo(20, 6);
    expect(y.fromDate).toBe("2025-12-31");
  });

  it("returns nothing when the history starts inside this year", () => {
    const bars = toBars([
      { time: "2026-02-01", close: 100 }, { time: "2026-06-30", close: 120 },
    ]);
    expect(ytdReturn(bars).pct).toBeNull();
  });
});

describe("rideStats", () => {
  it("finds the deepest peak-to-trough fall, not the last one", () => {
    // 100 -> 150 -> 75 is a 50% drawdown; a later dip from 120 to 108 is 10%.
    const bars = toBars(candles([100, 150, 75, 120, 108]));
    expect(rideStats(bars).maxDrawdownPct!).toBeCloseTo(-50, 6);
  });

  it("is zero for a series that only rises", () => {
    expect(rideStats(toBars(candles([100, 110, 120]))).maxDrawdownPct).toBe(0);
  });

  it("places the last close within the window's range", () => {
    const s = rideStats(toBars(candles([100, 200, 150])));
    expect(s.low).toBe(100);
    expect(s.high).toBe(200);
    expect(s.rangePosition).toBeCloseTo(50, 6);
  });

  it("annualises volatility with the periods-per-year it is given", () => {
    const bars = toBars(candles(
      Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.01 * ((i % 2) ? 1 : -1)))));
    const daily = rideStats(bars, 252).annualVolPct!;
    const weekly = rideStats(bars, 52).annualVolPct!;
    expect(daily / weekly).toBeCloseTo(Math.sqrt(252 / 52), 6);
  });

  it("reports nothing rather than NaN on a flat or tiny series", () => {
    const flat = rideStats(toBars(candles([100, 100, 100])));
    expect(flat.annualVolPct).toBe(0);
    expect(flat.rangePosition).toBeNull();   // no range to sit inside
    expect(rideStats([]).annualVolPct).toBeNull();
  });
});

describe("performanceNote", () => {
  it("states the window the numbers came from", () => {
    const bars = toBars(candles([100, 105, 110]));
    const note = performanceNote(bars, rideStats(bars));
    expect(note).toMatch(/3 sessions/);
    expect(note).toMatch(/change the chart period/i);
  });

  it("says returns exclude dividends", () => {
    const bars = toBars(candles([100, 105, 110]));
    expect(performanceNote(bars, rideStats(bars))).toMatch(/dividends are not added back/);
  });

  it("calls out a severe drawdown, because an annual return hides it", () => {
    const bars = toBars(candles([100, 150, 60, 120]));
    const note = performanceNote(bars, rideStats(bars));
    expect(note).toMatch(/what holding it actually felt like/);
  });

  it("says so when there is nothing to measure", () => {
    expect(performanceNote([], rideStats([]))).toMatch(/Not enough price history/);
  });
});
