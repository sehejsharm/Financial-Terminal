import { describe, expect, it } from "vitest";

import {
  compCell, compLabel, HEADER_FIELDS, headerCoverage, isSubject, printedLine,
  provenanceNote,
} from "./tearsheetMeta";

const FULL = {
  market_cap: 19.3e12, trailing_pe: 27.1, beta: 1.15, dividend_yield: 0.0035,
  roe: 0.091, profit_margin: 0.081, debt_to_equity: 36.65, fifty_two_high: 1608,
};

const AT = new Date(Date.UTC(2026, 5, 30, 14, 35));

describe("headerCoverage", () => {
  it("counts the header metrics that actually populated", () => {
    expect(headerCoverage(FULL)).toMatchObject({ filled: 8, total: 8, missing: [] });
  });

  it("names the ones the provider didn't cover", () => {
    const c = headerCoverage({ ...FULL, roe: null, debt_to_equity: undefined });
    expect(c.filled).toBe(6);
    expect(c.missing).toEqual(["ROE", "Debt / equity"]);
  });

  it("treats an empty string and a NaN as missing", () => {
    const c = headerCoverage({ ...FULL, beta: NaN, trailing_pe: "" });
    expect(c.missing).toContain("Beta");
    expect(c.missing).toContain("P/E");
  });

  it("reports everything missing for no snapshot at all", () => {
    expect(headerCoverage(null).missing).toHaveLength(HEADER_FIELDS.length);
  });
});

describe("printedLine", () => {
  it("stamps the print time to the minute, in UTC", () => {
    // A tear sheet outlives its session; a local-time stamp with no zone is
    // ambiguous by the time anyone reads the paper.
    expect(printedLine(AT)).toBe("Printed 2026-06-30 14:35 UTC.");
  });
});

describe("provenanceNote", () => {
  it("REFUSES to let the print time read as the data time", () => {
    // The old sheet stamped "as of <now>" from the browser clock at render.
    // On paper there is no way to tell that apart from a live quote.
    const note = provenanceNote(headerCoverage(FULL), AT);
    expect(note).toMatch(/Printed 2026-06-30 14:35 UTC/);
    expect(note).toMatch(/NOT a quote at the printed time/);
    expect(note).toMatch(/a printed sheet never refreshes/);
  });

  it("says a blank on paper is a coverage gap, not a zero", () => {
    const note = provenanceNote(headerCoverage({ ...FULL, roe: null }), AT);
    expect(note).toMatch(/7 of 8 header metrics populated/);
    expect(note).toMatch(/Missing: ROE/);
    expect(note).toMatch(/not a zero and not a company that lacks the figure/);
  });

  it("stays quiet about gaps when there are none", () => {
    expect(provenanceNote(headerCoverage(FULL), AT))
      .not.toMatch(/header metrics populated/);
  });

  it("always says the comparables are peers, not a curated set", () => {
    expect(provenanceNote(headerCoverage(FULL), AT))
      .toMatch(/peers by sector and exchange rather than a curated set/);
  });
});

describe("compLabel", () => {
  it("gives print-friendly column names", () => {
    expect(compLabel("trailing_pe")).toBe("P/E");
    expect(compLabel("market_cap")).toBe("Market cap");
  });

  it("still shows an unmapped column", () => {
    expect(compLabel("weird_field")).toBe("Weird field");
  });
});

describe("compCell", () => {
  it("humanises a magnitude instead of printing seventeen digits", () => {
    // The failure this fixes: 17768137097216 in a table cell on a page a
    // person is meant to read.
    expect(compCell("market_cap", 17_768_137_097_216, "₹")).toBe("₹17.77T");
    expect(compCell("market_cap", 4.2e9, "$")).toBe("$4.20B");
  });

  it("steps to the next unit when a value rounds up to it", () => {
    // 999,999,000 must not print as "1000.00M".
    expect(compCell("market_cap", 999_999_000)).toBe("1.00B");
  });

  it("reads a provider fraction as a percentage", () => {
    expect(compCell("roe", 0.091)).toBe("9.1%");
    expect(compCell("dividend_yield", 0.0035)).toBe("0.4%");
  });

  it("converts the percent-scaled debt/equity providers send", () => {
    // 36.65 from yfinance means 0.37x, not 3,665%.
    expect(compCell("debt_to_equity", 36.65)).toBe("0.37x");
  });

  it("leaves an ordinary number alone, with separators", () => {
    expect(compCell("trailing_pe", 27.123)).toBe("27.12");
    expect(compCell("price", 1425.6)).toBe("1,425.6");
  });

  it("prints a dash rather than null, undefined or NaN", () => {
    for (const v of [null, undefined, "", NaN, Infinity]) {
      expect(compCell("price", v)).toBe("—");
    }
  });

  it("passes a string through unchanged", () => {
    expect(compCell("name", "Reliance Industries Ltd")).toBe("Reliance Industries Ltd");
  });
});

describe("isSubject", () => {
  it("finds the sheet's own company in the comps table", () => {
    expect(isSubject({ ticker: "RELIANCE.NS" }, "RELIANCE.NS")).toBe(true);
    expect(isSubject({ symbol: "RELIANCE.NS" }, "RELIANCE.NS")).toBe(true);
  });

  it("matches when the feed drops the exchange suffix", () => {
    // The comps endpoint returns bare symbols where the sheet has the
    // qualified one, and vice versa.
    expect(isSubject({ ticker: "RELIANCE" }, "RELIANCE.NS")).toBe(true);
    expect(isSubject({ ticker: "RELIANCE.NS" }, "RELIANCE")).toBe(true);
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(isSubject({ ticker: " reliance.ns " }, "RELIANCE.NS")).toBe(true);
  });

  it("does not match a different company", () => {
    expect(isSubject({ ticker: "TCS.NS" }, "RELIANCE.NS")).toBe(false);
    expect(isSubject({}, "RELIANCE.NS")).toBe(false);
    expect(isSubject({ ticker: "RELIANCE.NS" }, "")).toBe(false);
  });
});
