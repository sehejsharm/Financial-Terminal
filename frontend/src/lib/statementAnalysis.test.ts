import { describe, expect, it } from "vitest";

import {
  cagr, chronological, coverageNote, findRow, qualityFlags, ratioSeries,
  seriesFor, sharedColumns, yoy, type Statementish, type Statements,
} from "./statementAnalysis";

/** Build a statement the way a provider hands one over: newest column first. */
function st(rows: Record<string, (number | null)[]>, cols: string[]): Statementish {
  return {
    columns: [...cols].reverse(),        // newest-first, as providers send it
    rows: Object.entries(rows).map(([line, vals]) => {
      const r: Record<string, number | string | null> = { line };
      cols.forEach((c, i) => { r[c] = vals[i]; });
      return r as Statementish["rows"][number];
    }),
  };
}

const YEARS = ["2023-03-31", "2024-03-31", "2025-03-31"];

/** A modest, healthy business. Values oldest → newest. */
function healthy(): Statements {
  return {
    income: st({
      "Total Revenue": [1000, 1100, 1250],
      "Cost Of Revenue": [600, 650, 725],
      "Operating Income": [180, 210, 250],
      EBITDA: [220, 255, 300],
      "Pretax Income": [170, 200, 240],
      "Tax Provision": [43, 50, 60],
      "Net Income": [127, 150, 180],
    }, YEARS),
    balance: st({
      "Total Assets": [900, 980, 1100],
      "Current Assets": [400, 430, 500],
      Inventory: [120, 130, 150],
      "Current Liabilities": [250, 260, 300],
      "Total Debt": [200, 205, 210],
      "Cash And Cash Equivalents": [80, 100, 140],
      "Stockholders Equity": [500, 560, 640],
    }, YEARS),
    cashflow: st({
      "Operating Cash Flow": [190, 220, 260],
      "Capital Expenditure": [-60, -65, -70],
      "Free Cash Flow": [130, 155, 190],
    }, YEARS),
  };
}

describe("chronological", () => {
  it("puts periods oldest first regardless of how they arrived", () => {
    // Providers return newest-first, which is right for a table and wrong for
    // every calculation: a growth rate over a reversed series has the correct
    // magnitude and the wrong sign, and nothing about it looks broken.
    expect(chronological(["2025-03-31", "2023-03-31", "2024-03-31"]))
      .toEqual(["2023-03-31", "2024-03-31", "2025-03-31"]);
  });

  it("falls back to string order for labels that aren't dates", () => {
    expect(chronological(["FY24", "FY22", "FY23"])).toEqual(["FY22", "FY23", "FY24"]);
  });
});

describe("findRow — provider vocabularies", () => {
  it("finds revenue whether the provider calls it Revenue or Total Revenue", () => {
    // FMP says "Revenue", yfinance says "Total Revenue". Matching on one
    // label shows full ratios for US names and blanks for Indian ones, for
    // no reason a user could ever discover.
    const fmp = st({ Revenue: [100] }, ["2025-03-31"]);
    const yf = st({ "Total Revenue": [100] }, ["2025-03-31"]);
    expect(findRow(fmp.rows, "revenue")?.line).toBe("Revenue");
    expect(findRow(yf.rows, "revenue")?.line).toBe("Total Revenue");
  });

  it("matches equity across both spellings", () => {
    for (const label of ["Shareholders' Equity", "Stockholders Equity",
                         "Total Stockholder Equity"]) {
      const s = st({ [label]: [1] }, ["2025-03-31"]);
      expect(findRow(s.rows, "equity")).not.toBeNull();
    }
  });

  it("ignores case, punctuation and spacing", () => {
    const s = st({ "operating  cash-flow": [1] }, ["2025-03-31"]);
    expect(findRow(s.rows, "operatingCF")).not.toBeNull();
  });

  it("returns null for a line the provider didn't send", () => {
    expect(findRow(st({ Revenue: [1] }, ["2025-03-31"]).rows, "inventory")).toBeNull();
  });
});

describe("seriesFor", () => {
  it("returns values oldest-first even though columns arrived newest-first", () => {
    const s = st({ "Total Revenue": [1000, 1100, 1250] }, YEARS);
    expect(seriesFor(s, "revenue")).toEqual([1000, 1100, 1250]);
  });

  it("returns nulls, not a short array, for a missing line", () => {
    const s = st({ "Total Revenue": [1, 2, 3] }, YEARS);
    expect(seriesFor(s, "inventory")).toEqual([null, null, null]);
  });

  it("parses numeric strings a provider may have sent", () => {
    const s: Statementish = {
      columns: ["2025-03-31"],
      rows: [{ line: "Total Revenue", "2025-03-31": "1,250" }],
    };
    expect(seriesFor(s, "revenue")).toEqual([1250]);
  });
});

describe("yoy", () => {
  it("computes period-over-period growth", () => {
    expect(yoy([100, 110, 121])).toEqual([null, 10, 10]);
  });

  it("returns null rather than infinity when the base is zero", () => {
    expect(yoy([0, 50])).toEqual([null, null]);
  });

  it("REFUSES to put a percentage on a swing through zero", () => {
    // -100 to +50 is not "150% growth"; it is a move from loss to profit and
    // needs saying in words, not a number that reads like an improvement of
    // a known size.
    expect(yoy([-100, 50])).toEqual([null, null]);
  });

  it("handles a deepening loss as a real percentage", () => {
    // -100 to -150 is a 50% worse loss, and the sign convention holds.
    expect(yoy([-100, -150])).toEqual([null, -50]);
  });

  it("skips gaps rather than bridging them", () => {
    expect(yoy([100, null, 121])).toEqual([null, null, null]);
  });
});

describe("cagr", () => {
  it("annualises between the first and last usable points", () => {
    // 100 -> 121 over two periods is 10% a year.
    expect(cagr([100, 110, 121])!).toBeCloseTo(10, 6);
  });

  it("respects periods-per-year for quarterly data", () => {
    const quarterly = [100, 100 * 1.1 ** 0.25, 100 * 1.1 ** 0.5,
                       100 * 1.1 ** 0.75, 110];
    expect(cagr(quarterly, 4)!).toBeCloseTo(10, 4);
  });

  it("refuses a negative endpoint — the root is meaningless", () => {
    expect(cagr([-50, 100])).toBeNull();
    expect(cagr([100, -50])).toBeNull();
  });

  it("needs two points", () => {
    expect(cagr([100])).toBeNull();
    expect(cagr([])).toBeNull();
  });
});

describe("ratioSeries", () => {
  const { columns, values } = ratioSeries(healthy());

  it("uses only periods common to every statement", () => {
    expect(columns).toEqual(YEARS);
  });

  it("computes margins off revenue", () => {
    // 1250 revenue, 725 cost -> 42% gross; 250 operating -> 20%.
    expect(values.grossMargin.at(-1)!).toBeCloseTo(42, 1);
    expect(values.operatingMargin.at(-1)!).toBeCloseTo(20, 6);
    expect(values.netMargin.at(-1)!).toBeCloseTo(14.4, 1);
  });

  it("DERIVES gross profit when the provider omits the line", () => {
    // Revenue and cost of revenue are both present, so gross profit is exact
    // arithmetic rather than an estimate — leaving the row blank would hide
    // a margin we can compute.
    const s = healthy();
    expect(findRow(s.income!.rows, "grossProfit")).toBeNull();
    expect(values.grossMargin.at(-1)).not.toBeNull();
  });

  it("derives free cash flow from operating cash flow and capex", () => {
    const s = healthy();
    s.cashflow!.rows = s.cashflow!.rows.filter((r) => r.line !== "Free Cash Flow");
    const v = ratioSeries(s).values;
    // 260 - 70 = 190 on 1250 of revenue.
    expect(v.fcfMargin.at(-1)!).toBeCloseTo(15.2, 1);
  });

  it("computes returns and leverage", () => {
    expect(values.roe.at(-1)!).toBeCloseTo((180 / 640) * 100, 4);
    expect(values.roa.at(-1)!).toBeCloseTo((180 / 1100) * 100, 4);
    expect(values.roce.at(-1)!).toBeCloseTo((250 / (1100 - 300)) * 100, 4);
    expect(values.debtToEquity.at(-1)!).toBeCloseTo(210 / 640, 6);
    expect(values.netDebtToEbitda.at(-1)!).toBeCloseTo((210 - 140) / 300, 6);
  });

  it("computes liquidity, and needs inventory for the quick ratio", () => {
    expect(values.currentRatio.at(-1)!).toBeCloseTo(500 / 300, 6);
    expect(values.quickRatio.at(-1)!).toBeCloseTo((500 - 150) / 300, 6);

    // Without an inventory line the quick ratio would silently equal the
    // current ratio, overstating liquidity for anyone holding stock.
    const s = healthy();
    s.balance!.rows = s.balance!.rows.filter((r) => r.line !== "Inventory");
    expect(ratioSeries(s).values.quickRatio.at(-1)).toBeNull();
  });

  it("refuses return on equity when equity is negative", () => {
    // A deficit has no "return on" it — the ratio is meaningless, not just
    // negative.
    const s = healthy();
    const eq = s.balance!.rows.find((r) => r.line === "Stockholders Equity")!;
    eq["2025-03-31"] = -100;
    expect(ratioSeries(s).values.roe.at(-1)).toBeNull();
    expect(ratioSeries(s).values.debtToEquity.at(-1)).toBeNull();
  });

  it("computes cash conversion and capex intensity", () => {
    expect(values.fcfConversion.at(-1)!).toBeCloseTo((190 / 180) * 100, 4);
    expect(values.capexToSales.at(-1)!).toBeCloseTo((70 / 1250) * 100, 4);
  });

  it("computes an effective tax rate off pre-tax income", () => {
    expect(values.effectiveTax.at(-1)!).toBeCloseTo((60 / 240) * 100, 4);
  });

  it("still computes what one statement CAN support when the others are missing", () => {
    // Income alone gives every margin, and nothing that needs a balance
    // sheet. Blanking the margins too would hide figures we hold.
    const only = { income: healthy().income, balance: null, cashflow: null };
    const v = ratioSeries(only).values;
    expect(v.grossMargin.at(-1)).not.toBeNull();
    expect(v.operatingMargin.at(-1)).not.toBeNull();
    expect(v.roe.every((x) => x == null)).toBe(true);
    expect(v.currentRatio.every((x) => x == null)).toBe(true);
  });

  it("returns empty series when there are no statements at all", () => {
    const v = ratioSeries({ income: null, balance: null, cashflow: null });
    expect(v.columns).toEqual([]);
    expect(v.values.grossMargin).toEqual([]);
  });
});

describe("sharedColumns", () => {
  it("intersects the periods across statements", () => {
    const s = healthy();
    s.cashflow = st({ "Operating Cash Flow": [1, 2] }, YEARS.slice(1));
    expect(sharedColumns(s)).toEqual(YEARS.slice(1));
  });

  it("ignores statements that carry nothing", () => {
    const s = { ...healthy(), cashflow: { columns: [], rows: [] } };
    expect(sharedColumns(s)).toEqual(YEARS);
  });

  it("is empty when the statements share no period", () => {
    const s = healthy();
    s.balance = st({ "Total Assets": [1] }, ["2019-03-31"]);
    expect(sharedColumns(s)).toEqual([]);
  });
});

describe("qualityFlags", () => {
  it("stays quiet on a healthy business", () => {
    expect(qualityFlags(healthy())).toEqual([]);
  });

  it("needs three periods before flagging anything", () => {
    // Two points is a line, not a trend. Flagging on one comparison produces
    // noise that trains people to ignore the panel.
    const s = healthy();
    const two = YEARS.slice(1);
    s.income = st({ "Total Revenue": [1, 1], "Net Income": [1, -50] }, two);
    s.balance = st({ "Total Assets": [1, 1] }, two);
    s.cashflow = st({ "Operating Cash Flow": [1, 1] }, two);
    expect(qualityFlags(s)).toEqual([]);
  });

  it("flags profit that isn't converting into cash", () => {
    const s = healthy();
    s.cashflow = st({
      "Operating Cash Flow": [70, 80, 90],
      "Capital Expenditure": [-30, -35, -40],
    }, YEARS);
    const f = qualityFlags(s);
    expect(f.some((x) => /not converting into cash/i.test(x.title))).toBe(true);
    // And it says which of the two innocent explanations to check.
    expect(f.find((x) => /converting/i.test(x.title))!.detail)
      .toMatch(/capex and working capital/);
  });

  it("flags compressing gross margin", () => {
    const s = healthy();
    s.income = st({
      "Total Revenue": [1000, 1100, 1250],
      "Cost Of Revenue": [600, 700, 850],
      "Operating Income": [180, 170, 160],
      "Pretax Income": [170, 160, 150],
      "Net Income": [127, 120, 112],
      EBITDA: [220, 210, 200],
    }, YEARS);
    expect(qualityFlags(s).some((x) => /compressing/i.test(x.title))).toBe(true);
  });

  it("flags rising leverage", () => {
    const s = healthy();
    s.balance = st({
      "Total Assets": [900, 980, 1100],
      "Current Assets": [400, 430, 500],
      Inventory: [120, 130, 150],
      "Current Liabilities": [250, 260, 300],
      "Total Debt": [500, 800, 1200],
      "Cash And Cash Equivalents": [80, 100, 140],
      "Stockholders Equity": [500, 520, 540],
    }, YEARS);
    expect(qualityFlags(s).some((x) => /leverage/i.test(x.title))).toBe(true);
  });

  it("flags current liabilities exceeding current assets, and says who that is normal for", () => {
    const s = healthy();
    const ca = s.balance!.rows.find((r) => r.line === "Current Assets")!;
    ca["2025-03-31"] = 200;
    const flag = qualityFlags(s).find((x) => /Current liabilities exceed/i.test(x.title));
    expect(flag).toBeDefined();
    expect(flag!.detail).toMatch(/retail|subscriptions/);
  });

  it("labels the inferred interest cover as inferred", () => {
    const s = healthy();
    const pt = s.income!.rows.find((r) => r.line === "Pretax Income")!;
    pt["2025-03-31"] = 60;      // a big gap below operating income
    const flag = qualityFlags(s).find((x) => /interest cover/i.test(x.title));
    expect(flag).toBeDefined();
    expect(flag!.detail).toMatch(/inferred/i);
    expect(flag!.detail).toMatch(/approximate|check the filing/i);
  });

  it("notes an unusually low tax rate as possibly one-off", () => {
    const s = healthy();
    const tax = s.income!.rows.find((r) => r.line === "Tax Provision")!;
    tax["2025-03-31"] = 5;
    const flag = qualityFlags(s).find((x) => /tax rate/i.test(x.title));
    expect(flag?.level).toBe("note");
    expect(flag!.detail).toMatch(/may not repeat|one-off/i);
  });
});

describe("coverageNote", () => {
  it("says how many periods the ratios actually span", () => {
    expect(coverageNote(healthy())).toMatch(/3 periods common to 3 statements/);
  });

  it("says so when nothing is available", () => {
    expect(coverageNote({ income: null, balance: null, cashflow: null }))
      .toMatch(/No statements/);
  });

  it("explains why cross-statement ratios are missing when periods don't line up", () => {
    const s = healthy();
    s.balance = st({ "Total Assets": [1] }, ["2019-03-31"]);
    expect(coverageNote(s)).toMatch(/no period appears in all of them/);
  });
});
