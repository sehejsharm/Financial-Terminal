import { describe, expect, it } from "vitest";

import {
  coverage, directionOf, GROUP_ORDER, groupIndicators, groupOf, pillarReports,
  regimeNote, regimeSummary, type MacroIndicator,
} from "./macroRegime";

const ind = (name: string, change: number | null = null,
             stale = false): MacroIndicator => ({
  name, value: 1, prior: 1, change, date: "2026-01-01", unit: "%", stale,
});

const missing = (name: string): MacroIndicator => ({
  name, value: null, prior: null, change: null, date: null, unit: "%",
});

describe("groupOf", () => {
  it("files the obvious ones correctly", () => {
    expect(groupOf("Real GDP")).toBe("growth");
    expect(groupOf("Industrial Production")).toBe("growth");
    expect(groupOf("CPI (YoY)")).toBe("inflation");
    expect(groupOf("Core PCE")).toBe("inflation");
    expect(groupOf("Fed Funds Rate")).toBe("policy");
    expect(groupOf("10Y Treasury Yield")).toBe("policy");
    expect(groupOf("Nonfarm Payrolls")).toBe("labour");
  });

  it("puts the UNEMPLOYMENT RATE under labour, not policy", () => {
    // It contains "rate", and a naive order would file joblessness under
    // interest rates.
    expect(groupOf("Unemployment Rate")).toBe("labour");
    expect(groupOf("Initial Jobless Claims")).toBe("labour");
  });

  it("files the EXTERNAL block before policy", () => {
    // "Real effective exchange rate" contains "rate"; an exchange rate is
    // not a policy rate and must not land under Policy.
    expect(groupOf("Real effective exchange rate")).toBe("external");
    expect(groupOf("USD / INR")).toBe("external");
    expect(groupOf("Current account (% GDP)")).toBe("external");
    expect(groupOf("FX reserves ex-gold (USD)")).toBe("external");
    expect(groupOf("Exports (YoY)")).toBe("external");
  });

  it("keeps money and debt under policy, and output under growth", () => {
    expect(groupOf("M2 money supply (YoY)")).toBe("policy");
    expect(groupOf("Broad money M3 (YoY)")).toBe("policy");
    // Contains "GDP" but is a policy/fiscal level, not an output series.
    expect(groupOf("Federal debt (% GDP)")).toBe("policy");
    expect(groupOf("Nominal GDP (USD)")).toBe("growth");
    expect(groupOf("Housing starts")).toBe("growth");
    expect(groupOf("Composite leading indicator")).toBe("growth");
    expect(groupOf("Initial jobless claims")).toBe("labour");
  });

  it("falls back to 'other' rather than guessing", () => {
    expect(groupOf("Some Novel Series")).toBe("other");
    expect(groupOf("")).toBe("other");
  });

  it("is case insensitive", () => {
    expect(groupOf("real gdp")).toBe("growth");
    expect(groupOf("REAL GDP")).toBe("growth");
  });
});

describe("groupIndicators", () => {
  it("returns groups in the declared order and omits empty ones", () => {
    const out = groupIndicators([ind("CPI"), ind("Real GDP"), ind("Fed Funds Rate")]);
    expect(out.map(([g]) => g)).toEqual(["growth", "inflation", "policy"]);
    for (const [, list] of out) expect(list.length).toBeGreaterThan(0);
  });

  it("keeps every indicator exactly once", () => {
    const inds = [ind("CPI"), ind("Real GDP"), ind("Unemployment Rate"),
                  ind("Mystery Series")];
    const flat = groupIndicators(inds).flatMap(([, l]) => l);
    expect(flat).toHaveLength(inds.length);
    expect(new Set(flat.map((i) => i.name)).size).toBe(inds.length);
  });

  it("handles an empty list", () => {
    expect(groupIndicators([])).toEqual([]);
  });

  it("only ever emits declared groups", () => {
    for (const [g] of groupIndicators([ind("x"), ind("CPI"), ind("GDP")])) {
      expect(GROUP_ORDER).toContain(g);
    }
  });
});

describe("directionOf", () => {
  it("rising unemployment and inflation are bad; falling is good", () => {
    expect(directionOf("Unemployment Rate", 0.3)).toBe("bad");
    expect(directionOf("Unemployment Rate", -0.3)).toBe("good");
    expect(directionOf("CPI (YoY)", 0.4)).toBe("bad");
    expect(directionOf("CPI (YoY)", -0.4)).toBe("good");
  });

  it("rising growth is good", () => {
    expect(directionOf("Real GDP", 0.5)).toBe("good");
    expect(directionOf("Industrial Production", -0.5)).toBe("bad");
  });

  it("REFUSES to sign a rate or an exchange rate", () => {
    // "Rates went up" is not good or bad without a view; asserting one
    // would colour the card on an opinion the data doesn't carry.
    expect(directionOf("Fed Funds Rate", 0.25)).toBe("neutral");
    expect(directionOf("10Y Treasury Yield", -0.2)).toBe("neutral");
    expect(directionOf("USD/INR", 0.5)).toBe("neutral");
    expect(directionOf("Anything Unknown", 1)).toBe("neutral");
  });

  it("treats a missing or zero change as neutral", () => {
    expect(directionOf("Real GDP", null)).toBe("neutral");
    expect(directionOf("Real GDP", 0)).toBe("neutral");
    expect(directionOf("Real GDP", Number.NaN)).toBe("neutral");
  });
});

describe("regimeSummary", () => {
  it("counts directions and staleness", () => {
    const r = regimeSummary([
      ind("Real GDP", 0.4),                 // good
      ind("Unemployment Rate", 0.2),        // bad
      ind("Fed Funds Rate", 0.25),          // neutral
      ind("CPI", -0.1, true),               // good, stale
    ]);
    expect(r).toEqual({ good: 2, bad: 1, neutral: 1, stale: 1, n: 4 });
  });

  it("every indicator lands in exactly one bucket", () => {
    const inds = [ind("Real GDP", 1), ind("CPI", 1), ind("Fed Funds Rate", 1),
                  ind("Unknown", null)];
    const r = regimeSummary(inds);
    expect(r.good + r.bad + r.neutral).toBe(r.n);
  });

  it("handles an empty list", () => {
    expect(regimeSummary([])).toEqual({ good: 0, bad: 0, neutral: 0, stale: 0, n: 0 });
  });
});

describe("directionOf — external series", () => {
  it("signs reserves, the current account and exports", () => {
    expect(directionOf("FX reserves ex-gold (USD)", 1)).toBe("good");
    expect(directionOf("Current account (% GDP)", -1)).toBe("bad");
    expect(directionOf("Exports (YoY)", 2)).toBe("good");
  });

  it("leaves IMPORTS and the exchange rate unsigned", () => {
    // Rising imports can be healthy domestic demand or a widening deficit;
    // a weaker rupee helps exporters and hurts importers. Neither carries a
    // sign on its own.
    expect(directionOf("Imports (YoY)", 3)).toBe("neutral");
    expect(directionOf("Real effective exchange rate", -1)).toBe("neutral");
    expect(directionOf("Federal debt (% GDP)", 1)).toBe("neutral");
  });
});

describe("pillarReports", () => {
  it("reports one entry per non-empty group, in declared order", () => {
    const p = pillarReports([ind("Real GDP", 1), ind("CPI", 1),
                             ind("USD / INR", 1)]);
    expect(p.map((x) => x.group)).toEqual(["growth", "inflation", "external"]);
  });

  it("leans with the balance and stays null when nothing is signed", () => {
    const [growth, policy] = pillarReports([
      ind("Real GDP", 1), ind("Industrial Production", 1),
      ind("Fed Funds Rate", 0.25),
    ]);
    expect(growth.lean).toBe("improving");
    expect(policy.lean).toBeNull();
  });

  it("counts series that reported NOTHING separately from neutral ones", () => {
    // A missing series is not a neutral reading — it's an absent one, and
    // folding the two together would overstate how much is known.
    const [p] = pillarReports([ind("Real GDP", 1), missing("Industrial Production")]);
    expect(p.missing).toBe(1);
    expect(p.n).toBe(2);
  });

  it("handles an empty list", () => {
    expect(pillarReports([])).toEqual([]);
  });
});

describe("coverage", () => {
  it("counts series that actually reported a value", () => {
    expect(coverage([ind("CPI"), missing("Exports"), missing("Imports")]))
      .toEqual({ reported: 1, total: 3, pct: (1 / 3) * 100 });
  });

  it("does not divide by zero", () => {
    expect(coverage([])).toEqual({ reported: 0, total: 0, pct: 0 });
  });
});

describe("regimeNote", () => {
  it("says so when there is nothing to read", () => {
    expect(regimeNote(regimeSummary([]))).toMatch(/No indicators/);
  });

  it("does not claim a direction when none of the series carry one", () => {
    const note = regimeNote(regimeSummary([ind("Fed Funds Rate", 0.25)]));
    expect(note).toMatch(/no clear directional reading|none with a clear/i);
    expect(note).not.toMatch(/improving|deteriorating/);
  });

  it("STATES ITS OWN LIMITS rather than presenting a count as a forecast", () => {
    const note = regimeNote(regimeSummary([ind("Real GDP", 1), ind("CPI", 1)]));
    expect(note).toMatch(/not a forecast/i);
    expect(note).toMatch(/magnitude/i);
  });

  it("reports the balance and mentions stale series", () => {
    const note = regimeNote(regimeSummary([
      ind("Real GDP", 1), ind("Industrial Production", 1),
      ind("CPI", 1, true),
    ]));
    expect(note).toMatch(/improving/);
    expect(note).toMatch(/1 of them are stale|1 of them is stale|1 of them are stale\./);
  });
});
