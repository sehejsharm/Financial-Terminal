import { describe, expect, it } from "vitest";

import {
  chainNote, daysToExpiry, expectedMove, isItm, ivSkew, oiProfile, tradability,
  type Row,
} from "./optionsRead";

const SPOT = 100;

/** A contract. IV is given in the provider's decimal form. */
const opt = (strike: number, over: Partial<Record<string, number>> = {}): Row => ({
  strike, bid: 2, ask: 2.2, lastPrice: 2.1, volume: 500, openInterest: 1000,
  impliedVolatility: 0.3, ...over,
});

/** Strikes 80…120 in fives, both sides. */
const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];
const calls = STRIKES.map((k) => opt(k));
const puts = STRIKES.map((k) => opt(k));

describe("isItm", () => {
  it("puts are in the money ABOVE the spot, calls below", () => {
    // The bug this fixes: the chain applied the call rule to both sides, so
    // every put row was shaded exactly backwards.
    expect(isItm(90, SPOT, "calls")).toBe(true);
    expect(isItm(110, SPOT, "calls")).toBe(false);
    expect(isItm(110, SPOT, "puts")).toBe(true);
    expect(isItm(90, SPOT, "puts")).toBe(false);
  });

  it("is false rather than throwing on a missing strike or spot", () => {
    expect(isItm(null, SPOT, "calls")).toBe(false);
    expect(isItm(90, 0, "puts")).toBe(false);
  });
});

describe("daysToExpiry", () => {
  const now = Date.UTC(2026, 5, 1);
  it("counts calendar days", () => {
    expect(daysToExpiry("2026-06-19", now)).toBe(18);
  });
  it("goes negative for a date already past", () => {
    expect(daysToExpiry("2026-05-15", now)).toBeLessThan(0);
  });
  it("returns null on an unparseable date", () => {
    expect(daysToExpiry("soon", now)).toBeNull();
  });
});

describe("expectedMove", () => {
  it("is the at-the-money straddle as a share of spot", () => {
    // Call mid 3, put mid 4 at the 100 strike = 7% expected move.
    const c = [opt(100, { bid: 2.9, ask: 3.1 })];
    const p = [opt(100, { bid: 3.9, ask: 4.1 })];
    const m = expectedMove(c, p, SPOT);
    expect(m.amount).toBeCloseTo(7, 8);
    expect(m.pct).toBeCloseTo(7, 8);
    expect(m.upper).toBeCloseTo(107, 8);
    expect(m.lower).toBeCloseTo(93, 8);
  });

  it("prefers the mid over a possibly-stale last trade", () => {
    const c = [opt(100, { bid: 2.9, ask: 3.1, lastPrice: 99 })];
    const p = [opt(100, { bid: 3.9, ask: 4.1, lastPrice: 99 })];
    expect(expectedMove(c, p, SPOT).amount).toBeCloseTo(7, 8);
  });

  it("falls back to the last trade when a side is unquoted", () => {
    const c = [opt(100, { bid: 0, ask: 0, lastPrice: 3 })];
    const p = [opt(100, { bid: 0, ask: 0, lastPrice: 4 })];
    expect(expectedMove(c, p, SPOT).amount).toBeCloseTo(7, 8);
  });

  it("REFUSES to call a strangle a straddle", () => {
    // The nearest call at 100 against the nearest put at 120 is not a
    // straddle, and pricing it as one overstates the expected move.
    const m = expectedMove([opt(100)], [opt(120)], SPOT);
    expect(m.pct).toBeNull();
    expect(m.problem).toMatch(/different strikes/);
  });

  it("refuses without a spot, a side, or a price", () => {
    expect(expectedMove(calls, puts, 0).problem).toMatch(/No spot price/);
    expect(expectedMove(calls, [], SPOT).problem).toMatch(/missing one side/);
    const dead = [opt(100, { bid: 0, ask: 0, lastPrice: 0 })];
    expect(expectedMove(dead, dead, SPOT).problem).toMatch(/not quoted/);
  });
});

describe("ivSkew", () => {
  /** IVs by strike, decimal form. */
  const withIv = (map: Record<number, number>) =>
    STRIKES.filter((k) => map[k] != null)
      .map((k) => opt(k, { impliedVolatility: map[k] }));

  it("measures the OTM put against the OTM call the same distance out", () => {
    const p = withIv({ 90: 0.40, 95: 0.35, 100: 0.30 });
    const c = withIv({ 100: 0.30, 105: 0.28, 110: 0.26 });
    const s = ivSkew(c, p, SPOT, 10);
    // 10% out is the 90 put (40) and the 110 call (26): 14 points.
    expect(s.putIv).toBeCloseTo(40, 6);
    expect(s.callIv).toBeCloseTo(26, 6);
    expect(s.points).toBeCloseTo(14, 6);
  });

  it("calls a steep skew what it is and says it implies an expected event", () => {
    const s = ivSkew(
      withIv({ 100: 0.30, 110: 0.24 }), withIv({ 100: 0.30, 90: 0.42 }), SPOT);
    expect(s.read).toMatch(/steep skew/);
    expect(s.read).toMatch(/an event is expected/);
  });

  it("calls an ordinary skew uninformative, because it is", () => {
    const s = ivSkew(
      withIv({ 100: 0.30, 110: 0.29 }), withIv({ 100: 0.30, 90: 0.33 }), SPOT);
    expect(s.read).toMatch(/ordinary equity skew/);
    expect(s.read).toMatch(/not information on its own/);
  });

  it("flags a CALL-skewed chain, which is the wrong way round for an equity", () => {
    const s = ivSkew(
      withIv({ 100: 0.30, 110: 0.40 }), withIv({ 100: 0.30, 90: 0.28 }), SPOT);
    expect(s.points!).toBeLessThan(0);
    expect(s.read).toMatch(/wrong way round/);
    expect(s.read).toMatch(/bid, a squeeze or a binary/);
  });

  it("reads a decimal IV as a decimal and a percent as a percent", () => {
    // 0.35 is 35%, not 0.35%; 35 is already percent and must not become 3500%.
    const asDecimal = ivSkew([opt(110, { impliedVolatility: 0.2 })],
                             [opt(90, { impliedVolatility: 0.4 })], SPOT);
    const asPercent = ivSkew([opt(110, { impliedVolatility: 20 })],
                             [opt(90, { impliedVolatility: 40 })], SPOT);
    expect(asDecimal.points).toBeCloseTo(asPercent.points!, 6);
  });

  it("says so rather than guessing when the wings are unquoted", () => {
    const s = ivSkew([opt(100)], [opt(100)], SPOT);
    expect(s.points).toBeNull();
    expect(s.read).toMatch(/thin out fast on the wings/);
  });
});

describe("oiProfile", () => {
  it("finds the heaviest strike on each side of the spot", () => {
    const c = [opt(105, { openInterest: 500 }), opt(110, { openInterest: 9000 })];
    const p = [opt(95, { openInterest: 7000 }), opt(90, { openInterest: 200 })];
    const o = oiProfile(c, p, SPOT);
    expect(o.callWall).toBe(110);
    expect(o.callWallOi).toBe(9000);
    expect(o.putWall).toBe(95);
    expect(o.putWallOi).toBe(7000);
  });

  it("ignores strikes on the wrong side of the spot", () => {
    // A big call position BELOW spot is not overhead resistance.
    const c = [opt(80, { openInterest: 90_000 }), opt(110, { openInterest: 100 })];
    expect(oiProfile(c, puts, SPOT).callWall).toBe(110);
  });

  it("refuses to read open interest as a directional bet", () => {
    const heavyPuts = oiProfile(calls, puts.map((r) => ({ ...r, openInterest: 3000 })), SPOT);
    expect(heavyPuts.putCallRatio!).toBeGreaterThan(1.3);
    expect(heavyPuts.read).toMatch(/as easily be someone hedging a long/);
    expect(heavyPuts.read).toMatch(/does not say which side initiated it/);
  });

  it("frames the walls as where flow concentrates, not where price goes", () => {
    expect(oiProfile(calls, puts, SPOT).read)
      .toMatch(/not about where price goes/);
  });

  it("says so when there is nothing outstanding", () => {
    const flat = calls.map((r) => ({ ...r, openInterest: 0 }));
    const o = oiProfile(flat, flat, SPOT);
    expect(o.callWall).toBeNull();
    expect(o.read).toMatch(/No meaningful open interest/);
  });
});

describe("tradability", () => {
  it("measures the median spread against the mid", () => {
    // 2.0 / 2.2 is a 9.5% spread on a 2.1 mid.
    const t = tradability([opt(100), opt(105)]);
    expect(t.medianSpreadPct!).toBeCloseTo((0.2 / 2.1) * 100, 6);
    expect(t.verdict).toBe("wide");
  });

  it("calls a tight chain tradable", () => {
    const t = tradability([opt(100, { bid: 2.0, ask: 2.02 })]);
    expect(t.verdict).toBe("tradable");
    expect(t.read).toMatch(/roughly what you would pay/);
  });

  it("says the spread IS the trade when it swamps any modelled edge", () => {
    const t = tradability([opt(100, { bid: 1, ask: 3 })]);
    expect(t.verdict).toBe("illiquid");
    expect(t.read).toMatch(/the spread is the trade/);
  });

  it("reports how many contracts never traded, so a last price isn't trusted", () => {
    const t = tradability([opt(100, { volume: 0 }), opt(105, { volume: 0 }),
                           opt(110, { volume: 5 }), opt(115, { volume: 5 })]);
    expect(t.untradedPct).toBeCloseTo(50, 6);
    expect(t.read).toMatch(/history, not a quote/);
  });

  it("refuses a verdict when nothing carries a two-sided quote", () => {
    const t = tradability([opt(100, { bid: 0, ask: 0 })]);
    expect(t.verdict).toBe("unknown");
    expect(t.read).toMatch(/indicative/);
  });

  it("handles an empty chain", () => {
    expect(tradability([]).verdict).toBe("unknown");
  });
});

describe("chainNote", () => {
  const tight = tradability([opt(100, { bid: 2, ask: 2.02 })]);

  it("warns that gamma and theta dominate near expiry", () => {
    expect(chainNote(3, tight)).toMatch(/Gamma and theta both dominate/);
  });

  it("says an expired chain's numbers should be ignored", () => {
    expect(chainNote(0, tight)).toMatch(/degenerate/);
    expect(chainNote(-2, tight)).toMatch(/should be ignored/);
  });

  it("names the assumptions Black-Scholes makes that don't hold", () => {
    const note = chainNote(30, tight);
    expect(note).toMatch(/European exercise, no dividends and constant volatility/);
    expect(note).toMatch(/not the exact sensitivity/);
  });

  it("tells the reader to discount modelled edge on a wide chain", () => {
    const wide = tradability([opt(100, { bid: 1, ask: 3 })]);
    expect(chainNote(30, wide)).toMatch(/smaller than the spread as non-existent/);
  });
});
