import { describe, expect, it } from "vitest";

import {
  adx, atr, cci, donchian, ichimoku, keltner, mfi, obv, psar, roc,
  stochastic, supertrend, trueRange, vwap, williamsR, type Bar,
} from "./indicatorsPlus";

/** Bars from OHLC tuples; volume defaults to a constant so volume-based
 *  indicators have something to work with. */
function mk(rows: [number, number, number, number, number?][]): Bar[] {
  return rows.map((r, i) => ({
    time: i, open: r[0], high: r[1], low: r[2], close: r[3],
    volume: r[4] ?? 1000,
  }));
}

/** A steady uptrend. */
const up = mk(Array.from({ length: 60 }, (_, i) =>
  [100 + i, 101 + i, 99 + i, 100.5 + i] as [number, number, number, number]));
/** A steady downtrend. */
const down = mk(Array.from({ length: 60 }, (_, i) =>
  [200 - i, 201 - i, 199 - i, 199.5 - i] as [number, number, number, number]));
/** Perfectly flat. */
const flat = mk(Array.from({ length: 40 }, () => [50, 50, 50, 50] as [number, number, number, number]));

const defined = (xs: (number | null)[]) => xs.filter((v): v is number => v != null);

describe("shape contract — every indicator", () => {
  const all: [string, (b: Bar[]) => (number | null)[]][] = [
    ["atr", (b) => atr(b)],
    ["trueRange", (b) => trueRange(b)],
    ["vwap", (b) => vwap(b)],
    ["cci", (b) => cci(b)],
    ["williamsR", (b) => williamsR(b)],
    ["mfi", (b) => mfi(b)],
    ["obv", (b) => obv(b)],
    ["stoch.k", (b) => stochastic(b).k],
    ["stoch.d", (b) => stochastic(b).d],
    ["adx", (b) => adx(b).adx],
    ["donchian.upper", (b) => donchian(b).upper],
    ["keltner.mid", (b) => keltner(b).mid],
    ["psar", (b) => psar(b).sar],
    ["supertrend", (b) => supertrend(b).line],
    ["ichimoku.conversion", (b) => ichimoku(b).conversion],
    ["roc", (b) => roc(b.map((x) => x.close))],
  ];

  it("returns one value per input bar", () => {
    for (const [name, fn] of all) {
      expect(fn(up).length, name).toBe(up.length);
    }
  });

  it("never produces NaN or Infinity, even on a perfectly flat series", () => {
    for (const [name, fn] of all) {
      for (const bars of [up, down, flat]) {
        for (const v of defined(fn(bars))) {
          expect(Number.isFinite(v), `${name} produced ${v}`).toBe(true);
        }
      }
    }
  });

  it("survives degenerate inputs without throwing", () => {
    for (const [name, fn] of all) {
      for (const bars of [[], mk([[1, 1, 1, 1]]), mk([[1, 2, 0.5, 1.5], [1.5, 2, 1, 1.2]])]) {
        expect(() => fn(bars), name).not.toThrow();
      }
    }
  });

  it("emits nulls — not zeros — before its window is full", () => {
    // A zero would plot as a real level and read as a signal.
    expect(atr(up, 14).slice(0, 13).every((v) => v == null)).toBe(true);
    expect(cci(up, 20).slice(0, 19).every((v) => v == null)).toBe(true);
    expect(donchian(up, 20).upper.slice(0, 19).every((v) => v == null)).toBe(true);
    expect(stochastic(up, 14).k.slice(0, 12).every((v) => v == null)).toBe(true);
  });
});

describe("trueRange / ATR", () => {
  it("first bar's true range is its own high-low", () => {
    expect(trueRange(up)[0]).toBe(2);
  });

  it("accounts for a gap through the previous close", () => {
    const gapped = mk([[10, 11, 9, 10], [20, 21, 19, 20]]);
    // |21 - 10| = 11 beats the 2-point intrabar range.
    expect(trueRange(gapped)[1]).toBe(11);
  });

  it("is zero on a flat series and positive on a moving one", () => {
    expect(defined(atr(flat, 14)).every((v) => v === 0)).toBe(true);
    expect(defined(atr(up, 14)).every((v) => v > 0)).toBe(true);
  });

  it("rises when the range widens", () => {
    const calm = mk(Array.from({ length: 40 }, () => [100, 101, 99, 100] as [number, number, number, number]));
    const wild = mk(Array.from({ length: 40 }, () => [100, 110, 90, 100] as [number, number, number, number]));
    expect(atr(wild, 14).at(-1)!).toBeGreaterThan(atr(calm, 14).at(-1)!);
  });
});

describe("stochastic & Williams %R", () => {
  it("pins to 100 at the top of the range and 0 at the bottom", () => {
    const atHigh = mk([...Array.from({ length: 20 }, () => [10, 12, 8, 10] as [number, number, number, number]),
                       [10, 12, 8, 12]]);
    expect(stochastic(atHigh, 14, 3, 1).k.at(-1)).toBeCloseTo(100, 6);

    const atLow = mk([...Array.from({ length: 20 }, () => [10, 12, 8, 10] as [number, number, number, number]),
                      [10, 12, 8, 8]]);
    expect(stochastic(atLow, 14, 3, 1).k.at(-1)).toBeCloseTo(0, 6);
  });

  it("stays inside 0..100", () => {
    for (const v of defined(stochastic(up).k)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("returns the mid-point rather than NaN when the window has no range", () => {
    expect(stochastic(flat, 14, 3, 1).k.at(-1)).toBe(50);
  });

  it("Williams %R is the stochastic mirrored onto -100..0", () => {
    const k = stochastic(up, 14, 3, 1).k;
    const w = williamsR(up, 14);
    const i = up.length - 1;
    expect(w[i]!).toBeCloseTo(k[i]! - 100, 6);
    for (const v of defined(w)) {
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(0);
    }
  });
});

describe("CCI / ROC", () => {
  it("CCI is positive in an uptrend and negative in a downtrend", () => {
    expect(cci(up, 20).at(-1)!).toBeGreaterThan(0);
    expect(cci(down, 20).at(-1)!).toBeLessThan(0);
  });

  it("CCI is 0 with no deviation instead of dividing by zero", () => {
    expect(cci(flat, 20).at(-1)).toBe(0);
  });

  it("ROC measures the percentage change over its lookback", () => {
    const closes = [100, 0, 0, 0, 0, 110];
    expect(roc(closes, 5).at(-1)).toBeCloseTo(10, 6);
  });
});

describe("volume indicators", () => {
  it("OBV accumulates on up closes and sheds on down closes", () => {
    const bars = mk([[10, 10, 10, 10, 100], [10, 10, 10, 11, 50], [10, 10, 10, 9, 30]]);
    expect(obv(bars)).toEqual([0, 50, 20]);
  });

  it("OBV ignores an unchanged close", () => {
    const bars = mk([[10, 10, 10, 10, 100], [10, 10, 10, 10, 50]]);
    expect(obv(bars)).toEqual([0, 0]);
  });

  it("OBV and MFI are ALL NULL when the bars carry no volume", () => {
    // Better an honest gap than a flat line that looks like data.
    const noVol: Bar[] = up.map((b) => ({ ...b, volume: null }));
    expect(obv(noVol).every((v) => v == null)).toBe(true);
    expect(mfi(noVol).every((v) => v == null)).toBe(true);
  });

  it("MFI stays inside 0..100 and is high in a steady advance", () => {
    for (const v of defined(mfi(up))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(mfi(up).at(-1)!).toBeGreaterThan(80);
  });

  it("VWAP sits inside the price range and follows the trend", () => {
    const v = vwap(up).at(-1)!;
    const lows = Math.min(...up.map((b) => b.low));
    const highs = Math.max(...up.map((b) => b.high));
    expect(v).toBeGreaterThan(lows);
    expect(v).toBeLessThan(highs);
    // In a rising market the running VWAP lags below the last price.
    expect(v).toBeLessThan(up.at(-1)!.close);
  });
});

describe("ADX", () => {
  it("reports a strong trend with +DI dominant in an uptrend", () => {
    const r = adx(up, 14);
    expect(r.adx.at(-1)!).toBeGreaterThan(40);
    expect(r.plusDi.at(-1)!).toBeGreaterThan(r.minusDi.at(-1)!);
  });

  it("reverses the DI dominance in a downtrend", () => {
    const r = adx(down, 14);
    expect(r.minusDi.at(-1)!).toBeGreaterThan(r.plusDi.at(-1)!);
  });

  it("keeps every component inside 0..100", () => {
    for (const s of [adx(up).adx, adx(up).plusDi, adx(up).minusDi]) {
      for (const v of defined(s)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("channels", () => {
  it("Donchian brackets the window and the mid sits between", () => {
    const d = donchian(up, 20);
    const i = up.length - 1;
    const window = up.slice(i - 19, i + 1);
    expect(d.upper[i]).toBe(Math.max(...window.map((b) => b.high)));
    expect(d.lower[i]).toBe(Math.min(...window.map((b) => b.low)));
    expect(d.mid[i]!).toBeCloseTo((d.upper[i]! + d.lower[i]!) / 2, 10);
  });

  it("Keltner bands straddle their EMA centre by an ATR multiple", () => {
    const k = keltner(up, 20, 2, 10);
    const i = up.length - 1;
    expect(k.upper[i]!).toBeGreaterThan(k.mid[i]!);
    expect(k.lower[i]!).toBeLessThan(k.mid[i]!);
    expect(k.upper[i]! - k.mid[i]!).toBeCloseTo(k.mid[i]! - k.lower[i]!, 8);
  });

  it("Keltner collapses onto its centre when there is no volatility", () => {
    const k = keltner(flat, 20, 2, 10);
    const i = flat.length - 1;
    expect(k.upper[i]).toBeCloseTo(k.lower[i]!, 8);
  });
});

describe("Parabolic SAR", () => {
  it("tracks below price in an uptrend and above in a downtrend", () => {
    const u = psar(up);
    const i = up.length - 1;
    expect(u.rising[i]).toBe(true);
    expect(u.sar[i]!).toBeLessThan(up[i].low);

    const d = psar(down);
    const j = down.length - 1;
    expect(d.rising[j]).toBe(false);
    expect(d.sar[j]!).toBeGreaterThan(down[j].high);
  });

  it("flips direction when the trend reverses", () => {
    const vshape = [...down.slice(0, 30), ...up.slice(0, 30).map((b, i) => ({
      ...b, time: 30 + i,
    }))];
    const r = psar(vshape);
    const dirs = r.rising.filter((v) => v != null);
    expect(new Set(dirs).size).toBe(2);
  });
});

describe("Supertrend", () => {
  it("sits below price and reads rising in an uptrend", () => {
    const r = supertrend(up, 10, 3);
    const i = up.length - 1;
    expect(r.rising[i]).toBe(true);
    expect(r.line[i]!).toBeLessThan(up[i].close);
  });

  it("sits above price in a downtrend", () => {
    const r = supertrend(down, 10, 3);
    const i = down.length - 1;
    expect(r.rising[i]).toBe(false);
    expect(r.line[i]!).toBeGreaterThan(down[i].close);
  });
});

describe("Ichimoku", () => {
  it("conversion reacts faster than the base line", () => {
    const r = ichimoku(up);
    const i = up.length - 1;
    // In a rise, the shorter-window midpoint is higher.
    expect(r.conversion[i]!).toBeGreaterThan(r.base[i]!);
  });

  it("span A is the average of conversion and base", () => {
    const r = ichimoku(up);
    const i = up.length - 1;
    expect(r.spanA[i]!).toBeCloseTo((r.conversion[i]! + r.base[i]!) / 2, 10);
  });

  it("returns spans UNSHIFTED so the caller controls the time displacement", () => {
    // Shifting inside the indicator would silently misalign the axis.
    const r = ichimoku(up, 9, 26, 52);
    expect(r.spanB.slice(0, 51).every((v) => v == null)).toBe(true);
    expect(r.spanB[51]).not.toBeNull();
  });

  it("the lagging line is the close displaced back by the base period", () => {
    const r = ichimoku(up, 9, 26, 52);
    expect(r.lagging[0]).toBe(up[26].close);
    expect(r.lagging.at(-1)).toBeNull();
  });
});
