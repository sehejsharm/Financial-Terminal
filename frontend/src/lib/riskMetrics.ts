/** Risk and performance analytics for a return series.
 *
 *  Pure functions over an array of periodic simple returns, so every figure
 *  on the Quant page can be tested against a known answer rather than eyeballed.
 *
 *  Two conventions worth stating, because they're where implementations
 *  quietly disagree:
 *
 *  - Annualisation uses a periods-per-year the CALLER supplies, inferred from
 *    the data upstream. Hard-coding 252 silently doubles volatility on the
 *    weekly bars this app's history feed serves for 3Y+ windows.
 *  - Everything returns null where the sample is too small to mean anything,
 *    rather than a number computed from four observations.
 */

export type Stats = {
  n: number;
  mean: number | null;
  stdev: number | null;
  skew: number | null;
  kurtosis: number | null;
};

export type RiskReport = {
  n: number;
  years: number | null;
  /** Cumulative return over the window, percent. */
  totalPct: number | null;
  cagrPct: number | null;
  annVolPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDdPct: number | null;
  /** Longest run of periods spent below a prior peak. */
  maxDdPeriods: number | null;
  /** Historical 5% VaR and the average loss beyond it, both percent. */
  var95Pct: number | null;
  cvar95Pct: number | null;
  hitRatePct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  skew: number | null;
  kurtosis: number | null;
};

export type RelativeReport = {
  beta: number | null;
  /** Annualised Jensen's alpha, percent. */
  alphaPct: number | null;
  r2: number | null;
  /** Annualised standard deviation of the return difference, percent. */
  trackingErrorPct: number | null;
  informationRatio: number | null;
  /** Share of the benchmark's move captured on its up / down periods. */
  upCapturePct: number | null;
  downCapturePct: number | null;
};

const finite = (xs: number[]) => xs.filter((x) => Number.isFinite(x));

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). */
export function stdev(xs: number[]): number | null {
  const v = finite(xs);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

/**
 * Descriptive statistics. Skew and kurtosis need a real sample — below ~8
 * observations they're dominated by noise, so they come back null.
 *
 * Kurtosis is EXCESS kurtosis: 0 is normal, positive means fat tails. That's
 * the convention a reader expects when it's labelled next to a return series.
 */
export function describe(xs: number[]): Stats {
  const v = finite(xs);
  const n = v.length;
  if (n === 0) return { n: 0, mean: null, stdev: null, skew: null, kurtosis: null };
  const m = mean(v);
  const sd = stdev(v);
  if (sd == null || sd === 0 || n < 8) {
    return { n, mean: m, stdev: sd, skew: null, kurtosis: null };
  }
  const m3 = v.reduce((a, x) => a + (x - m) ** 3, 0) / n;
  const m4 = v.reduce((a, x) => a + (x - m) ** 4, 0) / n;
  // Population moments over the sample sd — the common "moment" estimators.
  const pop = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / n);
  return {
    n, mean: m, stdev: sd,
    skew: m3 / pop ** 3,
    kurtosis: m4 / pop ** 4 - 3,
  };
}

/** Equity curve (growth of 1) from periodic simple returns. */
export function equityCurve(returns: number[]): number[] {
  const out: number[] = [];
  let eq = 1;
  for (const r of returns) { eq *= 1 + r; out.push(eq); }
  return out;
}

/** Max drawdown as a NEGATIVE percent, plus the longest underwater run. */
export function drawdown(returns: number[]): { maxPct: number; periods: number } {
  let peak = 1, worst = 0, under = 0, longest = 0, eq = 1;
  for (const r of returns) {
    eq *= 1 + r;
    if (eq >= peak) { peak = eq; under = 0; }
    else { under += 1; longest = Math.max(longest, under); }
    if (peak > 0) worst = Math.min(worst, eq / peak - 1);
  }
  return { maxPct: worst * 100, periods: longest };
}

/** Historical percentile of a sample, linearly interpolated. */
export function percentile(xs: number[], p: number): number | null {
  const v = finite(xs).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** Minimum observations before the headline ratios are reported. */
export const MIN_OBS = 20;

/**
 * Full risk report.
 *
 * `rf` is an ANNUAL risk-free rate as a fraction (0.06 = 6%); it's converted
 * to the period rate before being subtracted, which is the part people most
 * often get wrong by subtracting an annual number from a daily return.
 */
export function riskReport(returns: number[], periodsPerYear: number,
                           rf = 0): RiskReport {
  const v = finite(returns);
  const n = v.length;
  const empty: RiskReport = {
    n, years: null, totalPct: null, cagrPct: null, annVolPct: null,
    sharpe: null, sortino: null, calmar: null, maxDdPct: null,
    maxDdPeriods: null, var95Pct: null, cvar95Pct: null, hitRatePct: null,
    bestPct: null, worstPct: null, skew: null, kurtosis: null,
  };
  if (n < MIN_OBS || !(periodsPerYear > 0)) return empty;

  const d = describe(v);
  const sd = d.stdev;
  const years = n / periodsPerYear;
  const growth = v.reduce((a, r) => a * (1 + r), 1);
  const dd = drawdown(v);

  const rfPeriod = Math.pow(1 + rf, 1 / periodsPerYear) - 1;
  const excess = v.map((r) => r - rfPeriod);
  const downside = excess.filter((r) => r < 0);
  // Downside deviation is measured against the full sample size, not just the
  // negative observations — otherwise a series with few losses reports an
  // implausibly high Sortino.
  const dsd = downside.length
    ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / v.length)
    : 0;

  const annVol = sd == null ? null : sd * Math.sqrt(periodsPerYear);
  const cagr = growth > 0 && years > 0 ? growth ** (1 / years) - 1 : null;
  const annExcess = mean(excess) * periodsPerYear;

  const sortedTail = finite(v).slice().sort((a, b) => a - b);
  const var95 = percentile(v, 5);
  const tail = var95 == null ? [] : sortedTail.filter((r) => r <= var95);

  return {
    n,
    years,
    totalPct: (growth - 1) * 100,
    cagrPct: cagr == null ? null : cagr * 100,
    annVolPct: annVol == null ? null : annVol * 100,
    sharpe: annVol && annVol > 0 ? annExcess / annVol : null,
    sortino: dsd > 0 ? annExcess / (dsd * Math.sqrt(periodsPerYear)) : null,
    calmar: cagr != null && dd.maxPct < 0 ? (cagr * 100) / Math.abs(dd.maxPct) : null,
    maxDdPct: dd.maxPct,
    maxDdPeriods: dd.periods,
    var95Pct: var95 == null ? null : var95 * 100,
    cvar95Pct: tail.length ? mean(tail) * 100 : null,
    hitRatePct: (v.filter((r) => r > 0).length / n) * 100,
    bestPct: Math.max(...v) * 100,
    worstPct: Math.min(...v) * 100,
    skew: d.skew,
    kurtosis: d.kurtosis,
  };
}

/** Performance relative to a benchmark. Both series must already be aligned. */
export function relativeReport(asset: number[], bench: number[],
                               periodsPerYear: number, rf = 0): RelativeReport {
  const n = Math.min(asset.length, bench.length);
  const empty: RelativeReport = {
    beta: null, alphaPct: null, r2: null, trackingErrorPct: null,
    informationRatio: null, upCapturePct: null, downCapturePct: null,
  };
  if (n < MIN_OBS || !(periodsPerYear > 0)) return empty;

  const a = asset.slice(-n), b = bench.slice(-n);
  const ma = mean(a), mb = mean(b);
  let cov = 0, varb = 0, vara = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    varb += (b[i] - mb) ** 2;
    vara += (a[i] - ma) ** 2;
  }
  if (varb <= 0) return empty;
  const beta = cov / varb;
  const r2 = vara > 0 ? (cov * cov) / (vara * varb) : null;

  const rfPeriod = Math.pow(1 + rf, 1 / periodsPerYear) - 1;
  // Jensen's alpha, annualised.
  const alpha = ((ma - rfPeriod) - beta * (mb - rfPeriod)) * periodsPerYear;

  const diff = a.map((x, i) => x - b[i]);
  const te = stdev(diff);
  const teAnn = te == null ? null : te * Math.sqrt(periodsPerYear);

  const upIdx = b.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
  const dnIdx = b.map((x, i) => (x < 0 ? i : -1)).filter((i) => i >= 0);
  const capture = (idx: number[]): number | null => {
    if (!idx.length) return null;
    const mb2 = mean(idx.map((i) => b[i]));
    if (mb2 === 0) return null;
    return (mean(idx.map((i) => a[i])) / mb2) * 100;
  };

  return {
    beta,
    alphaPct: alpha * 100,
    r2,
    trackingErrorPct: teAnn == null ? null : teAnn * 100,
    informationRatio: teAnn && teAnn > 0
      ? (mean(diff) * periodsPerYear) / teAnn : null,
    upCapturePct: capture(upIdx),
    downCapturePct: capture(dnIdx),
  };
}

/** Histogram of returns, for the distribution chart. */
export function histogram(returns: number[], bins = 25):
    { mid: number; count: number; from: number; to: number }[] {
  const v = finite(returns);
  if (v.length < 2 || bins < 1) return [];
  const lo = Math.min(...v), hi = Math.max(...v);
  if (!(hi > lo)) return [];
  const w = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({
    from: lo + i * w, to: lo + (i + 1) * w, mid: lo + (i + 0.5) * w, count: 0,
  }));
  for (const r of v) {
    // The final bin is closed at the top so the maximum lands inside it.
    const i = Math.min(bins - 1, Math.floor((r - lo) / w));
    out[i].count += 1;
  }
  return out;
}

/** Rolling annualised volatility, aligned to the input (null until full). */
export function rollingVol(returns: number[], window: number,
                           periodsPerYear: number): (number | null)[] {
  const out: (number | null)[] = new Array(returns.length).fill(null);
  if (window < 2) return out;
  for (let i = window - 1; i < returns.length; i++) {
    const sd = stdev(returns.slice(i - window + 1, i + 1));
    out[i] = sd == null ? null : sd * Math.sqrt(periodsPerYear) * 100;
  }
  return out;
}
