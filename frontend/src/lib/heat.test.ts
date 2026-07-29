import { describe, expect, it } from "vitest";

import { heatBg, heatBorder, HEAT_SATURATION_PCT, tintBg, tintBorder } from "./heat";

const alphaOf = (css: string) => Number(css.match(/\/\s*([\d.]+)\)/)?.[1]);

describe("heatBg", () => {
  it("is green above zero and red below", () => {
    expect(heatBg(1)).toContain("--c-green");
    expect(heatBg(-1)).toContain("--c-red");
    expect(heatBg(0)).toContain("--c-green");   // flat sits on the up side
  });

  it("is TRANSPARENT when there is no quote", () => {
    // An absent quote must not be painted as a flat one.
    expect(heatBg(null)).toBe("transparent");
    expect(heatBg(undefined)).toBe("transparent");
    expect(heatBg(Number.NaN)).toBe("transparent");
  });

  it("deepens with the size of the move and then saturates", () => {
    const small = alphaOf(heatBg(0.5));
    const mid = alphaOf(heatBg(1.5));
    const full = alphaOf(heatBg(HEAT_SATURATION_PCT));
    const beyond = alphaOf(heatBg(HEAT_SATURATION_PCT * 20));
    expect(small).toBeLessThan(mid);
    expect(mid).toBeLessThan(full);
    expect(beyond).toBe(full);
  });

  it("treats equal moves in either direction with equal intensity", () => {
    expect(alphaOf(heatBg(1.3))).toBe(alphaOf(heatBg(-1.3)));
  });
});

describe("heatBorder", () => {
  it("falls back to the plain panel edge when unknown", () => {
    expect(heatBorder(null)).toBe("rgb(var(--c-line2))");
  });

  it("is stronger than the background fill at the same move", () => {
    expect(alphaOf(heatBorder(1))).toBeGreaterThan(alphaOf(heatBg(1)));
  });
});

describe("tintBg / tintBorder", () => {
  it("saturates at the scale it is given, not at the percent scale", () => {
    // A −40 sector score is not a −40% day. Sharing the ramp without
    // sharing the scale is exactly the bug this exists to prevent.
    expect(alphaOf(tintBg(40, 100))).toBeLessThan(alphaOf(heatBg(40)));
    expect(alphaOf(tintBg(100, 100))).toBe(alphaOf(heatBg(HEAT_SATURATION_PCT)));
  });

  it("matches heatBg exactly when handed the percent scale", () => {
    expect(tintBg(1.3, HEAT_SATURATION_PCT)).toBe(heatBg(1.3));
    expect(tintBorder(-0.7, HEAT_SATURATION_PCT)).toBe(heatBorder(-0.7));
  });

  it("refuses a nonsense scale instead of dividing by zero", () => {
    expect(tintBg(5, 0)).toBe("transparent");
    expect(tintBorder(5, 0)).toBe("rgb(var(--c-line2))");
  });

  it("is transparent for a missing value", () => {
    expect(tintBg(null, 100)).toBe("transparent");
  });
});
