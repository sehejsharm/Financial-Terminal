import { describe, expect, it } from "vitest";

import {
  analyse, bsGreeks, ncdf, payoffAt, payoffCurve, PRESETS, probProfit,
  roundToStep, strategyGreeks, strikeStep, type Leg, type PriceInputs,
} from "./optionStrategy";

const P: PriceInputs = { S: 100, T: 1, r: 0.05, sigma: 0.2, q: 0 };
const leg = (kind: "call" | "put", dir: 1 | -1, strike: number, qty = 1): Leg =>
  ({ id: `${kind}${dir}${strike}`, kind, dir, strike, qty });

describe("ncdf", () => {
  it("matches known standard-normal values", () => {
    expect(ncdf(0)).toBeCloseTo(0.5, 6);
    expect(ncdf(1)).toBeCloseTo(0.8413447, 5);
    expect(ncdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(ncdf(1.96)).toBeCloseTo(0.975, 4);
  });
  it("is symmetric", () => {
    for (const x of [0.3, 1.1, 2.4]) expect(ncdf(x) + ncdf(-x)).toBeCloseTo(1, 6);
  });
});

describe("bsGreeks", () => {
  it("matches the textbook value for a 1Y ATM call (S=100 K=100 r=5% v=20%)", () => {
    // Standard reference figure: 10.4506
    expect(bsGreeks(100, "call", P).price).toBeCloseTo(10.4506, 3);
  });

  it("matches the textbook value for the matching put", () => {
    expect(bsGreeks(100, "put", P).price).toBeCloseTo(5.5735, 3);
  });

  it("satisfies put-call parity", () => {
    const c = bsGreeks(95, "call", P).price;
    const p = bsGreeks(95, "put", P).price;
    expect(c - p).toBeCloseTo(P.S - 95 * Math.exp(-P.r * P.T), 6);
  });

  it("has call delta in [0,1] and put delta in [-1,0]", () => {
    for (const K of [60, 100, 160]) {
      const c = bsGreeks(K, "call", P).delta;
      const p = bsGreeks(K, "put", P).delta;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(p).toBeGreaterThanOrEqual(-1);
      expect(p).toBeLessThanOrEqual(0);
      expect(c - p).toBeCloseTo(1, 6);            // parity on delta
    }
  });

  it("delta matches a numerical derivative of price w.r.t. spot", () => {
    const h = 0.01;
    const up = bsGreeks(100, "call", { ...P, S: P.S + h }).price;
    const dn = bsGreeks(100, "call", { ...P, S: P.S - h }).price;
    // 4dp: ncdf is an erf approximation good to ~1e-7, and a central
    // difference amplifies that. Far tighter than any practical use needs.
    expect((up - dn) / (2 * h)).toBeCloseTo(bsGreeks(100, "call", P).delta, 4);
  });

  it("gamma matches the second numerical derivative and is shared by call and put", () => {
    const h = 0.1;
    const f = (s: number) => bsGreeks(100, "call", { ...P, S: s }).price;
    const numeric = (f(100 + h) - 2 * f(100) + f(100 - h)) / (h * h);
    expect(bsGreeks(100, "call", P).gamma).toBeCloseTo(numeric, 5);
    expect(bsGreeks(100, "put", P).gamma).toBeCloseTo(bsGreeks(100, "call", P).gamma, 10);
  });

  it("vega is quoted per vol POINT and matches the derivative", () => {
    const h = 0.0001;
    const up = bsGreeks(100, "call", { ...P, sigma: P.sigma + h }).price;
    const dn = bsGreeks(100, "call", { ...P, sigma: P.sigma - h }).price;
    const perUnit = (up - dn) / (2 * h);
    expect(bsGreeks(100, "call", P).vega).toBeCloseTo(perUnit / 100, 4);
  });

  it("theta is quoted per DAY and is negative for a long ATM option", () => {
    const t = bsGreeks(100, "call", P).theta;
    expect(t).toBeLessThan(0);
    expect(Math.abs(t)).toBeLessThan(1);    // a per-year theta would be ~6
  });

  it("returns intrinsic value — not NaN — at expiry or zero vol", () => {
    for (const bad of [{ ...P, T: 0 }, { ...P, sigma: 0 }]) {
      const c = bsGreeks(90, "call", bad);
      expect(c.price).toBe(10);
      expect(c.delta).toBe(1);
      expect(c.gamma).toBe(0);
      const otm = bsGreeks(120, "call", bad);
      expect(otm.price).toBe(0);
      expect(otm.delta).toBe(0);
    }
  });

  it("prices rise with volatility and with time for a long option", () => {
    expect(bsGreeks(100, "call", { ...P, sigma: 0.4 }).price)
      .toBeGreaterThan(bsGreeks(100, "call", P).price);
    expect(bsGreeks(100, "call", { ...P, T: 2 }).price)
      .toBeGreaterThan(bsGreeks(100, "call", P).price);
  });

  it("a dividend yield lowers a call and lifts a put", () => {
    expect(bsGreeks(100, "call", { ...P, q: 0.05 }).price)
      .toBeLessThan(bsGreeks(100, "call", P).price);
    expect(bsGreeks(100, "put", { ...P, q: 0.05 }).price)
      .toBeGreaterThan(bsGreeks(100, "put", P).price);
  });
});

describe("strategyGreeks", () => {
  it("nets long and short legs", () => {
    const spread = [leg("call", 1, 100), leg("call", -1, 110)];
    const g = strategyGreeks(spread, P);
    expect(g.netDebit).toBeCloseTo(
      bsGreeks(100, "call", P).price - bsGreeks(110, "call", P).price, 10);
    expect(g.netDebit).toBeGreaterThan(0);              // a debit spread
    expect(g.delta).toBeGreaterThan(0);
  });

  it("a short straddle is short vega, short gamma and collects a credit", () => {
    const g = strategyGreeks([leg("call", -1, 100), leg("put", -1, 100)], P);
    expect(g.netDebit).toBeLessThan(0);                 // credit
    expect(g.vega).toBeLessThan(0);
    expect(g.gamma).toBeLessThan(0);
    expect(g.theta).toBeGreaterThan(0);                 // time decay works for you
  });

  it("scales linearly with quantity", () => {
    const one = strategyGreeks([leg("call", 1, 100, 1)], P);
    const three = strategyGreeks([leg("call", 1, 100, 3)], P);
    expect(three.price).toBeCloseTo(one.price * 3, 10);
    expect(three.delta).toBeCloseTo(one.delta * 3, 10);
  });
});

describe("payoffAt", () => {
  it("is intrinsic value at expiry", () => {
    expect(payoffAt([leg("call", 1, 100)], 120)).toBe(20);
    expect(payoffAt([leg("call", 1, 100)], 80)).toBe(0);
    expect(payoffAt([leg("put", 1, 100)], 80)).toBe(20);
    expect(payoffAt([leg("call", -1, 100)], 120)).toBe(-20);
  });

  it("a butterfly peaks exactly at the middle strike", () => {
    const fly = [leg("call", 1, 90), leg("call", -1, 100, 2), leg("call", 1, 110)];
    expect(payoffAt(fly, 100)).toBe(10);
    expect(payoffAt(fly, 90)).toBe(0);
    expect(payoffAt(fly, 110)).toBe(0);
    expect(payoffAt(fly, 200)).toBe(0);     // wings cap it
    expect(payoffAt(fly, 0)).toBe(0);
  });
});

describe("analyse", () => {
  it("finds the breakeven of a long call exactly", () => {
    const legs = [leg("call", 1, 100)];
    const a = analyse(legs, P);
    expect(a.breakevens).toHaveLength(1);
    expect(a.breakevens[0]).toBeCloseTo(100 + a.netDebit, 4);
    expect(a.maxProfit).toBeNull();                   // unbounded upside
    expect(a.maxLoss).toBeCloseTo(-a.netDebit, 6);    // premium paid
  });

  it("finds BOTH breakevens of a straddle", () => {
    const legs = [leg("call", 1, 100), leg("put", 1, 100)];
    const a = analyse(legs, P);
    expect(a.breakevens).toHaveLength(2);
    expect(a.breakevens[0]).toBeCloseTo(100 - a.netDebit, 4);
    expect(a.breakevens[1]).toBeCloseTo(100 + a.netDebit, 4);
    expect(a.maxProfit).toBeNull();
    expect(a.maxLoss).toBeCloseTo(-a.netDebit, 6);
  });

  it("bounds a vertical spread on both sides", () => {
    const legs = [leg("call", 1, 100), leg("call", -1, 110)];
    const a = analyse(legs, P);
    expect(a.maxProfit).toBeCloseTo(10 - a.netDebit, 6);
    expect(a.maxLoss).toBeCloseTo(-a.netDebit, 6);
    expect(a.breakevens[0]).toBeCloseTo(100 + a.netDebit, 4);
  });

  it("reports UNBOUNDED loss on a naked short call as null, not a big number", () => {
    const a = analyse([leg("call", -1, 100)], P);
    expect(a.maxLoss).toBeNull();
    expect(a.maxProfit).toBeCloseTo(-a.netDebit, 6);   // the credit
  });

  it("bounds an iron condor on both sides", () => {
    const legs = [
      leg("put", 1, 85), leg("put", -1, 93),
      leg("call", -1, 107), leg("call", 1, 115),
    ];
    const a = analyse(legs, P);
    expect(a.netDebit).toBeLessThan(0);       // credit structure
    expect(a.maxProfit).not.toBeNull();
    expect(a.maxLoss).not.toBeNull();
    expect(a.maxProfit!).toBeGreaterThan(0);
    expect(a.maxLoss!).toBeLessThan(0);
    expect(a.breakevens).toHaveLength(2);
  });

  it("finds breakevens of a NARROW spread a sampling grid would miss", () => {
    const a = analyse([leg("call", 1, 100), leg("call", -1, 100.5)], P);
    expect(a.breakevens).toHaveLength(1);
    expect(a.breakevens[0]).toBeGreaterThan(100);
    expect(a.breakevens[0]).toBeLessThan(100.5);
  });

  it("handles an empty structure", () => {
    const a = analyse([], P);
    expect(a.breakevens).toEqual([]);
    expect(a.netDebit).toBe(0);
  });
});

describe("payoffCurve", () => {
  it("returns the requested number of points spanning the range", () => {
    const c = payoffCurve([leg("call", 1, 100)], P, 50, 150, 21);
    expect(c).toHaveLength(21);
    expect(c[0].spot).toBe(50);
    expect(c[20].spot).toBe(150);
  });

  it("the expiry line crosses zero at the analysed breakeven", () => {
    const legs = [leg("call", 1, 100)];
    const be = analyse(legs, P).breakevens[0];
    const c = payoffCurve(legs, P, be - 5, be + 5, 101);
    const cross = c.findIndex((x) => x.expiry > 0);
    expect(c[cross].spot).toBeGreaterThanOrEqual(be - 0.2);
    expect(c[cross].spot).toBeLessThanOrEqual(be + 0.2);
  });

  it("today's value sits above the expiry payoff for a long option (time value)", () => {
    const c = payoffCurve([leg("call", 1, 100)], P, 60, 140, 41);
    for (const pt of c) expect(pt.now).toBeGreaterThanOrEqual(pt.expiry - 1e-9);
  });
});

describe("probProfit", () => {
  it("is between 0 and 1 and lower for an OTM long call than an ITM one", () => {
    const otm = probProfit([leg("call", 1, 130)], P)!;
    const itm = probProfit([leg("call", 1, 70)], P)!;
    expect(otm).toBeGreaterThanOrEqual(0);
    expect(otm).toBeLessThanOrEqual(1);
    expect(otm).toBeLessThan(itm);
  });

  it("is high for a wide short-premium structure", () => {
    const condor = [
      leg("put", 1, 70), leg("put", -1, 80),
      leg("call", -1, 125), leg("call", 1, 135),
    ];
    expect(probProfit(condor, P)!).toBeGreaterThan(0.5);
  });

  it("returns null where the lognormal model has nothing to say", () => {
    expect(probProfit([leg("call", 1, 100)], { ...P, T: 0 })).toBeNull();
    expect(probProfit([], P)).toBeNull();
  });
});

describe("presets and strike helpers", () => {
  it("every preset builds legs that price and analyse cleanly", () => {
    const step = strikeStep(2500);
    const R = (x: number) => roundToStep(x, step);
    const inputs: PriceInputs = { S: 2500, T: 0.25, r: 0.06, sigma: 0.25, q: 0 };
    for (const p of PRESETS) {
      const legs = p.build(2500, R).map((l, i) => ({ ...l, id: String(i) }));
      expect(legs.length, p.id).toBeGreaterThan(0);
      const g = strategyGreeks(legs, inputs);
      expect(Number.isFinite(g.price), p.id).toBe(true);
      expect(Number.isFinite(g.delta), p.id).toBe(true);
      const a = analyse(legs, inputs);
      expect(Number.isFinite(a.netDebit), p.id).toBe(true);
      for (const s of legs.map((l) => l.strike)) expect(s, p.id).toBeGreaterThan(0);
    }
  });

  it("directional presets lean the right way", () => {
    const R = (x: number) => roundToStep(x, strikeStep(100));
    const build = (id: string) =>
      PRESETS.find((p) => p.id === id)!.build(100, R).map((l, i) => ({ ...l, id: String(i) }));
    expect(strategyGreeks(build("bull_call_spread"), P).delta).toBeGreaterThan(0);
    expect(strategyGreeks(build("bear_put_spread"), P).delta).toBeLessThan(0);
    // A long straddle is delta-flat-ish and long vega.
    expect(Math.abs(strategyGreeks(build("straddle"), P).delta)).toBeLessThan(0.3);
    expect(strategyGreeks(build("straddle"), P).vega).toBeGreaterThan(0);
    expect(strategyGreeks(build("iron_condor"), P).vega).toBeLessThan(0);
  });

  it("strike steps scale with the price level and stay under 2.5% of spot", () => {
    for (const s of [12, 45, 100, 180, 700, 2500, 19000]) {
      const step = strikeStep(s);
      expect(step, `spot ${s}`).toBeGreaterThan(0);
      expect(step / s, `spot ${s}`).toBeLessThanOrEqual(0.025);
      // and on the 1-2.5-5 ladder
      const mant = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2.5, 5], `spot ${s}`).toContain(Math.round(mant * 10) / 10);
    }
    expect(roundToStep(2543, 50)).toBe(2550);
  });

  it("rounds through the float error that 1.15 * 100 introduces", () => {
    // 1.15 * 100 === 114.99999999999999, which naively floors to 110.
    expect(roundToStep(1.15 * 100, 5)).toBe(115);
    expect(roundToStep(1.07 * 100, 2.5)).toBeCloseTo(107.5, 10);
  });

  it("no preset collapses two legs onto the SAME strike and kind", () => {
    // The failure this guards: at a coarse step an iron condor's four strikes
    // round into two cancelling pairs — a structure worth exactly zero.
    for (const s of [45, 100, 180, 700, 2500, 19000]) {
      const R = (x: number) => roundToStep(x, strikeStep(s));
      for (const p of PRESETS) {
        const legs = p.build(s, R);
        const keys = legs.map((l) => `${l.kind}@${l.strike}`);
        expect(new Set(keys).size, `${p.id} at spot ${s}`).toBe(keys.length);
      }
    }
  });
});
