import { describe, expect, it } from "vitest";

import {
  cadenceLabel, inferCadence, PERIODS_PER_YEAR, readCadence,
} from "./statementCadence";

const QUARTERS = ["2023-12-31", "2024-03-31", "2024-06-30", "2024-09-30",
                  "2024-12-31"];
const YEARS = ["2021-03-31", "2022-03-31", "2023-03-31", "2024-03-31"];

const st = (columns: string[], over: Record<string, unknown> = {}) =>
  ({ columns, rows: [{ line: "Revenue" }], ...over });

describe("inferCadence", () => {
  it("reads quarter-end columns as quarterly", () => {
    expect(inferCadence(QUARTERS)).toBe("quarterly");
  });

  it("reads year-end columns as annual", () => {
    expect(inferCadence(YEARS)).toBe("annual");
  });

  it("puts a half-yearly filer on the ANNUAL side", () => {
    // A half-year is not a quarter, and annualising it at four would double
    // every growth rate.
    expect(inferCadence(["2023-09-30", "2024-03-31", "2024-09-30"]))
      .toBe("annual");
  });

  it("REFUSES to guess from a single column", () => {
    // One date has no spacing to measure; a guess here is invention.
    expect(inferCadence(["2024-12-31"])).toBeNull();
    expect(inferCadence([])).toBeNull();
  });

  it("ignores columns that are not dates", () => {
    expect(inferCadence(["TTM", "n/a"])).toBeNull();
  });
});

describe("readCadence", () => {
  it("catches quarters served under an annual request", () => {
    // The reported bug: the Annual toggle showing quarter-end dates.
    const c = readCadence([st(QUARTERS)], "annual");
    expect(c.actual).toBe("quarterly");
    expect(c.mismatch).toBe(true);
    expect(c.note).toMatch(/columns are QUARTERS, not financial years/);
  });

  it("annualises growth on what is ON SCREEN, not what was asked", () => {
    // The damaging half: four quarters compounded at one period per year
    // reports a fourfold overstatement in the same type as a real figure.
    expect(readCadence([st(QUARTERS)], "annual").periodsPerYear).toBe(4);
    expect(readCadence([st(YEARS)], "annual").periodsPerYear).toBe(1);
  });

  it("is silent when the request and the data agree", () => {
    const c = readCadence([st(YEARS)], "annual");
    expect(c.mismatch).toBe(false);
    expect(c.note).toBeNull();
  });

  it("labels the toggle with what is on screen", () => {
    expect(cadenceLabel(readCadence([st(QUARTERS)], "annual"))).toBe("Quarterly");
    expect(cadenceLabel(readCadence([st(YEARS)], "annual"))).toBe("Annual");
  });

  it("prefers the columns over a flag that disagrees with them", () => {
    // The columns are ground truth; a stale flag cannot override them.
    const c = readCadence([st(QUARTERS, { quarterly: false })], "annual");
    expect(c.actual).toBe("quarterly");
  });

  it("falls back to the server flag when columns cannot be measured", () => {
    const c = readCadence([st(["2024-12-31"], { quarterly: true })], "annual");
    expect(c.actual).toBe("quarterly");
    expect(c.mismatch).toBe(true);
  });

  it("skips empty statements when deciding", () => {
    const empty = { columns: [], rows: [], quarterly: true };
    const c = readCadence([empty, st(YEARS)], "annual");
    expect(c.actual).toBe("annual");
  });

  it("claims no mismatch when there is no data at all", () => {
    // Nothing arrived, so there is nothing to contradict the request — an
    // empty panel must not also accuse the toggle of lying.
    const c = readCadence([{ columns: [], rows: [] }], "annual");
    expect(c.mismatch).toBe(false);
    expect(c.actual).toBe("annual");
  });

  it("exposes the divisors it uses", () => {
    expect(PERIODS_PER_YEAR).toEqual({ annual: 1, quarterly: 4 });
  });
});
