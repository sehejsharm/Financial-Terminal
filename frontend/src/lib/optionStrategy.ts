/** OVME — vanilla option strategy pricing and payoff analysis.
 *
 *  Black-Scholes in TypeScript so a strategy re-prices instantly as strikes,
 *  vol and time are dragged around — a round trip per keystroke would make
 *  the builder unusable.
 *
 *  IMPORTANT: this is a THEORETICAL pricer, not a market-data tool. There is
 *  no live option chain on the free data path, so every premium here comes
 *  from the volatility YOU supply, not from a quoted market. It answers "what
 *  is this structure worth if vol is X" and "what does its payoff look like",
 *  which are the questions a structure builder is actually for. It cannot
 *  tell you what the market charges.
 */

export type OptKind = "call" | "put";
export type Leg = {
  id: string;
  kind: OptKind;
  /** +1 long, -1 short. */
  dir: 1 | -1;
  strike: number;
  qty: number;
};

export type PriceInputs = {
  /** Spot. */
  S: number;
  /** Years to expiry. */
  T: number;
  /** Continuously-compounded risk-free rate, as a fraction. */
  r: number;
  /** Annualised volatility, as a fraction. */
  sigma: number;
  /** Continuous dividend yield, as a fraction. */
  q?: number;
};

const SQRT2PI = Math.sqrt(2 * Math.PI);

/** Standard normal CDF via erf — accurate to ~1e-7, plenty for pricing. */
export function ncdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 applied to erf.
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function npdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

export type Greeks = {
  price: number;
  delta: number;
  gamma: number;
  /** Per calendar day, the way a screen quotes it. */
  theta: number;
  /** Per 1 vol POINT (1%), the way a screen quotes it. */
  vega: number;
  /** Per 1% rate move. */
  rho: number;
};

/**
 * Black-Scholes-Merton price and greeks for one option.
 *
 * At T <= 0 or sigma <= 0 the formula degenerates (division by zero), so
 * those cases return the intrinsic value with a step delta — the correct
 * limit — rather than NaN.
 */
export function bsGreeks(K: number, kind: OptKind, p: PriceInputs): Greeks {
  const { S, T, r, sigma } = p;
  const q = p.q ?? 0;
  if (!(S > 0) || !(K > 0)) {
    return { price: NaN, delta: NaN, gamma: NaN, theta: NaN, vega: NaN, rho: NaN };
  }
  if (!(T > 0) || !(sigma > 0)) {
    const intrinsic = kind === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    const itm = kind === "call" ? S > K : S < K;
    return {
      price: intrinsic,
      delta: itm ? (kind === "call" ? 1 : -1) : 0,
      gamma: 0, theta: 0, vega: 0, rho: 0,
    };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T);

  const price = kind === "call"
    ? S * dfq * ncdf(d1) - K * dfr * ncdf(d2)
    : K * dfr * ncdf(-d2) - S * dfq * ncdf(-d1);

  const delta = kind === "call" ? dfq * ncdf(d1) : dfq * (ncdf(d1) - 1);
  const gamma = (dfq * npdf(d1)) / (S * sigma * sqrtT);
  const vega = S * dfq * npdf(d1) * sqrtT;
  const thetaYr = kind === "call"
    ? -(S * dfq * npdf(d1) * sigma) / (2 * sqrtT) - r * K * dfr * ncdf(d2) + q * S * dfq * ncdf(d1)
    : -(S * dfq * npdf(d1) * sigma) / (2 * sqrtT) + r * K * dfr * ncdf(-d2) - q * S * dfq * ncdf(-d1);
  const rho = kind === "call"
    ? K * T * dfr * ncdf(d2) : -K * T * dfr * ncdf(-d2);

  return {
    price, delta, gamma,
    theta: thetaYr / 365,        // per calendar day
    vega: vega / 100,            // per vol point
    rho: rho / 100,              // per 1% rate move
  };
}

// ── strategy level ─────────────────────────────────────────────────────────

export type StrategyGreeks = Greeks & {
  /** Net premium: positive = paid (debit), negative = received (credit). */
  netDebit: number;
};

export function strategyGreeks(legs: Leg[], p: PriceInputs): StrategyGreeks {
  const acc: StrategyGreeks = {
    price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, netDebit: 0,
  };
  for (const l of legs) {
    const g = bsGreeks(l.strike, l.kind, p);
    const w = l.dir * l.qty;
    acc.price += w * g.price;
    acc.delta += w * g.delta;
    acc.gamma += w * g.gamma;
    acc.theta += w * g.theta;
    acc.vega += w * g.vega;
    acc.rho += w * g.rho;
  }
  acc.netDebit = acc.price;
  return acc;
}

/** Intrinsic value of the whole structure at expiry for a given spot. */
export function payoffAt(legs: Leg[], spot: number): number {
  let v = 0;
  for (const l of legs) {
    const intrinsic = l.kind === "call"
      ? Math.max(spot - l.strike, 0) : Math.max(l.strike - spot, 0);
    v += l.dir * l.qty * intrinsic;
  }
  return v;
}

export type CurvePoint = { spot: number; expiry: number; now: number };

/**
 * Payoff across a spot range: value at expiry (intrinsic minus premium paid)
 * and theoretical value today, both net of the premium.
 */
export function payoffCurve(
  legs: Leg[], p: PriceInputs, lo: number, hi: number, steps = 121,
): CurvePoint[] {
  const entry = strategyGreeks(legs, p).netDebit;
  const out: CurvePoint[] = [];
  for (let i = 0; i < steps; i++) {
    const spot = lo + ((hi - lo) * i) / (steps - 1);
    const now = strategyGreeks(legs, { ...p, S: spot }).price - entry;
    out.push({ spot, expiry: payoffAt(legs, spot) - entry, now });
  }
  return out;
}

export type StrategyProfile = {
  netDebit: number;
  breakevens: number[];
  /** null means unbounded in that direction. */
  maxProfit: number | null;
  maxLoss: number | null;
};

/**
 * Breakevens and payoff bounds at expiry, from the piecewise-linear payoff.
 *
 * The function is linear between strikes, so evaluating at every strike plus
 * the two outer wings finds every kink exactly — no sampling grid to miss a
 * narrow spread. Unbounded ends are reported as null rather than as whatever
 * the sampling window happened to reach.
 */
export function analyse(legs: Leg[], p: PriceInputs): StrategyProfile {
  const netDebit = strategyGreeks(legs, p).netDebit;
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  if (!strikes.length) {
    return { netDebit, breakevens: [], maxProfit: null, maxLoss: null };
  }
  const wing = Math.max(strikes[strikes.length - 1] * 0.5, 1);
  const lo = Math.max(0, strikes[0] - wing);
  const hi = strikes[strikes.length - 1] + wing;
  const knots = [lo, ...strikes, hi];
  const pnl = (s: number) => payoffAt(legs, s) - netDebit;

  // Breakevens: sign changes between adjacent knots, solved exactly since the
  // segment is linear.
  const breakevens: number[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i], b = knots[i + 1];
    const fa = pnl(a), fb = pnl(b);
    if (fa === 0) { breakevens.push(a); continue; }
    if (fa * fb < 0) breakevens.push(a + ((0 - fa) / (fb - fa)) * (b - a));
  }
  if (pnl(knots[knots.length - 1]) === 0) breakevens.push(knots[knots.length - 1]);

  // Slopes outside the outermost strikes decide whether the ends are bounded.
  const totalCallDelta = legs.reduce(
    (a, l) => a + (l.kind === "call" ? l.dir * l.qty : 0), 0);
  const totalPutDelta = legs.reduce(
    (a, l) => a + (l.kind === "put" ? l.dir * l.qty : 0), 0);
  // Far above the top strike every call is ITM, every put worthless.
  const slopeUp = totalCallDelta;
  // Far below the bottom strike every put is ITM (payoff falls as spot rises).
  const slopeDown = -totalPutDelta;

  const vals = knots.map(pnl);
  const kinkMax = Math.max(...vals);
  const kinkMin = Math.min(...vals);

  const maxProfit = slopeUp > 0 || slopeDown < 0 ? null : kinkMax;
  const maxLoss = slopeUp < 0 || slopeDown > 0 ? null : kinkMin;

  return {
    netDebit,
    breakevens: [...new Set(breakevens.map((x) => Math.round(x * 1e6) / 1e6))]
      .sort((a, b) => a - b),
    maxProfit, maxLoss,
  };
}

// ── presets ────────────────────────────────────────────────────────────────

export type PresetId =
  | "long_call" | "long_put" | "covered_call" | "protective_put"
  | "bull_call_spread" | "bear_put_spread" | "straddle" | "strangle"
  | "iron_condor" | "butterfly" | "collar";

export type Preset = {
  id: PresetId;
  label: string;
  /** What the structure is for, in one line. */
  intent: string;
  /** Strikes as multiples of spot, so a preset works on any price level. */
  build: (spot: number, round: (x: number) => number) => Omit<Leg, "id">[];
  /** Legs that are options only — some presets also imply stock. */
  stockNote?: string;
};

export const PRESETS: Preset[] = [
  {
    id: "long_call", label: "Long call",
    intent: "Directional up. Loss capped at the premium, upside open-ended.",
    build: (s, R) => [{ kind: "call", dir: 1, strike: R(s), qty: 1 }],
  },
  {
    id: "long_put", label: "Long put",
    intent: "Directional down, or insurance on stock you hold elsewhere.",
    build: (s, R) => [{ kind: "put", dir: 1, strike: R(s), qty: 1 }],
  },
  {
    id: "bull_call_spread", label: "Bull call spread",
    intent: "Up, cheaper than a call — you sell the upside above the higher strike.",
    build: (s, R) => [
      { kind: "call", dir: 1, strike: R(s), qty: 1 },
      { kind: "call", dir: -1, strike: R(s * 1.1), qty: 1 },
    ],
  },
  {
    id: "bear_put_spread", label: "Bear put spread",
    intent: "Down, cheaper than a put — you sell the downside below the lower strike.",
    build: (s, R) => [
      { kind: "put", dir: 1, strike: R(s), qty: 1 },
      { kind: "put", dir: -1, strike: R(s * 0.9), qty: 1 },
    ],
  },
  {
    id: "straddle", label: "Long straddle",
    intent: "A big move either way. Needs the move to exceed both premiums.",
    build: (s, R) => [
      { kind: "call", dir: 1, strike: R(s), qty: 1 },
      { kind: "put", dir: 1, strike: R(s), qty: 1 },
    ],
  },
  {
    id: "strangle", label: "Long strangle",
    intent: "A big move either way, cheaper than a straddle but needs a bigger one.",
    build: (s, R) => [
      { kind: "call", dir: 1, strike: R(s * 1.1), qty: 1 },
      { kind: "put", dir: 1, strike: R(s * 0.9), qty: 1 },
    ],
  },
  {
    id: "iron_condor", label: "Iron condor",
    intent: "Nothing happens. Credit collected if spot stays inside the short strikes.",
    build: (s, R) => [
      { kind: "put", dir: 1, strike: R(s * 0.85), qty: 1 },
      { kind: "put", dir: -1, strike: R(s * 0.93), qty: 1 },
      { kind: "call", dir: -1, strike: R(s * 1.07), qty: 1 },
      { kind: "call", dir: 1, strike: R(s * 1.15), qty: 1 },
    ],
  },
  {
    id: "butterfly", label: "Call butterfly",
    intent: "Spot pins near the middle strike. Cheap, narrow, low probability.",
    build: (s, R) => [
      { kind: "call", dir: 1, strike: R(s * 0.92), qty: 1 },
      { kind: "call", dir: -1, strike: R(s), qty: 2 },
      { kind: "call", dir: 1, strike: R(s * 1.08), qty: 1 },
    ],
  },
  {
    id: "covered_call", label: "Covered call",
    intent: "Income on stock you already own, capped above the strike.",
    build: (s, R) => [{ kind: "call", dir: -1, strike: R(s * 1.05), qty: 1 }],
    stockNote: "Assumes you hold the underlying — the chart shows the option leg only.",
  },
  {
    id: "protective_put", label: "Protective put",
    intent: "Downside insurance on stock you already own.",
    build: (s, R) => [{ kind: "put", dir: 1, strike: R(s * 0.95), qty: 1 }],
    stockNote: "Assumes you hold the underlying — the chart shows the option leg only.",
  },
  {
    id: "collar", label: "Collar",
    intent: "Insurance funded by capping the upside. Often close to zero cost.",
    build: (s, R) => [
      { kind: "put", dir: 1, strike: R(s * 0.95), qty: 1 },
      { kind: "call", dir: -1, strike: R(s * 1.05), qty: 1 },
    ],
    stockNote: "Assumes you hold the underlying — the chart shows the option legs only.",
  },
];

/**
 * Sensible strike increment for a price level, from a 1-2.5-5 ladder.
 *
 * Capped at 2.5% of spot on purpose. A coarser step silently destroys
 * structures: at a 10-wide step on a 100 spot, an iron condor's 85/93/107/115
 * strikes round to 90/90/110/110 — two cancelling pairs and a position worth
 * exactly nothing. The presets place legs as little as 5% apart, so the step
 * has to stay well inside that.
 */
export function strikeStep(spot: number): number {
  const target = Math.max(spot, 0.5) * 0.025;
  const mag = 10 ** Math.floor(Math.log10(target));
  for (const m of [5, 2.5, 1]) {
    if (m * mag <= target) return m * mag;
  }
  return mag;
}

export function roundToStep(x: number, step: number): number {
  // 1.15 * 100 is 114.99999999999999, which floors to the strike BELOW the
  // one intended. Nudging by an epsilon proportional to the value keeps the
  // rounding on the arithmetic the caller meant.
  return Math.round((x / step) * (1 + Number.EPSILON * 4)) * step;
}

/**
 * Probability the structure finishes profitable, under the SAME lognormal
 * assumption the pricing uses. Reported as a model output, not a forecast:
 * real return distributions have fatter tails than lognormal.
 */
export function probProfit(legs: Leg[], p: PriceInputs): number | null {
  const prof = analyse(legs, p);
  if (!prof.breakevens.length || !(p.T > 0) || !(p.sigma > 0)) return null;
  const drift = (p.r - (p.q ?? 0) - 0.5 * p.sigma * p.sigma) * p.T;
  const vol = p.sigma * Math.sqrt(p.T);
  // P(S_T <= k) under lognormal.
  const cdf = (k: number) => ncdf((Math.log(k / p.S) - drift) / vol);

  // Walk the payoff's sign across the breakeven partition and sum the
  // probability mass of the profitable stretches.
  const bounds = [0, ...prof.breakevens, Infinity];
  let total = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    const mid = b === Infinity ? a * 1.5 + 1 : (a + b) / 2;
    if (payoffAt(legs, mid) - prof.netDebit <= 0) continue;
    total += (b === Infinity ? 1 : cdf(b)) - (a === 0 ? 0 : cdf(a));
  }
  return Math.max(0, Math.min(1, total));
}
