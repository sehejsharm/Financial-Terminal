import { describe, expect, it } from "vitest";

import {
  clamp, DEFAULT_VIEW, fitView, H, MAX_W, MIN_W, W, zoomAt,
  entityKey, findAliasKey, mergeEntities,
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
