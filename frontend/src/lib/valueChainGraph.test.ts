import { describe, expect, it } from "vitest";

import {
  clamp, DEFAULT_VIEW, fitView, H, MAX_W, MIN_W, W, zoomAt,
  entityKey, findAliasKey, mergeEntities,
  edgeOpacityFor, edgeWidthFor, fmtUsd, maxUsd, readMetrics, resolveMetric,
} from "./valueChainGraph";

describe("clamp", () => {
  it("bounds a value both ways", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});

describe("fitView", () => {
  it("returns the default view for an empty graph", () => {
    expect(fitView([])).toEqual(DEFAULT_VIEW);
  });

  it("frames every node with padding", () => {
    const pts = [{ x: 200, y: 100 }, { x: 1000, y: 700 }];
    const v = fitView(pts);
    // Every node box must sit inside the framed view.
    for (const p of pts) {
      expect(p.x - 78).toBeGreaterThanOrEqual(v.x - 0.001);
      expect(p.x + 78).toBeLessThanOrEqual(v.x + v.w + 0.001);
      expect(p.y - 16).toBeGreaterThanOrEqual(v.y - 0.001);
      expect(p.y + 16).toBeLessThanOrEqual(v.y + v.h + 0.001);
    }
  });

  it("keeps the canvas aspect ratio", () => {
    const v = fitView([{ x: 300, y: 300 }, { x: 400, y: 700 }]);
    expect(v.w / v.h).toBeCloseTo(W / H, 5);
  });

  it("respects the zoom limits for a tiny graph", () => {
    const v = fitView([{ x: 600, y: 340 }]);
    expect(v.w).toBeGreaterThanOrEqual(MIN_W);
    expect(v.w).toBeLessThanOrEqual(MAX_W);
  });

  it("centres on the content", () => {
    const v = fitView([{ x: 500, y: 300 }, { x: 700, y: 400 }]);
    expect(v.x + v.w / 2).toBeCloseTo(600, 5);
    expect(v.y + v.h / 2).toBeCloseTo(350, 5);
  });
});

describe("zoomAt", () => {
  it("keeps the graph point under the cursor fixed", () => {
    const view = { x: 0, y: 0, w: W, h: H };
    const fx = 0.25, fy = 0.75;
    const before = { x: view.x + view.w * fx, y: view.y + view.h * fy };
    const zoomed = zoomAt(view, 1 / 1.15, fx, fy);
    const after = { x: zoomed.x + zoomed.w * fx, y: zoomed.y + zoomed.h * fy };
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });

  it("zooming in shrinks the viewBox, out grows it", () => {
    const v = { x: 0, y: 0, w: W, h: H };
    expect(zoomAt(v, 1 / 1.15, 0.5, 0.5).w).toBeLessThan(W);
    expect(zoomAt(v, 1.15, 0.5, 0.5).w).toBeGreaterThan(W);
  });

  it("never exceeds the zoom limits however hard you scroll", () => {
    let v = { x: 0, y: 0, w: W, h: H };
    for (let i = 0; i < 50; i++) v = zoomAt(v, 1 / 1.15, 0.5, 0.5);
    expect(v.w).toBeGreaterThanOrEqual(MIN_W);
    v = { x: 0, y: 0, w: W, h: H };
    for (let i = 0; i < 50; i++) v = zoomAt(v, 1.15, 0.5, 0.5);
    expect(v.w).toBeLessThanOrEqual(MAX_W);
  });

  it("preserves the aspect ratio", () => {
    const v = zoomAt({ x: 0, y: 0, w: W, h: H }, 1.4, 0.2, 0.8);
    expect(v.w / v.h).toBeCloseTo(W / H, 5);
  });
});

describe("entityKey", () => {
  it("ignores case, punctuation and corporate suffixes", () => {
    expect(entityKey("Tata Motors Ltd.")).toBe(entityKey("TATA MOTORS"));
    expect(entityKey("Apple Inc.")).toBe(entityKey("apple"));
    expect(entityKey("Reliance Industries Limited")).toBe(entityKey("Reliance Industries"));
  });
  it("keeps genuinely different companies apart", () => {
    expect(entityKey("Tata Motors")).not.toBe(entityKey("Tata Steel"));
    expect(entityKey("Infosys")).not.toBe(entityKey("Wipro"));
  });
  it("never collapses a name to an empty key", () => {
    expect(entityKey("Ltd")).not.toBe("");
    expect(entityKey("")).toBe("");
  });
});

describe("mergeEntities", () => {
  it("merges a company appearing as both customer and competitor", () => {
    const merged = mergeEntities({
      suppliers: [],
      customers: [{ name: "Samsung", revenue_pct: 12, note: "buys panels" }],
      competitors: [{ name: "Samsung Electronics Co.", note: "rival in handsets" }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].roles).toEqual(["customer", "competitor"]);
    // Placement follows flow-over-rivalry precedence.
    expect(merged[0].primaryRole).toBe("customer");
  });

  it("keeps role-specific percentages separate (they mean different things)", () => {
    const merged = mergeEntities({
      suppliers: [{ name: "Acme", revenue_pct: 30 }],   // 30% of INPUT COSTS
      customers: [{ name: "Acme", revenue_pct: 5 }],    // 5% of REVENUE
      competitors: [],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].pctByRole.supplier).toBe(30);
    expect(merged[0].pctByRole.customer).toBe(5);
    // The headline number is the primary role's, never a blended average.
    expect(merged[0].revenue_pct).toBe(30);
  });

  it("matches on identical ticker even when names differ", () => {
    const merged = mergeEntities({
      suppliers: [{ name: "TSMC", ticker: "TSM" }],
      customers: [],
      competitors: [{ name: "Taiwan Semiconductor Manufacturing", ticker: "TSM" }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].roles).toEqual(["supplier", "competitor"]);
    // The longer, more specific spelling wins as the display name.
    expect(merged[0].name).toBe("Taiwan Semiconductor Manufacturing");
  });

  it("promotes provenance: any verified occurrence verifies the entity", () => {
    const merged = mergeEntities({
      suppliers: [{ name: "Bosch", confidence: "estimated" }],
      customers: [],
      competitors: [{ name: "Bosch", confidence: "verified", verified_at: "2026-01-01" }],
    });
    expect(merged[0].confidence).toBe("verified");
    expect(merged[0].verified_at).toBe("2026-01-01");
  });

  it("keeps per-role source nodes so reports still address (role, name)", () => {
    const merged = mergeEntities({
      suppliers: [{ name: "Acme", note: "supplies resin" }],
      customers: [{ name: "Acme", note: "buys film" }],
      competitors: [],
    });
    expect(merged[0].sources.supplier?.note).toBe("supplies resin");
    expect(merged[0].sources.customer?.note).toBe("buys film");
    expect(merged[0].notesByRole.customer).toBe("buys film");
  });

  it("leaves distinct companies as separate nodes", () => {
    const merged = mergeEntities({
      suppliers: [{ name: "Alpha" }, { name: "Beta" }],
      customers: [{ name: "Gamma" }],
      competitors: [{ name: "Delta" }],
    });
    expect(merged).toHaveLength(4);
    for (const e of merged) expect(e.roles).toHaveLength(1);
  });

  it("handles empty / missing arrays", () => {
    expect(mergeEntities({})).toEqual([]);
    expect(mergeEntities({ suppliers: [], customers: [], competitors: [] })).toEqual([]);
  });
});

describe("findAliasKey (conservative name matching)", () => {
  it("matches a longer form of the same name", () => {
    expect(findAliasKey("samsung", ["samsung electronics"])).toBe("samsung electronics");
    expect(findAliasKey("samsung electronics", ["samsung"])).toBe("samsung");
  });
  it("NEVER merges sibling companies that only share a first word", () => {
    expect(findAliasKey("tata steel", ["tata motors"])).toBeNull();
    expect(findAliasKey("reliance jio", ["reliance retail"])).toBeNull();
  });
  it("ignores very short keys to avoid junk collisions", () => {
    expect(findAliasKey("ab", ["ab cellars"])).toBeNull();
  });
});

describe("mergeEntities — name variants", () => {
  it("does not merge Tata Motors with Tata Steel", () => {
    const merged = mergeEntities({
      suppliers: [{ name: "Tata Steel" }],
      customers: [],
      competitors: [{ name: "Tata Motors" }],
    });
    expect(merged).toHaveLength(2);
  });
});

describe("readMetrics (legacy fallback)", () => {
  it("maps legacy revenue_pct to the RIGHT metric per role", () => {
    // The same legacy field means revenue share for a customer and input-cost
    // share for a supplier — mapping it to the wrong one would mislabel edges.
    expect(readMetrics({ name: "X", revenue_pct: 20 }, "customer").pctRevenue).toBe(20);
    expect(readMetrics({ name: "X", revenue_pct: 20 }, "customer").pctCOGS).toBeNull();
    expect(readMetrics({ name: "X", revenue_pct: 20 }, "supplier").pctCOGS).toBe(20);
    expect(readMetrics({ name: "X", revenue_pct: 20 }, "supplier").pctRevenue).toBeNull();
  });
  it("prefers explicit modern fields over the legacy one", () => {
    const m = readMetrics({ name: "X", revenue_pct: 20, pct_revenue: 33 }, "customer");
    expect(m.pctRevenue).toBe(33);
  });
  it("reads dollar value and YoY", () => {
    const m = readMetrics({ name: "X", est_usd_value: 2.4e9, yoy_pct: -8 }, "customer");
    expect(m.estUSDValue).toBe(2.4e9);
    expect(m.yoyPct).toBe(-8);
  });
  it("is null-safe for a missing node", () => {
    expect(readMetrics(undefined, "customer").pctRevenue).toBeNull();
  });
});

describe("resolveMetric (graceful fallback)", () => {
  const base = { pctRevenue: null, pctCOGS: null, estUSDValue: null, yoyPct: null };
  it("uses the requested metric when present", () => {
    const r = resolveMetric({ ...base, pctRevenue: 12, estUSDValue: 5e9 }, "pctRevenue");
    expect(r).toMatchObject({ value: 12, used: "pctRevenue", fellBack: false });
  });
  it("falls back to whatever the AI DID return, and says so", () => {
    const r = resolveMetric({ ...base, estUSDValue: 5e9 }, "pctRevenue");
    expect(r).toMatchObject({ value: 5e9, used: "estUSDValue", fellBack: true });
  });
  it("reports nothing when the edge is unquantified", () => {
    expect(resolveMetric(base, "pctCOGS")).toMatchObject({ value: null, used: null });
  });
});

describe("edge scaling", () => {
  it("percentage edges scale on an absolute 0-100 scale", () => {
    expect(edgeWidthFor(5, "pctRevenue")).toBeLessThan(edgeWidthFor(40, "pctRevenue"));
    expect(edgeWidthFor(40, "pctRevenue")).toBeLessThanOrEqual(6);
    expect(edgeWidthFor(0.1, "pctRevenue")).toBeGreaterThanOrEqual(1.2);
  });
  it("dollar edges normalise against the graph maximum", () => {
    const max = 1e10;
    expect(edgeWidthFor(1e10, "estUSDValue", max)).toBeGreaterThan(edgeWidthFor(1e8, "estUSDValue", max));
    expect(edgeWidthFor(1e10, "estUSDValue", max)).toBeLessThanOrEqual(6);
  });
  it("unquantified edges get the thin base weight, not zero", () => {
    expect(edgeWidthFor(null, null)).toBe(1.2);
    expect(edgeOpacityFor(null, null)).toBe(0.35);
    // A dollar edge with no graph maximum must not divide by zero.
    expect(Number.isFinite(edgeWidthFor(5e9, "estUSDValue", 0))).toBe(true);
  });
  it("opacity stays inside legible bounds", () => {
    for (const v of [0, 1, 50, 100, 1e12]) {
      const o = edgeOpacityFor(v, "pctRevenue");
      expect(o).toBeGreaterThanOrEqual(0.3);
      expect(o).toBeLessThanOrEqual(0.9);
    }
  });
});

describe("maxUsd / fmtUsd", () => {
  it("finds the max ignoring nulls", () => {
    expect(maxUsd([null, 5e8, undefined, 2e9, NaN])).toBe(2e9);
    expect(maxUsd([])).toBe(0);
  });
  it("formats compactly", () => {
    expect(fmtUsd(2.4e9)).toBe("$2.4B");
    expect(fmtUsd(3.5e6)).toBe("$3.5M");
    expect(fmtUsd(null)).toBe("—");
  });
});
