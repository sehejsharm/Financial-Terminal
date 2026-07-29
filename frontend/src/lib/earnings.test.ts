import { describe, expect, it } from "vitest";

import {
  parseSurprises, surpriseNote, surpriseSummary, type Frameish,
} from "./earnings";

function frame(rows: Array<[string, number | null, number | null]>,
               cols = ["quarter", "epsActual", "epsEstimate"]): Frameish {
  return {
    columns: cols,
    rows: rows.map(([q, a, e]) => ({ [cols[0]]: q, [cols[1]]: a, [cols[2]]: e })),
  };
}

describe("parseSurprises", () => {
  it("computes the difference and the percentage against the estimate", () => {
    const [r] = parseSurprises(frame([["2025-03-31", 1.20, 1.00]]));
    expect(r.diff).toBeCloseTo(0.20, 6);
    expect(r.surprisePct).toBeCloseTo(20, 6);
    expect(r.beat).toBe(true);
  });

  it("uses the estimate's MAGNITUDE so a smaller loss reads as a beat", () => {
    // Expected to lose 0.50, lost 0.40. That is a 20% beat. Dividing by the
    // signed estimate would report it as −20%, which is exactly backwards.
    const [r] = parseSurprises(frame([["2025-03-31", -0.40, -0.50]]));
    expect(r.beat).toBe(true);
    expect(r.surprisePct).toBeCloseTo(20, 6);
  });

  it("reports a deeper loss as a miss", () => {
    const [r] = parseSurprises(frame([["2025-03-31", -0.70, -0.50]]));
    expect(r.beat).toBe(false);
    expect(r.surprisePct).toBeCloseTo(-40, 6);
  });

  it("returns null rather than infinity when the estimate is zero", () => {
    // An infinity would dominate every average it entered.
    const [r] = parseSurprises(frame([["2025-03-31", 0.10, 0]]));
    expect(r.surprisePct).toBeNull();
    expect(r.beat).toBe(true);
  });

  it("sorts oldest first whatever order the provider sent", () => {
    const rows = parseSurprises(frame([
      ["2025-03-31", 1, 1], ["2023-03-31", 1, 1], ["2024-03-31", 1, 1],
    ]));
    expect(rows.map((r) => r.period))
      .toEqual(["2023-03-31", "2024-03-31", "2025-03-31"]);
  });

  it("drops a period missing either side rather than defaulting it", () => {
    // A quarter with no estimate cannot be a beat or a miss.
    const rows = parseSurprises(frame([
      ["2025-03-31", 1.2, null], ["2024-03-31", null, 1.0], ["2023-03-31", 1.1, 1.0],
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0].period).toBe("2023-03-31");
  });

  it("finds the columns under other provider names", () => {
    const f = frame([["Q1", 2, 1.5]], ["period", "reportedEPS", "consensus"]);
    expect(parseSurprises(f)).toHaveLength(1);
  });

  it("parses numeric strings", () => {
    const f: Frameish = {
      columns: ["quarter", "epsActual", "epsEstimate"],
      rows: [{ quarter: "2025-03-31", epsActual: "1,200", epsEstimate: "1,000" }],
    };
    expect(parseSurprises(f)[0].surprisePct).toBeCloseTo(20, 6);
  });

  it("returns nothing for an empty or unrecognisable frame", () => {
    expect(parseSurprises(null)).toEqual([]);
    expect(parseSurprises({ columns: [], rows: [] })).toEqual([]);
    expect(parseSurprises({ columns: ["a", "b"], rows: [{ a: 1, b: 2 }] })).toEqual([]);
  });
});

describe("surpriseSummary", () => {
  const rows = parseSurprises(frame([
    ["2024-03-31", 1.10, 1.00],   // +10%
    ["2024-06-30", 0.90, 1.00],   // −10%
    ["2024-09-30", 1.00, 1.00],   //  in line
    ["2024-12-31", 1.30, 1.00],   // +30%
    ["2025-03-31", 1.20, 1.00],   // +20%
  ]));
  const s = surpriseSummary(rows);

  it("counts beats, misses and IN-LINE separately", () => {
    // An exact match is neither a beat nor a miss, and counting it as a miss
    // understates every hit rate.
    expect(s.beats).toBe(3);
    expect(s.misses).toBe(1);
    expect(s.inLine).toBe(1);
    expect(s.beatRatePct).toBeCloseTo(60, 6);
  });

  it("reports the median as well as the mean", () => {
    expect(s.medianSurprisePct).toBeCloseTo(10, 6);
    expect(s.meanSurprisePct).toBeCloseTo(10, 6);
  });

  it("the median resists an outlier that wrecks the mean", () => {
    // One quarter with a tiny estimate produces a 400% surprise.
    const skewed = surpriseSummary(parseSurprises(frame([
      ["2024-03-31", 1.05, 1.00], ["2024-06-30", 1.10, 1.00],
      ["2024-09-30", 1.02, 1.00], ["2024-12-31", 0.50, 0.10],
    ])));
    expect(skewed.medianSurprisePct!).toBeLessThan(20);
    expect(skewed.meanSurprisePct!).toBeGreaterThan(80);
  });

  it("takes the latest period as the most recent print", () => {
    expect(s.latest!.period).toBe("2025-03-31");
  });

  it("counts the current beat streak backwards from the latest", () => {
    expect(s.currentStreak).toBe(2);   // Dec and Mar; Sep was in line
  });

  it("handles an empty record", () => {
    const e = surpriseSummary([]);
    expect(e.n).toBe(0);
    expect(e.beatRatePct).toBeNull();
    expect(e.latest).toBeNull();
  });
});

describe("surpriseNote", () => {
  it("refuses to call a pattern from too few periods", () => {
    const s = surpriseSummary(parseSurprises(frame([
      ["2025-03-31", 1.2, 1.0], ["2024-12-31", 1.1, 1.0],
    ])));
    expect(surpriseNote(s)).toMatch(/too few to call a pattern/i);
  });

  it("says what a high hit rate actually means", () => {
    // A company that beats every quarter is usually guiding conservatively,
    // and that changes what the next beat is worth.
    const s = surpriseSummary(parseSurprises(frame([
      ["2024-03-31", 1.1, 1.0], ["2024-06-30", 1.1, 1.0],
      ["2024-09-30", 1.1, 1.0], ["2024-12-31", 1.1, 1.0],
    ])));
    const note = surpriseNote(s);
    expect(note).toMatch(/guides conservatively/i);
    expect(note).toMatch(/4 consecutive beats/);
    expect(note).toMatch(/100% hit rate/);
  });

  it("says so when there is nothing to summarise", () => {
    expect(surpriseNote(surpriseSummary([]))).toMatch(/no surprise history/i);
  });
});
