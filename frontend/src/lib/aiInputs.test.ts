import { describe, expect, it } from "vitest";

import {
  EXPECTED_FIELDS, groupInputs, inputCount, inputsNote, labelFor, missingInputs,
} from "./aiInputs";

const FULL = {
  market_cap: "₹17.77T", trailing_pe: 27.12, revenue: "₹9.74T",
  profit_margin: "8.12%", roe: "9.10%", debt_to_equity: "0.37x",
  free_cashflow: "₹500B", revenue_growth: "9.20%",
  beta: 1.15, total_debt: "₹3.24T", sector: "Energy",
};

describe("labelFor", () => {
  it("uses the same wording as the fundamentals screens", () => {
    expect(labelFor("roce")).toBe("Return on capital employed");
    expect(labelFor("debt_to_equity")).toBe("Debt / equity");
  });

  it("makes something readable out of an unmapped key rather than hiding it", () => {
    // Hiding an input is the exact thing this module exists to prevent.
    expect(labelFor("some_new_field")).toBe("Some new field");
  });
});

describe("groupInputs", () => {
  it("groups the figures the way the rest of the app groups them", () => {
    const gs = groupInputs(FULL);
    expect(gs.map((g) => g.group)).toContain("Size & valuation");
    expect(gs.map((g) => g.group)).toContain("Returns & margins");
    const val = gs.find((g) => g.group === "Size & valuation")!;
    expect(val.rows.map((r) => r.key)).toEqual(["market_cap", "trailing_pe"]);
  });

  it("puts an unrecognised field in Other instead of dropping it", () => {
    const gs = groupInputs({ ...FULL, mystery_metric: 42 });
    const other = gs.find((g) => g.group === "Other")!;
    expect(other.rows.map((r) => r.key)).toContain("mystery_metric");
  });

  it("keeps every non-empty input somewhere", () => {
    const inputs = { ...FULL, mystery_metric: 42 };
    const shown = groupInputs(inputs).flatMap((g) => g.rows.map((r) => r.key));
    expect(new Set(shown).size).toBe(Object.keys(inputs).length);
  });

  it("skips null and empty values rather than rendering a blank row", () => {
    const gs = groupInputs({ market_cap: "₹1T", trailing_pe: "", roe: null as never });
    const keys = gs.flatMap((g) => g.rows.map((r) => r.key));
    expect(keys).toEqual(["market_cap"]);
  });

  it("emits no groups for nothing", () => {
    expect(groupInputs(null)).toEqual([]);
    expect(groupInputs({})).toEqual([]);
  });

  it("never emits an empty group", () => {
    for (const g of groupInputs(FULL)) expect(g.rows.length).toBeGreaterThan(0);
  });
});

describe("missingInputs", () => {
  it("names the figures an equity analysis ought to have had and didn't", () => {
    // The important half: a model given no margin still writes a plausible
    // paragraph about profitability, and only naming the gap lets a reader
    // discount it.
    const partial = { market_cap: "₹17.77T", trailing_pe: 27.12 };
    const missing = missingInputs(partial);
    expect(missing).toContain("Profit margin");
    expect(missing).toContain("Return on equity");
    expect(missing).not.toContain("Market cap");
  });

  it("is empty when the model had everything expected", () => {
    expect(missingInputs(FULL)).toEqual([]);
  });

  it("counts an empty string as missing, not as supplied", () => {
    expect(missingInputs({ ...FULL, roe: "" })).toEqual(["Return on equity"]);
  });

  it("checks a sensible list", () => {
    expect(EXPECTED_FIELDS).toContain("profit_margin");
    expect(EXPECTED_FIELDS).toContain("debt_to_equity");
  });
});

describe("inputCount", () => {
  it("counts only the figures that are actually present", () => {
    expect(inputCount(FULL)).toBe(Object.keys(FULL).length);
    expect(inputCount({ a: 1, b: "", c: null as never })).toBe(1);
    expect(inputCount(null)).toBe(0);
  });
});

describe("inputsNote", () => {
  it("says the listed figures are the whole of what the model knew", () => {
    const note = inputsNote(FULL);
    expect(note).toMatch(/the whole of what it knew/);
    expect(note).toMatch(/the model produced it rather than read it/);
  });

  it("names the gaps and tells the reader to discount claims about them", () => {
    const note = inputsNote({ market_cap: "₹1T" });
    expect(note).toMatch(/It did NOT have: /);
    expect(note).toMatch(/Profit margin/);
    expect(note).toMatch(/will still write a paragraph about profitability/);
  });

  it("stays quiet about gaps when there aren't any", () => {
    expect(inputsNote(FULL)).not.toMatch(/It did NOT have/);
  });

  it("says the analysis can't be checked at all when no inputs were reported", () => {
    const note = inputsNote(null);
    expect(note).toMatch(/nothing in the analysis can be checked/);
    expect(note).toMatch(/unverified/);
  });

  it("notes that an upstream data error becomes a confident sentence", () => {
    expect(inputsNote(FULL)).toMatch(/becomes a confident sentence here/);
  });
});
