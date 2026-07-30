import { describe, expect, it } from "vitest";

import {
  columnCoverage, columnNote, coverage, coverageNote, isPercent, labelFor,
  sparseColumns, SPARSE_PCT, type Row,
} from "./screenResult";

const rows = (n: number, make: (i: number) => Row): Row[] =>
  Array.from({ length: n }, (_, i) => make(i));

describe("labelFor", () => {
  it("turns database keys into something readable", () => {
    expect(labelFor("eps_growth")).toBe("EPS growth");
    expect(labelFor("roce")).toBe("Return on capital employed");
    expect(labelFor("mos")).toBe("Margin of safety");
  });

  it("still shows an unmapped column rather than hiding it", () => {
    // Hiding a column is worse than an imperfect label.
    expect(labelFor("some_new_metric")).toBe("Some new metric");
  });
});

describe("isPercent", () => {
  it("knows which columns carry percentages", () => {
    expect(isPercent("roe")).toBe(true);
    expect(isPercent("margin_of_safety")).toBe(true);
    expect(isPercent("pe")).toBe(false);
    expect(isPercent("market_cap")).toBe(false);
  });
});

describe("coverage", () => {
  it("measures the hit rate against what could be EVALUATED", () => {
    // A rate measured over names the screen couldn't read is not a hit rate.
    const c = coverage({ rows: rows(12, () => ({})), scanned: 500, evaluable: 60 });
    expect(c.hitRatePct).toBeCloseTo(20, 6);
    expect(c.evaluableRatePct).toBeCloseTo(12, 6);
  });

  it("reports nulls rather than zeros when the backend didn't say", () => {
    const c = coverage({ rows: rows(3, () => ({})) });
    expect(c.scanned).toBeNull();
    expect(c.hitRatePct).toBeNull();
    expect(c.matched).toBe(3);
  });

  it("does not divide by zero on an empty universe", () => {
    const c = coverage({ rows: [], scanned: 0, evaluable: 0 });
    expect(c.hitRatePct).toBeNull();
    expect(c.evaluableRatePct).toBeNull();
  });
});

describe("coverageNote", () => {
  it("distinguishes a real finding from a data-coverage artefact", () => {
    // 12 of 500 where only 60 were readable is a statement about the provider
    // wearing the costume of a finding.
    const note = coverageNote(coverage({
      rows: rows(12, () => ({})), scanned: 500, evaluable: 60 }));
    expect(note).toMatch(/440 were skipped/);
    expect(note).toMatch(/not names that failed the test/);
    expect(note).toMatch(/a real match may well be among them/);
  });

  it("stays short when coverage is good", () => {
    const note = coverageNote(coverage({
      rows: rows(12, () => ({})), scanned: 500, evaluable: 495 }));
    expect(note).toMatch(/12 matches from 500 names scanned/);
    expect(note).not.toMatch(/were skipped/);
  });

  it("gets the grammar right for a single match", () => {
    expect(coverageNote(coverage({ rows: rows(1, () => ({})), scanned: 100, evaluable: 100 })))
      .toMatch(/1 match from 100 names scanned/);
  });

  it("says the hit rate, so a screen returning everything is visible", () => {
    expect(coverageNote(coverage({
      rows: rows(90, () => ({})), scanned: 100, evaluable: 100 })))
      .toMatch(/90\.0% of what could be evaluated/);
  });

  it("admits when it cannot tell how much was scanned", () => {
    expect(coverageNote(coverage({ rows: rows(5, () => ({})) })))
      .toMatch(/no way to tell whether these are the only matches/);
  });

  it("always says a screen is a starting list, not a conclusion", () => {
    expect(coverageNote(coverage({ rows: [], scanned: 100, evaluable: 100 })))
      .toMatch(/a starting list, not a conclusion/);
  });
});

describe("columnCoverage", () => {
  const data: Row[] = [
    { ticker: "A", roe: 15, roce: null },
    { ticker: "B", roe: 12, roce: null },
    { ticker: "C", roe: null, roce: null },
    { ticker: "D", roe: 9, roce: 22 },
  ];

  it("counts the cells that actually carry a value", () => {
    const c = columnCoverage(data, ["roe", "roce"]);
    expect(c.find((x) => x.key === "roe")).toMatchObject({ filled: 3, total: 4, pct: 75 });
    expect(c.find((x) => x.key === "roce")).toMatchObject({ filled: 1, pct: 25 });
  });

  it("treats an empty string and a NaN as missing, because they are", () => {
    const c = columnCoverage(
      [{ x: "" }, { x: NaN }, { x: 0 }], ["x"]);
    // Zero is a real value; the other two are the provider saying nothing.
    expect(c[0].filled).toBe(1);
  });

  it("carries the human label with each column", () => {
    expect(columnCoverage(data, ["roce"])[0].label).toBe("Return on capital employed");
  });

  it("handles no rows without dividing by zero", () => {
    expect(columnCoverage([], ["roe"])[0]).toMatchObject({ filled: 0, pct: 0 });
  });
});

describe("sparseColumns", () => {
  // `half` is deliberately 40%, not 50: the threshold is strictly-below, so a
  // fixture sitting exactly on it would assert the boundary by accident.
  const data: Row[] = rows(10, (i) => ({
    full: i, half: i < 4 ? i : null, none: null,
  }));

  it("finds the columns reporting provider coverage, not companies", () => {
    const s = sparseColumns(columnCoverage(data, ["full", "half", "none"]));
    expect(s.map((c) => c.key)).toEqual(["none", "half"]);   // emptiest first
  });

  it("leaves a well-populated column alone", () => {
    expect(sparseColumns(columnCoverage(data, ["full"]))).toEqual([]);
  });

  it("uses a threshold that can be moved", () => {
    expect(sparseColumns(columnCoverage(data, ["half"]), 30)).toEqual([]);
    expect(SPARSE_PCT).toBe(50);
  });
});

describe("columnNote", () => {
  const data: Row[] = rows(10, (i) => ({
    roce: null, promoter: i < 3 ? 55 : null, pe: 20 + i,
  }));
  const sparse = sparseColumns(columnCoverage(data, ["roce", "promoter", "pe"]));

  it("says an all-empty column is the FEED, not the companies", () => {
    // The distinction a dash cannot make on its own.
    const note = columnNote(sparse)!;
    expect(note).toMatch(/Return on capital employed is empty for every row/);
    expect(note).toMatch(/the free feed not carrying the field, not the companies/);
  });

  it("warns that sorting a half-empty column ranks the covered names", () => {
    const note = columnNote(sparse)!;
    expect(note).toMatch(/Promoter holding \(30%\)/);
    expect(note).toMatch(/ranks the names the provider happens to cover/);
  });

  it("says nothing when every column is populated", () => {
    expect(columnNote([])).toBeNull();
    const full = sparseColumns(columnCoverage(rows(5, (i) => ({ pe: i })), ["pe"]));
    expect(columnNote(full)).toBeNull();
  });

  it("gets the grammar right for one column versus several", () => {
    const one = sparseColumns(columnCoverage(rows(4, () => ({ roce: null })), ["roce"]));
    expect(columnNote(one)!).toMatch(/is empty for every row/);
    const two = sparseColumns(columnCoverage(
      rows(4, () => ({ roce: null, mos: null })), ["roce", "mos"]));
    expect(columnNote(two)!).toMatch(/are empty for every row/);
  });
});
