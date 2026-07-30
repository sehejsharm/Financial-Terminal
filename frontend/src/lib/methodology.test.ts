import { describe, expect, it } from "vitest";

import { METHODOLOGY, type Methodology } from "./methodology";

const entries = Object.entries(METHODOLOGY) as [string, Methodology][];

describe("methodology registry", () => {
  it("covers every model-derived figure the app renders", () => {
    // If a screen starts computing something new, it belongs here. This list
    // is the contract, not a snapshot.
    for (const key of ["wacc", "greeks", "stress", "sectorRating",
                       "riskMetrics", "valueChain", "chainExposure", "financials",
                       "comparables", "street", "ownership",
                       "aiAnalysis"]) {
      expect(Object.keys(METHODOLOGY)).toContain(key);
    }
  });

  it.each(entries)("%s states what it does NOT capture", (_k, m) => {
    // The whole point. A model nobody can see the edges of gets trusted
    // past them, so an empty limits list is a failed entry.
    expect(m.limits.length).toBeGreaterThan(0);
    for (const l of m.limits) expect(l.trim().length).toBeGreaterThan(20);
  });

  it.each(entries)("%s names its inputs and assumptions", (_k, m) => {
    expect(m.inputs.length).toBeGreaterThan(0);
    expect(m.assumptions.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s explains itself in one readable sentence", (_k, m) => {
    expect(m.what.length).toBeGreaterThan(30);
    expect(m.what.trim().endsWith(".")).toBe(true);
  });

  it.each(entries)("%s declares how the number was produced", (_k, m) => {
    expect(["computed", "model", "ai"]).toContain(m.kind);
  });

  it("labels AI output as AI, not as computation", () => {
    // A generated map and an arithmetic mean deserve different trust, and
    // the badge is what carries that distinction to the reader.
    expect(METHODOLOGY.valueChain.kind).toBe("ai");
    expect(METHODOLOGY.aiAnalysis.kind).toBe("ai");
    expect(METHODOLOGY.sectorRating.kind).toBe("computed");
    expect(METHODOLOGY.stress.kind).toBe("computed");
  });

  it("says outright that AI output is not filing-sourced", () => {
    const text = METHODOLOGY.valueChain.limits.join(" ").toLowerCase();
    expect(text).toMatch(/not sourced from filings|generated content/);
  });

  it("does not hedge the trend-following limitation of sector ratings", () => {
    expect(METHODOLOGY.sectorRating.limits.join(" ")).toMatch(/turns late/);
  });

  it("warns that historical VaR cannot exceed the worst sampled loss", () => {
    expect(METHODOLOGY.riskMetrics.limits.join(" ").toLowerCase())
      .toMatch(/worst one in the sample|cannot show/);
  });
});
