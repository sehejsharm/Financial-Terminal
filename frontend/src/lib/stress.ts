/** MARS — portfolio stress testing.
 *
 *  Two independent methods, deliberately, because they fail in different ways:
 *
 *  1. HISTORICAL REPLAY. Take a real stress window (the worst benchmark
 *     drawdowns actually present in the history) and ask what TODAY's weights
 *     would have done through it, using each holding's own realised returns.
 *     No factor model, no assumed correlation — it uses the co-movement that
 *     actually happened. Its weakness is that it can only replay windows the
 *     data covers, and a holding that didn't trade then is simply unmodelled.
 *
 *  2. FACTOR SHOCK. Regress each holding on the benchmark and push a
 *     hypothetical shock through the estimated betas. It can express any
 *     scenario, including ones that never happened — but a beta is a summary
 *     of average days, and stress is when betas break. R² is reported per
 *     holding so weak fits are visible rather than buried in a single number.
 *
 *  Everything here is pure so it can be unit-tested; coverage is always
 *  reported so a result computed on half a portfolio never reads as a result
 *  for the whole one.
 */

export type StressPosition = { ticker: string; value: number };
export type Series = { dates: string[]; closes: number[] };
export type SeriesMap = Record<string, Series>;

// ── shared helpers ─────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/** Simple return between the first and last close in [from, to] inclusive. */
export function windowReturn(s: Series, from: string, to: string): number | null {
  let a = -1, b = -1;
  for (let i = 0; i < s.dates.length; i++) {
    const d = s.dates[i];
    if (d >= from && a < 0) a = i;
    if (d <= to) b = i;
  }
  if (a < 0 || b <= a) return null;
  const p0 = s.closes[a], p1 = s.closes[b];
  if (!(p0 > 0) || !(p1 > 0)) return null;
  return p1 / p0 - 1;
}

// ── 1. historical replay ───────────────────────────────────────────────────

export type StressWindow = {
  from: string; to: string;
  /** Benchmark return across the window, as a fraction. */
  benchRet: number;
  bars: number;
  label: string;
};

/**
 * The worst non-overlapping benchmark stretches of `bars` length.
 *
 * Non-overlapping matters: the naive version returns the same crash five
 * times shifted by a day each, which looks like five scenarios and is one.
 */
export function findWorstWindows(bench: Series, bars: number, topN = 3): StressWindow[] {
  const n = bench.dates.length;
  if (n < bars + 1) return [];
  const cands: StressWindow[] = [];
  for (let i = 0; i + bars < n; i++) {
    const p0 = bench.closes[i], p1 = bench.closes[i + bars];
    if (!(p0 > 0) || !(p1 > 0)) continue;
    cands.push({
      from: bench.dates[i], to: bench.dates[i + bars],
      benchRet: p1 / p0 - 1, bars,
      label: `${bench.dates[i]} → ${bench.dates[i + bars]}`,
    });
  }
  cands.sort((a, b) => a.benchRet - b.benchRet);

  const out: StressWindow[] = [];
  const usedFrom: number[] = [];
  const idxOf = new Map(bench.dates.map((d, i) => [d, i]));
  for (const c of cands) {
    if (out.length >= topN) break;
    const i = idxOf.get(c.from)!;
    if (usedFrom.some((u) => Math.abs(u - i) < bars)) continue;   // overlaps a pick
    out.push(c);
    usedFrom.push(i);
  }
  return out;
}

export type ReplayLeg = {
  ticker: string;
  value: number;
  weight: number;
  ret: number | null;
  pnl: number | null;
  /** No price history covering this window — excluded, never assumed flat. */
  unmodelled: boolean;
};

export type ReplayResult = {
  window: StressWindow;
  legs: ReplayLeg[];
  /** Impact on the MODELLED slice only, as a fraction of its value. */
  portfolioRet: number;
  pnl: number;
  modelledValue: number;
  totalValue: number;
  /** Share of portfolio value the result actually covers, 0-100. */
  coveragePct: number;
  worst: ReplayLeg | null;
  best: ReplayLeg | null;
};

/**
 * Apply a historical window to today's weights.
 *
 * The return is expressed over the MODELLED value, not the total, so a
 * portfolio where half the names have no history doesn't get its loss halved
 * by silently treating the other half as unchanged.
 */
export function replayWindow(
  positions: StressPosition[], series: SeriesMap, w: StressWindow,
): ReplayResult {
  const totalValue = positions.reduce((a, p) => a + (p.value || 0), 0);
  const legs: ReplayLeg[] = positions.map((p) => {
    const s = series[p.ticker];
    const ret = s ? windowReturn(s, w.from, w.to) : null;
    return {
      ticker: p.ticker, value: p.value || 0,
      weight: totalValue > 0 ? (p.value || 0) / totalValue : 0,
      ret, pnl: ret == null ? null : (p.value || 0) * ret,
      unmodelled: ret == null,
    };
  });

  const modelled = legs.filter((l) => !l.unmodelled);
  const modelledValue = modelled.reduce((a, l) => a + l.value, 0);
  const pnl = modelled.reduce((a, l) => a + (l.pnl || 0), 0);
  const ranked = [...modelled].sort((a, b) => (a.ret! - b.ret!));

  return {
    window: w, legs,
    portfolioRet: modelledValue > 0 ? pnl / modelledValue : 0,
    pnl, modelledValue, totalValue,
    coveragePct: totalValue > 0 ? (modelledValue / totalValue) * 100 : 0,
    worst: ranked[0] ?? null,
    best: ranked[ranked.length - 1] ?? null,
  };
}

// ── 2. factor shock ────────────────────────────────────────────────────────

export type BetaFit = {
  beta: number;
  /** How much of this holding's movement the benchmark explains, 0-1. */
  r2: number;
  n: number;
};

/** OLS slope of asset on benchmark, plus the R² of that fit. */
export function estimateBeta(asset: number[], bench: number[]): BetaFit | null {
  const n = Math.min(asset.length, bench.length);
  if (n < 30) return null;                 // too few points to mean anything
  const a = asset.slice(-n), b = bench.slice(-n);
  const ma = mean(a), mb = mean(b);
  let cov = 0, varb = 0, vara = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    varb += (b[i] - mb) ** 2;
    vara += (a[i] - ma) ** 2;
  }
  if (varb <= 0 || vara <= 0) return null;
  const beta = cov / varb;
  const r2 = (cov * cov) / (vara * varb);
  return { beta, r2, n };
}

/** Daily simple returns aligned on the dates the two series share. */
export function alignedReturns(a: Series, b: Series): { a: number[]; b: number[] } {
  const bm = new Map(b.dates.map((d, i) => [d, b.closes[i]]));
  const da: number[] = [], db: number[] = [];
  let pa: number | null = null, pb: number | null = null;
  for (let i = 0; i < a.dates.length; i++) {
    const cb = bm.get(a.dates[i]);
    const ca = a.closes[i];
    if (cb == null || !(ca > 0) || !(cb > 0)) continue;
    if (pa != null && pb != null) { da.push(ca / pa - 1); db.push(cb / pb - 1); }
    pa = ca; pb = cb;
  }
  return { a: da, b: db };
}

export type ShockLeg = {
  ticker: string;
  value: number;
  weight: number;
  fit: BetaFit | null;
  ret: number | null;
  pnl: number | null;
  unmodelled: boolean;
};

export type ShockResult = {
  shockPct: number;
  legs: ShockLeg[];
  portfolioRet: number;
  pnl: number;
  modelledValue: number;
  totalValue: number;
  coveragePct: number;
  /** Value-weighted beta of the modelled slice. */
  portfolioBeta: number | null;
  /** Holdings whose fit is too weak for the estimate to carry weight. */
  weakFits: string[];
};

/** R² below this and the beta is a number, not an explanation. */
export const WEAK_R2 = 0.2;

export function applyShock(
  positions: StressPosition[], fits: Record<string, BetaFit | null>, shockPct: number,
): ShockResult {
  const shock = shockPct / 100;
  const totalValue = positions.reduce((a, p) => a + (p.value || 0), 0);
  const legs: ShockLeg[] = positions.map((p) => {
    const fit = fits[p.ticker] ?? null;
    const ret = fit ? fit.beta * shock : null;
    return {
      ticker: p.ticker, value: p.value || 0,
      weight: totalValue > 0 ? (p.value || 0) / totalValue : 0,
      fit, ret, pnl: ret == null ? null : (p.value || 0) * ret,
      unmodelled: fit == null,
    };
  });

  const modelled = legs.filter((l) => !l.unmodelled);
  const modelledValue = modelled.reduce((a, l) => a + l.value, 0);
  const pnl = modelled.reduce((a, l) => a + (l.pnl || 0), 0);

  return {
    shockPct, legs, pnl, modelledValue, totalValue,
    portfolioRet: modelledValue > 0 ? pnl / modelledValue : 0,
    coveragePct: totalValue > 0 ? (modelledValue / totalValue) * 100 : 0,
    portfolioBeta: modelledValue > 0
      ? modelled.reduce((a, l) => a + l.fit!.beta * (l.value / modelledValue), 0) : null,
    weakFits: modelled.filter((l) => l.fit!.r2 < WEAK_R2).map((l) => l.ticker),
  };
}
