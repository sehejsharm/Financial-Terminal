import { describe, expect, it } from "vitest";

import {
  keyLevels, levelNote, MIN_BARS, tally, technicalNote, technicalReadings, toOhlc,
  type Level, type Reading,
} from "./technicalRead";
import type { Bar } from "./indicatorsPlus";

/** Bars from a list of closes, with a plausible high/low/volume around each. */
function bars(closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    time: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: close, high: close * 1.01, low: close * 0.99, close,
    volume: 1_000_000,
  }));
}

const rising = (n: number, from = 100, rate = 1.01) =>
  bars(Array.from({ length: n }, (_, i) => from * rate ** i));
const falling = (n: number) => rising(n, 100, 0.99);
const flat = (n: number) => bars(Array.from({ length: n }, () => 100));

const find = (rs: Reading[], key: string) => rs.find((r) => r.key === key);

describe("toOhlc", () => {
  it("reads the key spellings the providers actually send", () => {
    const rows = [
      { Date: "2026-01-02", Open: 10, High: 11, Low: 9, Close: 10.5, Volume: 100 },
      { time: "2026-01-03 15:30:00", open: 10, high: 11, low: 9, close: 10.6, volume: 100 },
      { t: 1767484800, o: 10, h: 11, l: 9, c: 10.7, v: 100 },
    ];
    expect(toOhlc(rows)).toHaveLength(3);
  });

  it("sorts ascending and drops rows without a usable close", () => {
    const bs = toOhlc([
      { time: "2026-01-03", close: 11 },
      { time: "2026-01-02", close: 10 },
      { time: "2026-01-04", close: 0 },
      { time: "not-a-date", close: 12 },
    ]);
    expect(bs.map((b) => b.close)).toEqual([10, 11]);
  });

  it("leaves volume NULL when absent rather than substituting zero", () => {
    // A zero would let the money-flow reads compute off nothing and print a
    // confident number; a null makes them drop out of the list entirely.
    const [b] = toOhlc([{ time: "2026-01-02", close: 10 }]);
    expect(b.volume).toBeNull();
    expect(toOhlc([{ time: "2026-01-02", close: 10, volume: 0 }])[0].volume).toBeNull();
  });

  it("fills a missing high/low from the open and close", () => {
    const [b] = toOhlc([{ time: "2026-01-02", open: 9, close: 11 }]);
    expect(b.high).toBe(11);
    expect(b.low).toBe(9);
  });

  it("handles null and empty input", () => {
    expect(toOhlc(null)).toEqual([]);
    expect(toOhlc([])).toEqual([]);
  });
});

describe("technicalReadings", () => {
  it(`returns nothing under ${MIN_BARS} bars, rather than computing off a handful`, () => {
    expect(technicalReadings(rising(MIN_BARS - 1))).toEqual([]);
    expect(technicalReadings([])).toEqual([]);
    expect(technicalReadings(rising(MIN_BARS)).length).toBeGreaterThan(0);
  });

  it("omits the 200-day reads when there is no 200 days of history", () => {
    // Reporting a "200-day average" computed off 60 bars would be a fabrication.
    const short = technicalReadings(rising(80));
    expect(find(short, "ma50")).toBeDefined();
    expect(find(short, "ma200")).toBeUndefined();
    expect(find(short, "cross")).toBeUndefined();

    const long = technicalReadings(rising(250));
    expect(find(long, "ma200")).toBeDefined();
    expect(find(long, "cross")).toBeDefined();
  });

  it("reads a sustained advance as bullish trend and a decline as bearish", () => {
    const up = technicalReadings(rising(250));
    for (const key of ["ma50", "ma200", "cross", "supertrend", "ema20"]) {
      expect(find(up, key)!.signal, key).toBe("bullish");
    }
    const down = technicalReadings(falling(250));
    for (const key of ["ma50", "ma200", "cross", "supertrend", "ema20"]) {
      expect(find(down, key)!.signal, key).toBe("bearish");
    }
  });

  it("states price vs an average as a signed percentage of the average", () => {
    const rs = technicalReadings(rising(250));
    const ma50 = find(rs, "ma50")!;
    expect(ma50.unit).toBe("%");
    expect(ma50.value!).toBeGreaterThan(0);      // above a rising average
    expect(find(technicalReadings(falling(250)), "ma50")!.value!).toBeLessThan(0);
  });

  it("keeps ADX direction-neutral — it measures strength, not direction", () => {
    // The single most common misreading of an indicator: a high ADX in a
    // downtrend is not bullish, and a high ADX in an uptrend is not extra
    // confirmation. It must never contribute a direction.
    for (const b of [rising(250), falling(250)]) {
      const a = find(technicalReadings(b), "adx")!;
      expect(a.signal).toBe("neutral");
      expect(a.read).toMatch(/says nothing about direction/);
    }
  });

  it("treats an overbought RSI as a caution, not a sell", () => {
    const r = find(technicalReadings(rising(120)), "rsi")!;
    expect(r.value!).toBeGreaterThan(70);
    expect(r.signal).toBe("bearish");
    expect(r.read).toMatch(/caution rather than a sell/);
  });

  it("says an oversold reading is not the same as a turn", () => {
    const r = find(technicalReadings(falling(120)), "rsi")!;
    expect(r.value!).toBeLessThan(30);
    expect(r.signal).toBe("bullish");
    expect(r.read).toMatch(/cheap is not the same as turning/);
  });

  it("reports Bollinger position without scoring it", () => {
    // Price rides the upper band through an entire advance, so a band touch
    // is a description of where price is, not a signal to fade it.
    const b = find(technicalReadings(rising(120)), "bb")!;
    expect(b.signal).toBe("neutral");
    expect(b.value!).toBeGreaterThan(50);
    expect(find(technicalReadings(rising(120)), "bb")!.read)
      .toMatch(/rides the band|way up the band/);
  });

  it("expresses ATR as a percentage of price, so it is comparable across names", () => {
    const a = find(technicalReadings(rising(120)), "atr")!;
    expect(a.unit).toBe("%");
    expect(a.value!).toBeGreaterThan(0);
    expect(a.value!).toBeLessThan(100);
    expect(a.signal).toBe("neutral");
    expect(a.read).toMatch(/size a stop against this/);
  });

  it("drops the volume reads when the bars carry no volume", () => {
    const noVol = rising(120).map((b) => ({ ...b, volume: null }));
    expect(find(technicalReadings(noVol), "mfi")).toBeUndefined();
    // ...while the price-only reads survive.
    expect(find(technicalReadings(noVol), "ma50")).toBeDefined();
  });

  it("pairs MACD with its signal line so the crossover is inspectable", () => {
    const m = find(technicalReadings(rising(120)), "macd")!;
    expect(m.extra).not.toBeNull();
    expect(m.signal).toBe("bullish");
  });

  it("gives every reading a group, a label and a sentence", () => {
    for (const r of technicalReadings(rising(250))) {
      expect(["Trend", "Momentum", "Volatility", "Volume"]).toContain(r.group);
      expect(r.label.length).toBeGreaterThan(2);
      expect(r.read.length).toBeGreaterThan(10);
    }
  });

  it("produces no NaN on a perfectly flat series", () => {
    for (const r of technicalReadings(flat(250))) {
      if (r.value != null) expect(Number.isFinite(r.value), r.key).toBe(true);
      if (r.extra != null) expect(Number.isFinite(r.extra), r.key).toBe(true);
    }
  });
});

describe("keyLevels", () => {
  // A zig-zag with two clear peaks and troughs, ending mid-range.
  const zig = bars([
    ...Array.from({ length: 12 }, (_, i) => 100 + i),      // up to 111
    ...Array.from({ length: 12 }, (_, i) => 111 - i * 2),  // down to 89
    ...Array.from({ length: 12 }, (_, i) => 89 + i * 2.5), // up to 116.5
    ...Array.from({ length: 12 }, (_, i) => 116.5 - i),    // down to 105.5
  ]);

  it("needs a minimum of bars before it will name a level", () => {
    expect(keyLevels(bars([100, 101, 102]))).toEqual([]);
  });

  it("always reports the window high and low", () => {
    const ls = keyLevels(zig);
    expect(ls.map((l) => l.label)).toContain("Window high");
    expect(ls.map((l) => l.label)).toContain("Window low");
  });

  it("classifies by side of the price and signs the distance accordingly", () => {
    for (const l of keyLevels(zig)) {
      if (l.kind === "resistance") expect(l.distancePct).toBeGreaterThanOrEqual(0);
      else expect(l.distancePct).toBeLessThan(0);
    }
  });

  it("returns levels ordered high to low, as they'd be drawn", () => {
    const ps = keyLevels(zig).map((l) => l.price);
    expect([...ps].sort((a, b) => b - a)).toEqual(ps);
  });

  it("collapses near-identical swings into one level instead of three lines", () => {
    // Two peaks a fraction apart are one level, not two.
    const doubleTop = bars([
      ...Array.from({ length: 10 }, (_, i) => 90 + i),
      100.0, 99, 98, 97, 96, 95,
      96, 97, 98, 99, 100.4, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90,
    ]);
    const res = keyLevels(doubleTop).filter((l) => l.kind === "resistance");
    // Never two lines within 1.5% of each other.
    for (let i = 1; i < res.length; i++) {
      expect(Math.abs(res[i].price - res[i - 1].price) / res[i].price * 100)
        .toBeGreaterThan(0.5);
    }
  });

  it("counts how many sessions traded at each level", () => {
    for (const l of keyLevels(zig)) expect(l.touches).toBeGreaterThanOrEqual(1);
  });

  it("caps the levels per side, because twelve lines say nothing", () => {
    const noisy = bars(Array.from({ length: 200 },
      (_, i) => 100 + Math.sin(i / 3) * 10));
    const ls = keyLevels(noisy);
    expect(ls.filter((l) => l.kind === "resistance").length).toBeLessThanOrEqual(3);
    expect(ls.filter((l) => l.kind === "support").length).toBeLessThanOrEqual(3);
  });
});

describe("levelNote", () => {
  it("states the reward-to-risk implied by the nearest levels", () => {
    const ls: Level[] = [
      { label: "Nearest resistance", price: 110, distancePct: 10, kind: "resistance", touches: 3 },
      { label: "Nearest support", price: 95, distancePct: -5, kind: "support", touches: 4 },
    ];
    const note = levelNote(ls);
    expect(note).toMatch(/2\.0:1/);
    expect(note).toMatch(/before any position sizing/);
  });

  it("says the levels are window-dependent and not a reason to trade", () => {
    const note = levelNote(keyLevels(bars(
      Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 8))));
    expect(note).toMatch(/different chart period gives different levels/);
    expect(note).toMatch(/neither is a reason to trade on its own/);
  });

  it("says so when there is nothing to mark up", () => {
    expect(levelNote([])).toMatch(/Not enough bars/);
  });
});

describe("tally", () => {
  it("counts directional signals separately from neutral ones", () => {
    const t = tally(technicalReadings(rising(250)));
    expect(t.directional).toBe(t.bullish + t.bearish);
    expect(t.neutral).toBeGreaterThan(0);   // ADX, ATR and Bollinger at least
    expect(t.bullish).toBeGreaterThan(t.bearish);
  });

  it("is all zeros for no readings", () => {
    expect(tally([])).toEqual({ bullish: 0, bearish: 0, neutral: 0, directional: 0 });
  });
});

describe("technicalNote", () => {
  const noteFor = (b: Bar[]) => {
    const rs = technicalReadings(b);
    return technicalNote(rs, tally(rs), b.length);
  };

  it("REFUSES to present the count as a consensus", () => {
    // "9 of 12 bullish" implies twelve independent votes. Most of these are
    // functions of the same moving averages, so it is one vote repeated.
    const note = noteFor(rising(250));
    expect(note).toMatch(/COUNT/);
    expect(note).toMatch(/not be read as a consensus/);
    expect(note).toMatch(/one observation repeated/);
  });

  it("says the indicators are backward-looking and late", () => {
    expect(noteFor(rising(250))).toMatch(/past prices only/);
    expect(noteFor(rising(250))).toMatch(/turn late/);
  });

  it("reports the leading direction with its denominator", () => {
    const rs = technicalReadings(falling(250));
    const t = tally(rs);
    expect(technicalNote(rs, t, 250))
      .toMatch(new RegExp(`${t.bearish} of ${t.directional} directional`));
  });

  it("calls a tie a split rather than picking a side", () => {
    const split: Reading[] = [
      { key: "a", label: "A", value: 1, unit: "", signal: "bullish", read: "x", group: "Trend" },
      { key: "b", label: "B", value: 1, unit: "", signal: "bearish", read: "y", group: "Trend" },
    ];
    expect(technicalNote(split, tally(split), 250)).toMatch(/split 1–1/);
  });

  it("explains the shortfall rather than the readings when history is short", () => {
    const note = noteFor(rising(20));
    expect(note).toMatch(/Only 20 sessions/);
    expect(note).toMatch(/longer chart period/);
  });
});
