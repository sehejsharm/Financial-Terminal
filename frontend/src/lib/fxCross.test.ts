import { describe, expect, it } from "vitest";

import { cross, crossMatrix, FX_CCYS, fxDigits, usdPerUnit } from "./fxCross";

// Realistic shapes: some pairs quote USD second, some quote it first.
const QUOTES = [
  { sym: "EURUSD=X", rate: 1.08 },   // dollars per euro
  { sym: "GBPUSD=X", rate: 1.27 },
  { sym: "USDJPY=X", rate: 157.0 },  // yen per dollar — needs inverting
  { sym: "USDINR=X", rate: 83.5 },
  { sym: "USDCHF=X", rate: 0.89 },
];

describe("usdPerUnit", () => {
  it("reads XXXUSD directly and inverts USDXXX", () => {
    const u = usdPerUnit(QUOTES);
    expect(u.USD).toBe(1);
    expect(u.EUR).toBeCloseTo(1.08, 10);
    // 157 yen to the dollar => one yen is 1/157 dollars.
    expect(u.JPY).toBeCloseTo(1 / 157, 12);
    expect(u.INR).toBeCloseTo(1 / 83.5, 12);
  });

  it("ORIENTATION is the thing that must not be wrong", () => {
    const u = usdPerUnit(QUOTES);
    // A euro is worth more than a dollar; a yen and a rupee far less.
    expect(u.EUR).toBeGreaterThan(1);
    expect(u.JPY).toBeLessThan(0.02);
    expect(u.INR).toBeLessThan(0.02);
  });

  it("skips unusable and unparseable quotes instead of poisoning the table", () => {
    const u = usdPerUnit([
      ...QUOTES,
      { sym: "EURUSD=X", rate: null },
      { sym: "BADSYMBOL", rate: 5 },
      { sym: "USDZZZ=X", rate: 0 },
      { sym: "USDYYY=X", rate: -3 },
      { sym: "USDWWW=X", rate: Number.NaN },
    ]);
    expect(u.ZZZ).toBeUndefined();
    expect(u.YYY).toBeUndefined();
    expect(u.WWW).toBeUndefined();
    expect(u.EUR).toBeCloseTo(1.08, 10);   // the good quote still stands
  });

  it("handles an empty feed", () => {
    expect(usdPerUnit([])).toEqual({ USD: 1 });
  });
});

describe("cross", () => {
  const u = usdPerUnit(QUOTES);

  it("a currency against itself is exactly 1", () => {
    for (const c of ["USD", "EUR", "JPY"]) expect(cross(u, c, c)).toBe(1);
  });

  it("triangulates through the dollar", () => {
    // EUR/JPY = (USD per EUR) / (USD per JPY) = 1.08 * 157
    expect(cross(u, "EUR", "JPY")!).toBeCloseTo(1.08 * 157, 8);
    expect(cross(u, "GBP", "INR")!).toBeCloseTo(1.27 * 83.5, 8);
  });

  it("the reciprocal of a cross is the reverse cross", () => {
    const a = cross(u, "EUR", "JPY")!;
    const b = cross(u, "JPY", "EUR")!;
    expect(a * b).toBeCloseTo(1, 10);
  });

  it("is transitive — A/B x B/C equals A/C", () => {
    const ab = cross(u, "EUR", "GBP")!;
    const bc = cross(u, "GBP", "JPY")!;
    expect(ab * bc).toBeCloseTo(cross(u, "EUR", "JPY")!, 8);
  });

  it("returns null rather than guessing when a leg is missing", () => {
    expect(cross(u, "EUR", "AUD")).toBeNull();
    expect(cross(u, "AUD", "EUR")).toBeNull();
    expect(cross(u, "AUD", "CAD")).toBeNull();
  });
});

describe("crossMatrix", () => {
  const m = crossMatrix(QUOTES);

  it("is square over the requested currencies", () => {
    expect(m.ccys).toEqual(FX_CCYS);
    expect(m.rows).toHaveLength(FX_CCYS.length);
    for (const r of m.rows) expect(r).toHaveLength(FX_CCYS.length);
  });

  it("has 1 down the diagonal", () => {
    m.rows.forEach((row, i) => expect(row[i]).toBe(1));
  });

  it("names the currencies it could not price", () => {
    // No AUD/CAD/CNY/SGD quotes were supplied.
    expect(m.missing.sort()).toEqual(["AUD", "CAD", "CNY", "SGD"]);
    const i = m.ccys.indexOf("AUD");
    expect(m.rows[i].every((v, j) => (j === i ? v === 1 : v === null))).toBe(true);
  });

  it("every priced cell is the reciprocal of its mirror", () => {
    for (let i = 0; i < m.ccys.length; i++) {
      for (let j = 0; j < m.ccys.length; j++) {
        const a = m.rows[i][j], b = m.rows[j][i];
        if (a == null || b == null) continue;
        expect(a * b, `${m.ccys[i]}/${m.ccys[j]}`).toBeCloseTo(1, 9);
      }
    }
  });

  it("works with a custom currency list", () => {
    const small = crossMatrix(QUOTES, ["USD", "EUR"]);
    expect(small.ccys).toEqual(["USD", "EUR"]);
    expect(small.rows[1][0]).toBeCloseTo(1.08, 10);
    expect(small.missing).toEqual([]);
  });
});

describe("fxDigits", () => {
  it("scales precision to the magnitude of the rate", () => {
    expect(fxDigits(157.2)).toBe(2);     // JPY-style
    expect(fxDigits(1.0834)).toBe(4);    // EURUSD-style
    expect(fxDigits(0.0064)).toBe(6);    // JPY per USD inverted
    expect(fxDigits(null)).toBe(2);
    expect(fxDigits(Number.NaN)).toBe(2);
  });
});
