import { describe, expect, it } from "vitest";

import {
  AXES, axisTicks, axisValue, costOfEquity, impliedMultiple, regionFor,
  sensitivity, valueSpread, waccFlags, waccModel, waccNote, withAxis,
  type WaccInputs,
} from "./waccModel";

/** A plain, well-behaved capital structure: 80/20, beta 1, 7%/6%/8%/25%. */
const base: WaccInputs = {
  equity: 800e9, debt: 200e9, beta: 1, rf: 7, erp: 6, rd: 8, tax: 25,
};

describe("regionFor", () => {
  it("reads the exchange suffix", () => {
    expect(regionFor("RELIANCE.NS").key).toBe("IN");
    expect(regionFor("TCS.BO").key).toBe("IN");
    expect(regionFor("VOD.L").key).toBe("GB");
    expect(regionFor("SAP.DE").key).toBe("EU");
    expect(regionFor("7203.T").key).toBe("JP");
    expect(regionFor("0700.HK").key).toBe("HK");
  });

  it("falls back to the currency when there is no suffix", () => {
    expect(regionFor("AAPL", "USD").key).toBe("US");
    expect(regionFor("SOMENAME", "INR").key).toBe("IN");
    expect(regionFor("SOMENAME", "JPY").key).toBe("JP");
  });

  it("lets the LISTING win over the reporting currency", () => {
    // A rupee-reporting company listed in London is priced by whoever is
    // pricing it, and that is the London market.
    expect(regionFor("SOMETHING.L", "INR").key).toBe("GB");
  });

  it("defaults to the US rather than throwing on an unknown symbol", () => {
    expect(regionFor("WEIRD.XYZ").key).toBe("US");
    expect(regionFor("").key).toBe("US");
  });

  it("does not default every listing to a 7% risk-free rate", () => {
    // The bug this replaces: 7% is roughly India and nowhere near the US, so
    // a US name was discounted 270bp too high before the user touched anything.
    expect(regionFor("AAPL", "USD").rf).toBeLessThan(6);
    expect(regionFor("RELIANCE.NS").rf).toBeGreaterThan(6);
  });
});

describe("costOfEquity", () => {
  it("is CAPM", () => {
    expect(costOfEquity(7, 1.2, 6)).toBeCloseTo(7 + 1.2 * 6, 10);
  });

  it("adds a company-specific premium on top", () => {
    expect(costOfEquity(7, 1, 6, 2)).toBeCloseTo(15, 10);
  });
});

describe("waccModel", () => {
  it("weights the two costs by capital", () => {
    const r = waccModel(base);
    expect(r.costOfEquity).toBeCloseTo(13, 10);
    expect(r.afterTaxDebt).toBeCloseTo(6, 10);
    expect(r.we).toBeCloseTo(0.8, 10);
    expect(r.wacc).toBeCloseTo(0.8 * 13 + 0.2 * 6, 10);
  });

  it("splits the WACC into the points each side contributes", () => {
    const r = waccModel(base);
    expect(r.equityContribution! + r.debtContribution!).toBeCloseTo(r.wacc!, 10);
  });

  it("prices the tax shield in the same units as the WACC", () => {
    const r = waccModel(base);
    // 20% of capital × 8% × 25% tax = 0.4 points off the WACC.
    expect(r.taxShield).toBeCloseTo(0.2 * 8 * 0.25, 10);
    const untaxed = waccModel({ ...base, tax: 0 });
    expect(untaxed.wacc! - r.wacc!).toBeCloseTo(r.taxShield!, 10);
  });

  it("REFUSES a WACC when there is no capital to weight", () => {
    // Market cap didn't load and there's no debt: weights are undefined, and a
    // fabricated 100%-equity answer would look perfectly reasonable.
    const r = waccModel({ ...base, equity: 0, debt: 0 });
    expect(r.wacc).toBeNull();
    expect(r.we).toBeNull();
    // ...but the cost of equity is still well-defined and still shown.
    expect(r.costOfEquity).toBeCloseTo(13, 10);
  });

  it("is just the cost of equity with no debt", () => {
    const r = waccModel({ ...base, debt: 0 });
    expect(r.wacc).toBeCloseTo(r.costOfEquity, 10);
    expect(r.taxShield).toBe(0);
  });
});

describe("withAxis / axisValue / axisTicks", () => {
  it("round-trips every axis", () => {
    for (const a of AXES) {
      const moved = withAxis(base, a.key, axisValue(base, a.key) + a.step);
      expect(axisValue(moved, a.key)).toBeCloseTo(axisValue(base, a.key) + a.step, 6);
    }
  });

  it("re-splits the SAME capital when moving leverage", () => {
    // Otherwise a leverage row would be changing enterprise value at the same
    // time and the grid would measure two things at once.
    const levered = withAxis(base, "leverage", 40);
    expect(levered.equity + levered.debt).toBeCloseTo(base.equity + base.debt, 4);
    expect(levered.debt / (levered.equity + levered.debt)).toBeCloseTo(0.4, 10);
  });

  it("centres the ticks on the current value", () => {
    const ticks = axisTicks(base, "beta", 2);
    expect(ticks).toHaveLength(5);
    expect(ticks[2]).toBeCloseTo(base.beta, 6);
  });

  it("clamps rather than printing a negative beta or a 120% tax rate", () => {
    expect(Math.min(...axisTicks({ ...base, beta: 0.1 }, "beta", 3))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...axisTicks({ ...base, tax: 45 }, "tax", 3))).toBeLessThanOrEqual(100);
  });

  it("collapses duplicates produced by clamping", () => {
    const ticks = axisTicks({ ...base, tax: 0 }, "tax", 3);
    expect(new Set(ticks).size).toBe(ticks.length);
  });
});

describe("sensitivity", () => {
  it("computes a WACC for every cell", () => {
    const g = sensitivity(base, "beta", "erp");
    expect(g.wacc).toHaveLength(g.rows.length);
    expect(g.wacc[0]).toHaveLength(g.cols.length);
    expect(g.wacc.flat().every((v) => v != null)).toBe(true);
  });

  it("puts the current inputs at the marked centre cell", () => {
    const g = sensitivity(base, "beta", "erp");
    expect(g.wacc[g.centreRow][g.centreCol]).toBeCloseTo(waccModel(base).wacc!, 8);
  });

  it("rises in beta and in the equity risk premium", () => {
    const g = sensitivity(base, "beta", "erp");
    const col = g.wacc.map((r) => r[0]!);
    expect(col[col.length - 1]).toBeGreaterThan(col[0]);
    const row = g.wacc[0].map((v) => v!);
    expect(row[row.length - 1]).toBeGreaterThan(row[0]);
  });

  it("falls as the tax rate rises, because the shield is worth more", () => {
    const g = sensitivity(base, "tax", "beta");
    expect(g.wacc[g.rows.length - 1][0]!).toBeLessThan(g.wacc[0][0]!);
  });

  it("reports the range the grid spans", () => {
    const g = sensitivity(base, "beta", "erp");
    expect(g.min!).toBeLessThan(waccModel(base).wacc!);
    expect(g.max!).toBeGreaterThan(waccModel(base).wacc!);
  });
});

describe("impliedMultiple", () => {
  it("is one over the spread", () => {
    // 9% discount against 3% growth is a 16.7x terminal multiple.
    expect(impliedMultiple(9, 3).multiple).toBeCloseTo(100 / 6, 8);
  });

  it("REFUSES a multiple when growth reaches the discount rate", () => {
    // Infinite value is a broken model, not a wonderful investment.
    const r = impliedMultiple(8, 8);
    expect(r.multiple).toBeNull();
    expect(r.problem).toMatch(/no finite value/);
    expect(r.problem).toMatch(/broken model/);
    expect(impliedMultiple(8, 9).multiple).toBeNull();
  });

  it("warns when the spread is thin enough to be meaningless", () => {
    const r = impliedMultiple(8, 7.5);
    expect(r.multiple).toBeCloseTo(200, 6);
    expect(r.problem).toMatch(/extremely sensitive/);
  });

  it("says so when there is no WACC", () => {
    expect(impliedMultiple(null, 3).multiple).toBeNull();
  });
});

describe("valueSpread", () => {
  it("says value is created when the return clears the cost", () => {
    const v = valueSpread(11, 0.22);
    expect(v.verdict).toBe("creating");
    expect(v.spread).toBeCloseTo(11, 6);
    expect(v.read).toMatch(/worth paying for/);
    // ...and does not promise the spread lasts.
    expect(v.read).toMatch(/competition closes most of them/);
  });

  it("says growth DESTROYS value when the return is below the cost", () => {
    const v = valueSpread(11, 0.08);
    expect(v.verdict).toBe("destroying");
    expect(v.read).toMatch(/destroys value by growing/);
    expect(v.read).toMatch(/reason for concern/);
  });

  it("calls a spread inside a point flat rather than a signal", () => {
    // Both inputs carry more error than that.
    const v = valueSpread(11, 0.115);
    expect(v.verdict).toBe("at cost");
    expect(v.read).toMatch(/inside the error bars/);
  });

  it("refuses to guess when there is no return on capital", () => {
    for (const roic of [null, undefined, NaN]) {
      const v = valueSpread(11, roic);
      expect(v.verdict).toBe("unknown");
      expect(v.spread).toBeNull();
    }
    expect(valueSpread(null, 0.2).verdict).toBe("unknown");
  });

  it("reads the provider's fraction, not a percentage", () => {
    // 0.22 is 22%, not 0.22%.
    expect(valueSpread(11, 0.22).spread).toBeCloseTo(11, 6);
  });
});

describe("waccFlags", () => {
  const flagsFor = (over: Partial<WaccInputs>) => {
    const i = { ...base, ...over };
    return waccFlags(i, waccModel(i)).map((f) => f.text).join(" ");
  };

  it("catches a cost of debt below the risk-free rate", () => {
    expect(flagsFor({ rd: 4 })).toMatch(/No corporate borrows below its government/);
  });

  it("catches a beta that makes equity cheaper than a government bond", () => {
    expect(flagsFor({ beta: -0.2 })).toMatch(/less than a government bond/);
  });

  it("questions an implausibly high beta instead of using it quietly", () => {
    expect(flagsFor({ beta: 2.6 })).toMatch(/regression artefact/);
  });

  it("says the inputs are optimistic at extreme leverage", () => {
    expect(flagsFor({ equity: 100e9, debt: 900e9 }))
      .toMatch(/beta understates equity risk/);
  });

  it("flags a missing market cap, which makes the weights meaningless", () => {
    expect(flagsFor({ equity: 0 })).toMatch(/Market cap didn't load/);
  });

  it("notes a debt-free structure and a zero tax rate", () => {
    expect(flagsFor({ debt: 0 })).toMatch(/tax shield contributes nothing/);
    expect(flagsFor({ tax: 0 })).toMatch(/removes the interest shield/);
  });

  it("is quiet on a sane structure", () => {
    expect(waccFlags(base, waccModel(base))).toHaveLength(0);
  });
});

describe("waccNote", () => {
  it("names the region the defaults came from and calls them anchors", () => {
    const note = waccNote(regionFor("RELIANCE.NS"), null);
    expect(note).toMatch(/India defaults/);
    expect(note).toMatch(/not today's quotes/);
  });

  it("states the grid range as the honest precision of the number", () => {
    const note = waccNote(regionFor("AAPL", "USD"), sensitivity(base, "beta", "erp"));
    expect(note).toMatch(/honest precision/);
    expect(note).toMatch(/centre cell is not more true than the corners/);
  });

  it("names what the model leaves out", () => {
    const note = waccNote(regionFor("AAPL", "USD"), null);
    expect(note).toMatch(/backward-looking regression/);
    expect(note).toMatch(/debt is at book/);
    expect(note).toMatch(/a model, not a measurement/);
  });
});
