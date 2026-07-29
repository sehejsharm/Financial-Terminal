import { describe, expect, it } from "vitest";

import type { MergedEntity, Role } from "./valueChainGraph";
import {
  buildRows, countryOf, groupRows, sortRows, totals, toCSV,
  type ChainRow,
} from "./valueChainTable";

function ent(over: Partial<MergedEntity> & { name: string }): MergedEntity {
  const role: Role = over.primaryRole ?? "supplier";
  return {
    key: over.key ?? over.name.toLowerCase(),
    roles: over.roles ?? [role],
    primaryRole: role,
    pctByRole: {},
    metricsByRole: {
      [role]: { pctRevenue: null, pctCOGS: null, estUSDValue: null, yoyPct: null },
    },
    notesByRole: {},
    sources: {},
    ...over,
    name: over.name,
  } as MergedEntity;
}

function withMetrics(name: string, role: Role, m: Partial<{
  pctRevenue: number; pctCOGS: number; estUSDValue: number; yoyPct: number;
}>, rest: Partial<MergedEntity> = {}) {
  return ent({
    name, primaryRole: role, roles: [role],
    metricsByRole: {
      [role]: {
        pctRevenue: m.pctRevenue ?? null, pctCOGS: m.pctCOGS ?? null,
        estUSDValue: m.estUSDValue ?? null, yoyPct: m.yoyPct ?? null,
      },
    },
    ...rest,
  });
}

describe("countryOf", () => {
  it("reads the exchange from the ticker suffix", () => {
    expect(countryOf("RELIANCE.NS")).toBe("IN");
    expect(countryOf("2317.TW")).toBe("TW");
    expect(countryOf("005930.KS")).toBe("KR");
    expect(countryOf("6753.T")).toBe("JP");
    expect(countryOf("0700.HK")).toBe("HK");
  });

  it("treats a bare symbol as a US listing", () => {
    expect(countryOf("AAPL")).toBe("US");
    expect(countryOf("AVGO")).toBe("US");
  });

  it("returns null rather than guessing", () => {
    expect(countryOf("")).toBeNull();
    expect(countryOf(null)).toBeNull();
    expect(countryOf("SOMETHING.ZZ")).toBeNull();
    // Free text that isn't a symbol must not be read as a US listing.
    expect(countryOf("Hon Hai Precision")).toBeNull();
  });
});

describe("buildRows", () => {
  it("carries the metrics of the entity's PRIMARY role", () => {
    // A supplier's percentage is a share of input costs, a customer's is a
    // share of revenue. Reading the wrong one mislabels the number.
    const [row] = buildRows([
      withMetrics("Foxconn", "supplier", { pctCOGS: 46.6, estUSDValue: 16.9e9 }),
    ]);
    expect(row.pctCOGS).toBe(46.6);
    expect(row.pctRevenue).toBeNull();
    expect(row.valueUsd).toBe(16.9e9);
  });

  it("marks verified rows and dates them to the verification", () => {
    const [row] = buildRows([
      withMetrics("Checked Co", "customer", { pctRevenue: 10 },
                  { confidence: "verified", verified_at: "2026-01-02" }),
    ], { generatedAt: "2026-07-01" });
    expect(row.confidence).toBe("verified");
    expect(row.asOf).toBe("2026-01-02");
  });

  it("dates an estimated row to the generation run", () => {
    const [row] = buildRows([withMetrics("Guess Co", "supplier", {})],
                            { generatedAt: "2026-07-01" });
    expect(row.confidence).toBe("estimated");
    expect(row.asOf).toBe("2026-07-01");
  });

  it("attaches a live quote when the ticker resolves", () => {
    const [row] = buildRows(
      [withMetrics("Apple", "customer", {}, { ticker: "aapl" })],
      { quotes: { AAPL: { price: 212.4, change_pct: -1.2, currency: "USD" } } },
    );
    expect(row.price).toBe(212.4);
    expect(row.changePct).toBe(-1.2);
    expect(row.country).toBe("US");
  });

  it("leaves price null when there is no quote, rather than zero", () => {
    const [row] = buildRows([withMetrics("Private Co", "supplier", {})]);
    expect(row.price).toBeNull();
    expect(row.ticker).toBeNull();
  });

  it("keeps every role so a dual-role counterparty is visible as one row", () => {
    const [row] = buildRows([
      ent({ name: "Samsung", primaryRole: "supplier",
            roles: ["supplier", "customer", "competitor"] }),
    ]);
    expect(row.roles).toEqual(["supplier", "customer", "competitor"]);
    expect(row.role).toBe("supplier");
  });
});

describe("sortRows", () => {
  const rows = buildRows([
    withMetrics("Beta Co", "supplier", { pctCOGS: 10 }),
    withMetrics("Alpha Co", "supplier", { pctCOGS: 30 }),
    withMetrics("No Data Co", "supplier", {}),
  ]);

  it("sorts numerically", () => {
    expect(sortRows(rows, "pctCOGS", "desc").map((r) => r.name)[0]).toBe("Alpha Co");
    expect(sortRows(rows, "pctCOGS", "asc").map((r) => r.name)[0]).toBe("Beta Co");
  });

  it("puts unquantified rows LAST in both directions", () => {
    // Ascending with nulls first would bury every row that has a number.
    for (const dir of ["asc", "desc"] as const) {
      expect(sortRows(rows, "pctCOGS", dir).at(-1)!.name).toBe("No Data Co");
    }
  });

  it("sorts text case-insensitively by locale", () => {
    expect(sortRows(rows, "name", "asc").map((r) => r.name))
      .toEqual(["Alpha Co", "Beta Co", "No Data Co"]);
  });

  it("breaks ties by name so the order is stable", () => {
    const tied = buildRows([
      withMetrics("Zeta", "supplier", { pctCOGS: 5 }),
      withMetrics("Alpha", "supplier", { pctCOGS: 5 }),
    ]);
    expect(sortRows(tied, "pctCOGS", "desc").map((r) => r.name))
      .toEqual(["Alpha", "Zeta"]);
  });

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.name);
    sortRows(rows, "pctCOGS", "desc");
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});

describe("groupRows", () => {
  const rows = buildRows([
    withMetrics("A", "supplier", {}, { ticker: "2317.TW" }),
    withMetrics("B", "supplier", {}, { ticker: "2382.TW" }),
    withMetrics("C", "customer", {}, { ticker: "AAPL" }),
    withMetrics("D", "supplier", {}),
  ]);

  it("returns one anonymous group when grouping is off", () => {
    const out = groupRows(rows, "none");
    expect(out).toHaveLength(1);
    expect(out[0][1]).toHaveLength(4);
  });

  it("groups by listing, largest group first", () => {
    const out = groupRows(rows, "country");
    expect(out[0][0]).toBe("TW");
    expect(out[0][1]).toHaveLength(2);
  });

  it("names the unknown group rather than dropping those rows", () => {
    const labels = groupRows(rows, "country").map(([g]) => g);
    expect(labels).toContain("Not disclosed");
  });

  it("groups by role", () => {
    const out = groupRows(rows, "role");
    expect(out.map(([g, l]) => [g, l.length])).toEqual([
      ["supplier", 3], ["customer", 1],
    ]);
  });

  it("never loses a row", () => {
    for (const key of ["role", "country", "confidence"] as const) {
      const n = groupRows(rows, key).reduce((a, [, l]) => a + l.length, 0);
      expect(n).toBe(rows.length);
    }
  });
});

describe("totals", () => {
  const rows = buildRows([
    withMetrics("A", "supplier", { pctCOGS: 20, estUSDValue: 1e9 }),
    withMetrics("B", "supplier", { pctCOGS: 30, estUSDValue: 2e9 }),
    withMetrics("C", "supplier", {}, { confidence: "verified" }),
  ]);

  it("counts how much of the set is actually quantified", () => {
    const t = totals(rows);
    expect(t.n).toBe(3);
    expect(t.quantified).toBe(2);
    expect(t.verified).toBe(1);
  });

  it("sums only the values that exist", () => {
    const t = totals(rows);
    expect(t.pctCOGS).toBe(50);
    expect(t.valueUsd).toBe(3e9);
  });

  it("returns null, not zero, when nothing is quantified", () => {
    // Zero would read as "these relationships are worth nothing".
    const t = totals(buildRows([withMetrics("X", "supplier", {})]));
    expect(t.pctCOGS).toBeNull();
    expect(t.valueUsd).toBeNull();
  });

  it("handles an empty set", () => {
    expect(totals([])).toEqual({
      n: 0, quantified: 0, verified: 0,
      pctRevenue: null, pctCOGS: null, valueUsd: null,
    });
  });
});

describe("toCSV", () => {
  const rows: ChainRow[] = buildRows([
    withMetrics("Hon Hai, Precision", "supplier", { pctCOGS: 46.6 },
                { ticker: "2317.TW" }),
  ], { generatedAt: "2026-07-01T00:00:00Z" });

  it("warns about provenance in the header, not just in the UI", () => {
    // A CSV outlives the screen it came from. Without this the numbers
    // arrive in someone's model with no memory of being AI estimates.
    const csv = toCSV(rows, "Apple Inc", "2026-07-01T00:00:00Z");
    expect(csv).toMatch(/language model/i);
    expect(csv).toMatch(/not sourced from filings|NOT sourced/i);
    expect(csv).toMatch(/Apple Inc/);
  });

  it("quotes fields containing commas", () => {
    expect(toCSV(rows, "X")).toContain('"Hon Hai, Precision"');
  });

  it("writes an empty cell for a missing value rather than 'null'", () => {
    const line = toCSV(rows, "X").split("\n").at(-2)!;
    expect(line).not.toMatch(/null|undefined|NaN/);
  });

  it("includes the basis column so estimates stay labelled", () => {
    const csv = toCSV(rows, "X");
    expect(csv).toContain("Basis");
    expect(csv).toContain("estimated");
  });
});
