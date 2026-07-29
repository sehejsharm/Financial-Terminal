import { describe, expect, it } from "vitest";

import {
  byCountry, concentration, exposures, hhiBand, riskNote, SINGLE_POINT_PCT,
  tradePlan,
} from "./chainRisk";
import type { ChainRow } from "./valueChainTable";

function row(over: Partial<ChainRow> & { name: string }): ChainRow {
  return {
    key: over.name.toLowerCase(),
    ticker: null, roles: [over.role ?? "supplier"], role: over.role ?? "supplier",
    country: null, pctRevenue: null, pctCOGS: null, valueUsd: null, yoyPct: null,
    confidence: "estimated", asOf: null, note: null,
    price: null, changePct: null, currency: null,
    ...over,
    name: over.name,
  };
}

const supplier = (name: string, pctCOGS: number | null, over: Partial<ChainRow> = {}) =>
  row({ name, role: "supplier", pctCOGS, ...over });
const customer = (name: string, pctRevenue: number | null, over: Partial<ChainRow> = {}) =>
  row({ name, role: "customer", pctRevenue, ...over });

describe("concentration", () => {
  it("scores a chain carried by one supplier as highly concentrated", () => {
    const c = concentration([
      supplier("Dominant", 70), supplier("Second", 20), supplier("Third", 10),
    ]);
    expect(c.top1).toBe(70);
    expect(c.top3).toBe(100);
    expect(c.hhi!).toBeGreaterThan(2500);
    expect(hhiBand(c.hhi)).toBe("highly concentrated");
  });

  it("scores an evenly spread chain as diffuse", () => {
    const rows = Array.from({ length: 10 }, (_, i) => supplier(`S${i}`, 10));
    const c = concentration(rows);
    expect(hhiBand(c.hhi)).toBe("diffuse");
    expect(c.effectiveCount).toBeCloseTo(10, 1);
  });

  it("normalises over the QUANTIFIED total, not over 100", () => {
    // Two suppliers at 30% each: they are the whole of what we know, so the
    // effective count is 2 — not 3.3 as it would be if the unmapped 40% were
    // treated as a single silent competitor.
    const c = concentration([supplier("A", 30), supplier("B", 30)]);
    expect(c.effectiveCount).toBeCloseTo(2, 2);
    expect(c.top1).toBe(50);
  });

  it("names single points of failure above the threshold", () => {
    const c = concentration([
      supplier("Critical", 46.6), supplier("Small", 5), supplier("Other", 4),
    ]);
    expect(c.singlePoints.map((s) => s.name)).toEqual(["Critical"]);
    expect(SINGLE_POINT_PCT).toBeLessThan(46.6);
  });

  it("REFUSES to score when too little of the map carries a figure", () => {
    // A concentration score from 2 of 20 edges looks like an answer and is
    // not one.
    const rows = [supplier("A", 40), supplier("B", 30),
                  ...Array.from({ length: 18 }, (_, i) => supplier(`X${i}`, null))];
    const c = concentration(rows);
    expect(c.hhi).toBeNull();
    expect(c.reason).toMatch(/too thin/);
  });

  it("refuses a single relationship", () => {
    expect(concentration([supplier("Only", 100)]).hhi).toBeNull();
  });

  it("handles an empty map", () => {
    const c = concentration([]);
    expect(c.hhi).toBeNull();
    expect(c.reason).toMatch(/No relationships/);
  });

  it("never mixes a supplier's cost share with a customer's revenue share", () => {
    // Different denominators. Adding them produces a number that means
    // nothing, so a customer's revenue share must not enter a supplier's
    // cost-concentration calculation and vice versa.
    const c = concentration([supplier("S", 50), customer("C", 50)]);
    // Both are quantified, each on its own basis, and the pair is symmetric.
    expect(c.quantified).toBe(2);
    expect(c.top1).toBe(50);
  });
});

describe("exposures", () => {
  it("converts a cost share into money using the subject's COGS", () => {
    const { rows, basis } = exposures([supplier("Foxconn", 46.6)],
                                      { revenue: 400e9, cogs: 220e9 });
    expect(rows[0].atRisk).toBeCloseTo(0.466 * 220e9, 0);
    expect(basis).toBe("financials");
  });

  it("converts a revenue share using REVENUE, not COGS", () => {
    const { rows } = exposures([customer("Best Buy", 4.2)],
                               { revenue: 400e9, cogs: 220e9 });
    expect(rows[0].atRisk).toBeCloseTo(0.042 * 400e9, 0);
  });

  it("falls back to the model's own value when financials are missing", () => {
    const { rows, basis } = exposures([supplier("X", 10, { valueUsd: 5e9 })]);
    expect(rows[0].atRisk).toBe(5e9);
    expect(basis).toBe("model");
  });

  it("says so when nothing can be valued at all", () => {
    expect(exposures([supplier("X", null)]).basis).toBe("none");
  });

  it("ranks by money at risk", () => {
    const { rows } = exposures(
      [supplier("Small", 5), supplier("Big", 40)], { cogs: 100e9 });
    expect(rows.map((r) => r.name)).toEqual(["Big", "Small"]);
  });

  it("drops rows that carry neither a share nor a value", () => {
    expect(exposures([supplier("Ghost", null)]).rows).toHaveLength(0);
  });
});

describe("byCountry", () => {
  const { rows } = exposures([
    supplier("A", 40, { country: "TW" }),
    supplier("B", 10, { country: "TW" }),
    supplier("C", 20, { country: "KR" }),
    supplier("D", 5),
  ], { cogs: 100e9 });

  it("aggregates exposure by listing, largest first", () => {
    const out = byCountry(rows);
    expect(out[0].country).toBe("TW");
    expect(out[0].pct).toBe(50);
    expect(out[0].names).toEqual(["A", "B"]);
  });

  it("gives the unknown group a name rather than dropping it", () => {
    expect(byCountry(rows).map((c) => c.country)).toContain("Unlisted / unknown");
  });

  it("sums money at risk per jurisdiction", () => {
    expect(byCountry(rows)[0].atRisk).toBeCloseTo(0.5 * 100e9, 0);
  });
});

describe("tradePlan", () => {
  const { rows } = exposures([
    supplier("Deep", 60, { ticker: "DEEP" }),
    supplier("Thin", 40, { ticker: "THIN" }),
  ], { cogs: 100e9 });

  const liq = {
    DEEP: { days: 1, verdict: "same day", basis_value: 1e9 },   // $1bn/day
    THIN: { days: 1, verdict: "same day", basis_value: 1e6 },   // $1m/day
  };

  it("weights the notional by exposure share", () => {
    const plan = tradePlan(rows, liq, 1e9);
    expect(plan.rows[0].name).toBe("Deep");
    expect(plan.rows[0].notional).toBeCloseTo(0.6e9, 0);
    expect(plan.rows[1].notional).toBeCloseTo(0.4e9, 0);
  });

  it("rescales days to the SIZED leg, not the profile's own notional", () => {
    // $600m at 15% of a $1bn ADV = 4 sessions.
    const plan = tradePlan(rows, liq, 1e9);
    expect(plan.rows[0].days).toBeCloseTo(4, 1);
    expect(plan.rows[0].verdict).toBe("days");
  });

  it("flags the leg that cannot absorb the size", () => {
    const plan = tradePlan(rows, liq, 1e9);
    const thin = plan.rows.find((r) => r.name === "Thin")!;
    expect(thin.verdict).toBe("untradable at size");
    expect(plan.blocked).toBeCloseTo(0.4e9, 0);
    expect(plan.deployable).toBeCloseTo(0.6e9, 0);
  });

  it("the worst leg sets the timeline", () => {
    const plan = tradePlan(rows, liq, 1e9);
    expect(plan.worstDays).toBe(Math.max(...plan.rows.map((r) => r.days!)));
  });

  it("halving the size roughly halves every leg's day count", () => {
    const big = tradePlan(rows, liq, 1e9);
    const small = tradePlan(rows, liq, 5e8);
    expect(small.rows[0].days!).toBeCloseTo(big.rows[0].days! / 2, 2);
  });

  it("skips unlisted counterparties — you cannot trade a private supplier", () => {
    const withPrivate = exposures([
      supplier("Listed", 50, { ticker: "PUB" }), supplier("Private", 50),
    ], { cogs: 100e9 }).rows;
    const plan = tradePlan(withPrivate, {}, 1e9);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].name).toBe("Listed");
  });

  it("has no verdict rather than a good one when liquidity is unknown", () => {
    const plan = tradePlan(rows, {}, 1e9);
    expect(plan.rows.every((r) => r.days === null)).toBe(true);
    expect(plan.rows.every((r) => r.verdict === "unknown")).toBe(true);
    expect(plan.deployable).toBe(0);
  });
});

describe("riskNote", () => {
  it("states coverage before it states a conclusion", () => {
    const rows = [supplier("A", 60), supplier("B", 30), supplier("C", 10)];
    const note = riskNote(concentration(rows), byCountry(exposures(rows).rows));
    expect(note).toMatch(/3 of 3 relationships carry a figure/);
    expect(note).toMatch(/highly concentrated/);
  });

  it("says real concentration is at least this high, never lower", () => {
    const rows = [supplier("A", 60), supplier("B", 30), supplier("C", 10)];
    const note = riskNote(concentration(rows), []);
    expect(note).toMatch(/at least this high, not lower/);
  });

  it("passes the refusal through instead of inventing a reading", () => {
    expect(riskNote(concentration([]), [])).toMatch(/No relationships/);
  });

  it("calls out a jurisdiction holding more than a third of the exposure", () => {
    const rows = [supplier("A", 60, { country: "TW" }), supplier("B", 40, { country: "US" })];
    const note = riskNote(concentration(rows), byCountry(exposures(rows).rows));
    expect(note).toMatch(/one listing jurisdiction \(TW\)/);
  });
});
