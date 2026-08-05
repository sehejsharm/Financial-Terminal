import { describe, expect, it } from "vitest";

import { missingTrendNote, splitPopulated, type TrendRow } from "./debtTrend";

const row = (label: string, values: (number | null)[]): TrendRow =>
  ({ label, values, kind: "money" });

describe("splitPopulated", () => {
  it("keeps rows that have at least one value", () => {
    const s = splitPopulated([row("Total debt", [null, 5, null])]);
    expect(s.shown.map((r) => r.label)).toEqual(["Total debt"]);
    expect(s.missing).toEqual([]);
  });

  it("drops a row that is empty in every period", () => {
    // The reported bug rendered exactly this as a line of dashes, which reads
    // as a broken panel rather than as absent data.
    const s = splitPopulated([row("Total debt", [null, null])]);
    expect(s.shown).toEqual([]);
    expect(s.missing).toEqual(["Total debt"]);
  });

  it("treats a row of zeroes as present, not missing", () => {
    // Zero debt is a fact about the company; null is a fact about the feed.
    const s = splitPopulated([row("Total debt", [0, 0])]);
    expect(s.shown).toHaveLength(1);
  });

  it("reports the table as empty only when nothing survived", () => {
    expect(splitPopulated([row("a", [null])]).empty).toBe(true);
    expect(splitPopulated([row("a", [1])]).empty).toBe(false);
  });

  it("keeps the original order of what is missing", () => {
    const s = splitPopulated([
      row("Total debt", [null]), row("Free cash flow", [3]), row("Cash", [null]),
    ]);
    expect(s.missing).toEqual(["Total debt", "Cash"]);
  });
});

describe("missingTrendNote", () => {
  it("says nothing when nothing is missing", () => {
    expect(missingTrendNote([])).toBeNull();
  });

  it("explains why the cards can be populated while the history is not", () => {
    // This is the discrepancy the user saw: both were correct, and they come
    // from different endpoints.
    const n = missingTrendNote(["Total debt", "Cash", "Net debt"]) ?? "";
    expect(n).toMatch(/no balance sheet is available/);
    expect(n).toMatch(/cards above are still right/);
    expect(n).toMatch(/point-in-time capital-structure lookup/);
  });

  it("passes the server's own explanation through", () => {
    const n = missingTrendNote(["Total debt"], "NSE carries no balance sheet.");
    expect(n).toMatch(/NSE carries no balance sheet\./);
  });

  it("uses generic wording for rows that are not balance-sheet lines", () => {
    const n = missingTrendNote(["Interest cover"]) ?? "";
    expect(n).toMatch(/Not shown over time: Interest cover/);
    expect(n).not.toMatch(/balance sheet is available/);
  });
});
