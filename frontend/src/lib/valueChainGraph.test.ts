import { describe, expect, it } from "vitest";

import {
  clamp, DEFAULT_VIEW, fitView, H, MAX_W, MIN_W, W, zoomAt,
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
