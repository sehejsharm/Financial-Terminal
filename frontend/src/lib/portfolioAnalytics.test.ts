import { describe, expect, it } from "vitest";

import {
  attribution, attributionNote, betaBreakdown, betaNote, concentration,
  concentrationNote, historyNote, historyStats, pnlOf, sectorConcentration,
  sortRows, valueOf, type Row,
} from "./portfolioAnalytics";

const pos = (ticker: string, over: Partial<Row> = {}): Row => ({
  ticker, qty: 100, cost: 100, price: 110, sector: "Energy", beta: 1, ...over,
});

describe("valueOf / pnlOf", () => {
  it("prefer the live price over the server's snapshot", () => {
    const r = pos("A", { price: 120, value: 11_000, pnl: 1_000 });
    expect(valueOf(r)).toBe(12_000);
    expect(pnlOf(r)).toBe(2_000);
  });

  it("fall back to the snapshot when there is no price", () => {
    const r = pos("A", { price: null, value: 11_000, pnl: 1_000 });
    expect(valueOf(r)).toBe(11_000);
    expect(pnlOf(r)).toBe(1_000);
  });

  it("return null rather than zero when neither exists", () => {
    const r = pos("A", { price: null, value: null, pnl: null });
    expect(valueOf(r)).toBeNull();
    expect(pnlOf(r)).toBeNull();
  });
});

describe("attribution", () => {
  it("measures share against GROSS movement, not the net", () => {
    // Against the net (+100) a +1000 winner reads 1000% and a −900 loser −900%,
    // which describes nothing. Against gross both did roughly equal work.
    const rows = [
      pos("WIN", { qty: 100, cost: 100, price: 110 }),   // +1000
      pos("LOSE", { qty: 100, cost: 100, price: 91 }),   // -900
    ];
    const a = attribution(rows);
    expect(a.totalPnl).toBeCloseTo(100, 6);
    const win = a.rows.find((c) => c.ticker === "WIN")!;
    const lose = a.rows.find((c) => c.ticker === "LOSE")!;
    expect(win.sharePct).toBeCloseTo((1000 / 1900) * 100, 6);
    expect(lose.sharePct).toBeCloseTo((900 / 1900) * 100, 6);
    // Never negative and never above 100.
    for (const c of a.rows) {
      expect(c.sharePct).toBeGreaterThanOrEqual(0);
      expect(c.sharePct).toBeLessThanOrEqual(100);
    }
  });

  it("ranks winners down and losers up from the worst", () => {
    const a = attribution([
      pos("BIG", { price: 200 }), pos("SMALL", { price: 105 }),
      pos("BAD", { price: 90 }), pos("WORSE", { price: 50 }),
    ]);
    expect(a.winners.map((c) => c.ticker)).toEqual(["BIG", "SMALL"]);
    expect(a.losers.map((c) => c.ticker)).toEqual(["WORSE", "BAD"]);
  });

  it("counts how many positions account for half the movement", () => {
    // One position doing ten times the work of five others.
    const a = attribution([
      pos("DOM", { price: 200 }),
      ...["A", "B", "C", "D", "E"].map((t) => pos(t, { price: 101 })),
    ]);
    expect(a.halfCount).toBe(1);
  });

  it("expresses each position's P&L against the book's cost basis", () => {
    const a = attribution([pos("A", { price: 110 }), pos("B", { price: 100 })]);
    // +1000 on a 20,000 book = +5%.
    expect(a.rows.find((c) => c.ticker === "A")!.bookPct).toBeCloseTo(5, 6);
  });

  it("excludes unpriced positions and says how many", () => {
    const a = attribution([
      pos("A", { price: 110 }),
      pos("NOPRICE", { price: null, value: null, pnl: null }),
    ]);
    expect(a.priced).toBe(1);
    expect(a.total).toBe(2);
    expect(attributionNote(a)).toMatch(/1 position had no price and are excluded|1 position/);
  });

  it("does not divide by zero on a book that hasn't moved", () => {
    const a = attribution([pos("A", { price: 100 }), pos("B", { price: 100 })]);
    expect(a.totalPnl).toBe(0);
    expect(a.rows.every((c) => c.sharePct === 0)).toBe(true);
    expect(a.halfCount).toBeNull();
  });

  it("handles an empty book", () => {
    const a = attribution([]);
    expect(a.priced).toBe(0);
    expect(attributionNote(a)).toMatch(/nothing to attribute/);
  });
});

describe("attributionNote", () => {
  it("calls out a book that is really one position", () => {
    const a = attribution([
      pos("DOM", { price: 500 }),
      ...["A", "B", "C"].map((t) => pos(t, { price: 101 })),
    ]);
    expect(attributionNote(a)).toMatch(/A SINGLE position accounts for half/);
    expect(attributionNote(a)).toMatch(/not the portfolio's/);
  });

  it("says this is not a return", () => {
    const note = attributionNote(attribution([pos("A")]));
    expect(note).toMatch(/excludes closed positions, dividends received/);
    expect(note).toMatch(/it is not your return/);
  });
});

describe("concentration", () => {
  it("catches a book a largest-position threshold would pass", () => {
    // Three at a third each: no position over 30%… and about as concentrated
    // as an equity book can be. Effective count says 3.
    const three = concentration(["A", "B", "C"].map((t) => pos(t, { price: 100 })));
    expect(three.topPct).toBeCloseTo(33.33, 1);
    expect(three.effectiveN!).toBeCloseTo(3, 6);
    expect(three.band).toBe("concentrated");
  });

  it("scores a broad book as diversified", () => {
    const many = concentration(
      Array.from({ length: 40 }, (_, i) => pos(`T${i}`, { price: 100 })));
    expect(many.effectiveN!).toBeCloseTo(40, 6);
    expect(many.band).toBe("diversified");
  });

  it("computes HHI as the sum of squared weights", () => {
    // 50/50 → 0.5² + 0.5² = 0.5, effective 2.
    const c = concentration([
      pos("A", { qty: 100, price: 100 }), pos("B", { qty: 100, price: 100 })]);
    expect(c.hhi).toBeCloseTo(0.5, 8);
    expect(c.effectiveN).toBeCloseTo(2, 8);
  });

  it("weights by market value, so it reads exposure not what was bought", () => {
    const c = concentration([
      pos("BIG", { qty: 100, cost: 10, price: 1000 }),
      pos("SMALL", { qty: 100, cost: 10, price: 10 }),
    ]);
    expect(c.topPct!).toBeCloseTo((1000 / 1010) * 100, 4);
  });

  it("reports cumulative top-3 and top-5 weights", () => {
    const c = concentration(
      Array.from({ length: 10 }, (_, i) => pos(`T${i}`, { price: 100 })));
    expect(c.top3Pct!).toBeCloseTo(30, 6);
    expect(c.top5Pct!).toBeCloseTo(50, 6);
  });

  it("refuses rather than guessing with no priced positions", () => {
    const c = concentration([pos("A", { price: null, value: null })]);
    expect(c.hhi).toBeNull();
    expect(c.band).toBe("unknown");
    expect(concentration([]).band).toBe("unknown");
  });
});

describe("sectorConcentration", () => {
  it("measures the same way over sector weights", () => {
    const s = sectorConcentration([
      { sector: "Energy", weight: 50 }, { sector: "IT", weight: 50 }]);
    expect(s.effectiveN).toBeCloseTo(2, 8);
    expect(s.positions).toBe(2);
  });

  it("ignores zero-weight sectors rather than counting them as holdings", () => {
    const s = sectorConcentration([
      { sector: "Energy", weight: 100 }, { sector: "IT", weight: 0 }]);
    expect(s.positions).toBe(1);
  });
});

describe("concentrationNote", () => {
  const broad = sectorConcentration(
    Array.from({ length: 8 }, (_, i) => ({ sector: `S${i}`, weight: 12.5 })));

  it("explains what the effective count catches that a threshold misses", () => {
    const c = concentration(["A", "B", "C"].map((t) => pos(t, { price: 100 })));
    const note = concentrationNote(c, broad);
    expect(note).toMatch(/behaves like 3\.0 equal-sized ones/);
    expect(note).toMatch(/would clear a “no position over 30%” rule/);
    expect(note).toMatch(/single-name news moves the whole book/);
  });

  it("flags narrow SECTOR exposure separately, since names fall together", () => {
    const c = concentration(
      Array.from({ length: 20 }, (_, i) => pos(`T${i}`, { price: 100 })));
    const narrow = sectorConcentration([{ sector: "IT", weight: 95 },
                                        { sector: "Energy", weight: 5 }]);
    expect(concentrationNote(c, narrow)).toMatch(/Sector exposure is narrower still/);
    expect(concentrationNote(c, narrow)).toMatch(/likely to fall together/);
  });

  it("admits correlation is not measured", () => {
    const c = concentration([pos("A", { price: 100 })]);
    expect(concentrationNote(c, broad))
      .toMatch(/twenty names in one industry is one bet/);
  });

  it("says so with nothing priced", () => {
    expect(concentrationNote(concentration([]), broad))
      .toMatch(/can't be measured/);
  });
});

describe("betaBreakdown", () => {
  it("attributes the weighted beta to the positions supplying it", () => {
    const b = betaBreakdown([
      pos("HIGH", { qty: 100, price: 100, beta: 2 }),
      pos("LOW", { qty: 100, price: 100, beta: 0.5 }),
    ]);
    expect(b.weightedBeta).toBeCloseTo(1.25, 8);
    expect(b.rows[0].ticker).toBe("HIGH");
    expect(b.rows[0].contribution).toBeCloseTo(1, 8);
    // Contributions sum to the weighted beta when coverage is complete.
    expect(b.rows.reduce((a, r) => a + r.contribution, 0)).toBeCloseTo(1.25, 8);
  });

  it("NORMALISES over covered value, not total value", () => {
    // Dividing by total would report 0.5 for a book that is half unmeasured —
    // understating beta exactly in proportion to the provider's gaps.
    const b = betaBreakdown([
      pos("HAS", { qty: 100, price: 100, beta: 1 }),
      pos("NONE", { qty: 100, price: 100, beta: null }),
    ]);
    expect(b.weightedBeta).toBeCloseTo(1, 8);
    expect(b.coveragePct).toBeCloseTo(50, 6);
    expect(b.missing).toEqual(["NONE"]);
  });

  it("returns nothing when no holding carries a beta", () => {
    const b = betaBreakdown([pos("A", { beta: null }), pos("B", { beta: null })]);
    expect(b.weightedBeta).toBeNull();
    expect(betaNote(b)).toMatch(/No holding carries a beta/);
  });

  it("ignores unpriced holdings, which have no weight to contribute", () => {
    const b = betaBreakdown([
      pos("A", { price: 100, beta: 1.5 }),
      pos("GHOST", { price: null, value: null, beta: 3 }),
    ]);
    expect(b.weightedBeta).toBeCloseTo(1.5, 8);
    expect(b.rows).toHaveLength(1);
  });

  it("handles an empty book", () => {
    expect(betaBreakdown([]).weightedBeta).toBeNull();
  });
});

describe("betaNote", () => {
  it("names the two positions supplying most of the beta", () => {
    const b = betaBreakdown([
      pos("A", { qty: 100, price: 200, beta: 2 }),
      pos("B", { qty: 100, price: 150, beta: 1.5 }),
      pos("C", { qty: 100, price: 10, beta: 0.5 }),
    ]);
    const note = betaNote(b);
    expect(note).toMatch(/A and B supply the most of it/);
    expect(note).toMatch(/the part you could actually act on/);
  });

  it("flags partial coverage", () => {
    const b = betaBreakdown([
      pos("HAS", { price: 100, beta: 1 }), pos("NONE", { price: 100, beta: null })]);
    expect(betaNote(b)).toMatch(/Only 50% of book value carries a beta/);
    expect(betaNote(b)).toMatch(/missing: NONE/);
  });

  it("warns that betas converge in a selloff", () => {
    const b = betaBreakdown([pos("A", { price: 100, beta: 1 })]);
    expect(betaNote(b)).toMatch(/betas also rise together in a selloff/i);
    expect(betaNote(b)).toMatch(/backward-looking regression/);
  });
});

describe("historyStats", () => {
  const pts = (vals: number[], costs?: number[]) =>
    vals.map((value, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      value, cost: costs?.[i] ?? 100,
    }));

  it("measures value against cost at the latest point", () => {
    const s = historyStats(pts([100, 110, 120]));
    expect(s.returnPct).toBeCloseTo(20, 6);
  });

  it("finds the deepest peak-to-trough fall, not the last one", () => {
    const s = historyStats(pts([100, 150, 75, 120, 108]));
    expect(s.maxDrawdownPct).toBeCloseTo(-50, 6);
  });

  it("reports the best and worst single steps", () => {
    const s = historyStats(pts([100, 110, 99]));
    expect(s.bestDayPct).toBeCloseTo(10, 6);
    expect(s.worstDayPct).toBeCloseTo(-10, 6);
  });

  it("returns nothing measurable from a single point", () => {
    const s = historyStats(pts([100]));
    expect(s.returnPct).toBeNull();
    expect(s.maxDrawdownPct).toBeNull();
  });

  it("does not divide by a zero cost basis", () => {
    expect(historyStats(pts([100, 110], [0, 0])).returnPct).toBeNull();
  });
});

describe("historyNote", () => {
  it("REFUSES to call these time-weighted returns", () => {
    // Both value and cost step when a position is added, so growth from
    // contributing money is indistinguishable from growth from performance.
    const note = historyNote(historyStats([
      { date: "2026-06-01", value: 100, cost: 100 },
      { date: "2026-06-02", value: 120, cost: 100 },
    ]));
    expect(note).toMatch(/NOT time-weighted returns/);
    expect(note).toMatch(/indistinguishable from growth from performance/);
  });

  it("says a gap is a missing observation, not a flat market", () => {
    const note = historyNote(historyStats([
      { date: "2026-06-01", value: 100, cost: 100 },
      { date: "2026-06-05", value: 105, cost: 100 },
    ]));
    expect(note).toMatch(/gaps are missing observations rather than flat markets/);
  });

  it("surfaces a severe drawdown, which a P&L figure hides", () => {
    const note = historyNote(historyStats([
      { date: "a", value: 100, cost: 100 }, { date: "b", value: 60, cost: 100 },
      { date: "c", value: 105, cost: 100 },
    ]));
    expect(note).toMatch(/what holding this actually felt like/);
  });

  it("explains the shortfall with too little history", () => {
    expect(historyNote(historyStats([{ date: "a", value: 1, cost: 1 }])))
      .toMatch(/not enough of it to measure yet/);
  });
});

describe("sortRows", () => {
  const rows = [
    pos("BBB", { qty: 10, price: 50, pnl_pct: 5 }),
    pos("AAA", { qty: 30, price: 200, pnl_pct: -2 }),
    pos("CCC", { qty: 20, price: null, value: null, pnl: null, pnl_pct: null }),
  ];

  it("sorts by value in both directions", () => {
    expect(sortRows(rows, "value", "desc").map((r) => r.ticker)[0]).toBe("AAA");
    expect(sortRows(rows, "value", "asc").map((r) => r.ticker)[0]).toBe("BBB");
  });

  it("keeps nulls LAST in both directions", () => {
    // A row with no price is unknown, not the smallest — floating it to the top
    // of an ascending sort buries the rows that matter.
    for (const dir of ["asc", "desc"] as const) {
      expect(sortRows(rows, "value", dir).map((r) => r.ticker).pop()).toBe("CCC");
      expect(sortRows(rows, "pnl_pct", dir).map((r) => r.ticker).pop()).toBe("CCC");
    }
  });

  it("sorts tickers alphabetically, not numerically", () => {
    expect(sortRows(rows, "ticker", "asc").map((r) => r.ticker))
      .toEqual(["AAA", "BBB", "CCC"]);
  });

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.ticker);
    sortRows(rows, "qty", "desc");
    expect(rows.map((r) => r.ticker)).toEqual(before);
  });
});
