import { describe, expect, it } from "vitest";

import {
  boardNote, breadth, FLAT_PCT, groupBreadth, MIN_COVERAGE_PCT, riskTone,
  type Tile,
} from "./globalBoard";

const t = (sym: string, changePct: number | null): Tile => ({ sym, changePct });

describe("breadth", () => {
  it("counts advancing, declining, flat and unpriced separately", () => {
    const b = breadth([t("A", 1.2), t("B", -0.8), t("C", 0.02), t("D", null)]);
    expect(b).toMatchObject({ up: 1, down: 1, flat: 1, unpriced: 1, total: 4 });
  });

  it("treats a move smaller than the spread as flat, not a direction", () => {
    expect(breadth([t("A", FLAT_PCT / 2)]).flat).toBe(1);
    expect(breadth([t("A", -FLAT_PCT / 2)]).flat).toBe(1);
    expect(breadth([t("A", FLAT_PCT * 2)]).up).toBe(1);
  });

  it("measures the advance share against PRICED tiles, not the total", () => {
    // A share diluted by tiles that never loaded is a statement about the
    // data feed, not about the market.
    const b = breadth([t("A", 1), t("B", 1), t("C", -1), t("D", null), t("E", null)]);
    expect(b.advancePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(b.coveragePct).toBeCloseTo(60, 6);
  });

  it("averages only over tiles that priced", () => {
    expect(breadth([t("A", 2), t("B", 4), t("C", null)]).averagePct)
      .toBeCloseTo(3, 6);
  });

  it("treats a NaN change as unpriced", () => {
    expect(breadth([t("A", NaN)]).unpriced).toBe(1);
  });

  it("returns nulls rather than zeros when nothing priced", () => {
    const b = breadth([t("A", null), t("B", null)]);
    expect(b.advancePct).toBeNull();
    expect(b.averagePct).toBeNull();
    expect(b.coveragePct).toBe(0);
  });

  it("handles an empty board", () => {
    expect(breadth([]).coveragePct).toBeNull();
  });
});

describe("groupBreadth", () => {
  it("keeps each group's title with its own counts", () => {
    const gs = groupBreadth([
      { title: "Americas", tiles: [t("A", 1), t("B", 1)] },
      { title: "Europe", tiles: [t("C", -1)] },
    ]);
    expect(gs.map((g) => g.title)).toEqual(["Americas", "Europe"]);
    expect(gs[0].breadth.up).toBe(2);
    expect(gs[1].breadth.down).toBe(1);
  });
});

describe("riskTone", () => {
  const eqUp = [t("^GSPC", 0.9), t("^IXIC", 1.2), t("^FTSE", 0.5)];
  const eqDown = eqUp.map((x) => ({ ...x, changePct: -x.changePct! }));

  it("calls equities up with volatility down risk-on", () => {
    const r = riskTone(eqUp, [t("^VIX", -6)]);
    expect(r.tone).toBe("risk-on");
    expect(r.read).toMatch(/describes today's tape and forecasts nothing/);
  });

  it("calls equities down with volatility up risk-off", () => {
    const r = riskTone(eqDown, [t("^VIX", 12)]);
    expect(r.tone).toBe("risk-off");
    // ...and warns that correlations rise exactly then.
    expect(r.read).toMatch(/diversification implied by holding several of these is smaller/);
  });

  it("refuses a clean read when equities and volatility disagree", () => {
    const r = riskTone(eqUp, [t("^VIX", 9)]);
    expect(r.tone).toBe("mixed");
    expect(r.read).toMatch(/no clean risk-on or risk-off read/);
  });

  it("calls a barely-moving tape mixed rather than picking a side", () => {
    expect(riskTone([t("^GSPC", 0.05), t("^IXIC", -0.02), t("^FTSE", 0.01)],
                    [t("^VIX", 0.2)]).tone).toBe("mixed");
  });

  it("WITHHOLDS a verdict when too few tiles priced", () => {
    // A board with most tiles unpriced looks very like a calm market.
    const r = riskTone([t("^GSPC", 1), t("^IXIC", null), t("^FTSE", null),
                        t("^N225", null)], [t("^VIX", -5)]);
    expect(r.tone).toBe("unknown");
    expect(r.read).toMatch(/too little to characterise the tape/);
    expect(r.read).toMatch(/looks very like a calm market/);
  });

  it("still reads the tape without any volatility tile at all", () => {
    expect(riskTone(eqUp, []).tone).toBe("risk-on");
    expect(riskTone(eqDown, []).tone).toBe("risk-off");
  });

  it("uses a coverage floor that is stated, not hidden", () => {
    expect(MIN_COVERAGE_PCT).toBe(60);
  });
});

describe("boardNote", () => {
  const tiles = [t("A", 1), t("B", -1), t("C", 0.01), t("D", null)];
  const note = () => boardNote(breadth(tiles),
    riskTone([t("^GSPC", 0.9), t("^IXIC", 1.1)], [t("^VIX", -5)]));

  it("counts the tiles that never priced, rather than footnoting it", () => {
    expect(note()).toMatch(/3 of 4 tiles priced/);
    expect(note()).toMatch(/1 never loaded/);
    expect(note()).toMatch(/looks very like a quiet one/);
  });

  it("explains why the advance share is measured against priced tiles", () => {
    expect(note()).toMatch(/% of PRICED tiles up/);
    expect(note()).toMatch(/a statement about the feed/);
  });

  it("says why commodities are excluded from the risk read", () => {
    expect(note()).toMatch(/risk-on in a demand story and risk-off in a supply shock/);
  });

  it("says markets in different sessions aren't measuring the same period", () => {
    expect(note()).toMatch(/not measuring the same period/);
  });

  it("carries the risk read through", () => {
    expect(note()).toMatch(/risk-on shape/);
  });

  it("says nothing about coverage when every tile priced", () => {
    const full = boardNote(breadth([t("A", 1), t("B", -1)]),
      riskTone([t("^GSPC", 0.9), t("^IXIC", 1.1)], []));
    expect(full).not.toMatch(/tiles priced/);
  });
});
