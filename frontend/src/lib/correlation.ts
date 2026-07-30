/** Reading a correlation matrix honestly.
 *
 *  The Quant tab aligned every series on shared trading days, computed Pearson
 *  correlations, and rendered a grid. The arithmetic was right and the
 *  presentation had three problems, each of which makes a number look more
 *  solid than it is.
 *
 *  First, alignment is an intersection. Add one ticker that listed in March
 *  and every pair in the matrix silently drops to the ninety days they share —
 *  a correlation on ninety observations rendered in exactly the same type as
 *  one on two hundred and fifty.
 *
 *  Second, a correlation has a standard error. On sixty observations anything
 *  under about 0.25 is indistinguishable from zero, and the grid presented
 *  0.18 as a finding.
 *
 *  Third, a beta with no R² is not a number anyone should act on. A beta of
 *  1.8 that explains 4% of the variance says the regression found nothing, and
 *  the column looked identical to a beta that explains 80%.
 *
 *  And a grid of numbers is not a reading. The questions are which pairs are
 *  effectively the same position and how much diversification the set actually
 *  provides — both answerable, neither answered.
 */

export type Series = { ticker: string; dates: string[]; closes: number[] };

/** Sessions below which a correlation is not worth computing at all. */
export const MIN_OBSERVATIONS = 30;

export type Aligned = {
  tickers: string[];
  /** Daily simple returns per ticker, all the same length. */
  returns: number[][];
  /** Trading days shared by EVERY series. */
  shared: number;
  /** The longest single series, so the cost of the intersection is visible. */
  longest: number;
  /** The ticker whose history is shortest — the one doing the truncating. */
  limitedBy: string | null;
};

/**
 * Align every series on the dates they all share, then difference to returns.
 *
 * Reports what the intersection cost. A set where one name truncates the rest
 * from 250 sessions to 90 produces a perfectly valid matrix that describes a
 * different, much shorter period than the reader assumes — and nothing on the
 * old screen said so.
 */
export function alignReturns(series: Series[]): Aligned {
  const usable = series.filter((s) => s.dates.length && s.closes.length);
  if (usable.length < 2) {
    return { tickers: usable.map((s) => s.ticker), returns: [], shared: 0,
      longest: Math.max(0, ...usable.map((s) => s.dates.length)), limitedBy: null };
  }
  let common: Set<string> | null = null;
  for (const s of usable) {
    const set = new Set<string>(s.dates);
    common = common
      ? new Set<string>([...common].filter((d: string) => set.has(d)))
      : set;
  }
  const dates: string[] = [...(common ?? new Set<string>())].sort();

  const returns = usable.map((s) => {
    const byDate = new Map(s.dates.map((d, i) => [d, s.closes[i]]));
    const px = dates.map((d) => byDate.get(d)!);
    const r: number[] = [];
    for (let i = 1; i < px.length; i++) {
      const prev = px[i - 1];
      // A zero or missing close would produce an infinite return that then
      // poisons every correlation the series appears in.
      r.push(prev > 0 && px[i] > 0 ? px[i] / prev - 1 : 0);
    }
    return r;
  });

  const shortest = usable.reduce((a, b) => (b.dates.length < a.dates.length ? b : a));
  return {
    tickers: usable.map((s) => s.ticker),
    returns,
    shared: Math.max(0, dates.length - 1),
    longest: Math.max(...usable.map((s) => s.dates.length)) - 1,
    // Only name a limiter when it actually cost something.
    limitedBy: shortest.dates.length < Math.max(...usable.map((s) => s.dates.length))
      ? shortest.ticker : null,
  };
}

/** Pearson correlation. Null rather than NaN when there isn't enough to say. */
export function pearson(a: number[], b: number[],
                        minN = MIN_OBSERVATIONS): number | null {
  const n = Math.min(a.length, b.length);
  if (n < minN) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  // A flat series has no variance, so nothing can correlate with it.
  if (da <= 0 || db <= 0) return null;
  const r = num / Math.sqrt(da * db);
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

/**
 * The correlation below which the sample can't distinguish it from zero.
 *
 * The two-sided 5% critical value for r, from the t distribution with n−2
 * degrees of freedom, approximated as 1.96/√(n−1) — close enough above n=30
 * and it errs slightly conservative, which is the right direction.
 */
export function significanceThreshold(n: number): number | null {
  if (n < 4) return null;
  return Math.min(1, 1.96 / Math.sqrt(n - 1));
}

export function isSignificant(r: number | null, n: number): boolean {
  const t = significanceThreshold(n);
  return r != null && t != null && Math.abs(r) >= t;
}

export type Matrix = {
  tickers: string[];
  values: (number | null)[][];
  n: number;
  threshold: number | null;
};

export function matrix(a: Aligned, minN = MIN_OBSERVATIONS): Matrix {
  const values = a.tickers.map((_, i) =>
    a.tickers.map((_, j) =>
      i === j ? 1 : pearson(a.returns[i] ?? [], a.returns[j] ?? [], minN)));
  return {
    tickers: a.tickers, values, n: a.shared,
    threshold: significanceThreshold(a.shared),
  };
}

export type Pair = { a: string; b: string; r: number };

/** Every off-diagonal pair once, strongest first. */
export function pairs(m: Matrix): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < m.tickers.length; i++) {
    for (let j = i + 1; j < m.tickers.length; j++) {
      const r = m.values[i][j];
      if (r != null) out.push({ a: m.tickers[i], b: m.tickers[j], r });
    }
  }
  return out.sort((x, y) => y.r - x.r);
}

export type MatrixRead = {
  /** Mean of the off-diagonal correlations. */
  averageR: number | null;
  /** Pairs above 0.9 — effectively one position held twice. */
  redundant: Pair[];
  mostCorrelated: Pair | null;
  leastCorrelated: Pair | null;
  /** Rough count of independent bets: N / (1 + (N−1)·r̄). */
  effectiveBets: number | null;
  count: number;
};

/** Pairs this correlated are the same trade wearing two tickers. */
export const REDUNDANT_R = 0.9;

/**
 * What the grid says, rather than what it contains.
 *
 * The effective-bets figure is the useful one: at an average pairwise
 * correlation of 0.8, ten names behave like about 1.2 independent positions.
 * A reader counting tickers thinks they hold ten.
 */
export function readMatrix(m: Matrix): MatrixRead {
  const ps = pairs(m);
  if (!ps.length) {
    return { averageR: null, redundant: [], mostCorrelated: null,
      leastCorrelated: null, effectiveBets: null, count: m.tickers.length };
  }
  const avg = ps.reduce((a, p) => a + p.r, 0) / ps.length;
  const N = m.tickers.length;
  const denom = 1 + (N - 1) * avg;
  return {
    averageR: avg,
    redundant: ps.filter((p) => p.r >= REDUNDANT_R),
    mostCorrelated: ps[0],
    leastCorrelated: ps[ps.length - 1],
    // Negative or near-zero denominators mean the average correlation is
    // strongly negative, where the formula stops being meaningful.
    effectiveBets: denom > 0.01 ? N / denom : null,
    count: N,
  };
}

export function matrixNote(m: Matrix, r: MatrixRead, a: Aligned): string {
  if (!m.n || m.n < MIN_OBSERVATIONS) {
    return `Only ${m.n} trading days are shared by all of these series — under `
      + `${MIN_OBSERVATIONS} the correlations would be noise, so they are not `
      + "computed. Drop the shortest-history ticker and try again.";
  }
  const parts: string[] = [];

  parts.push(`Computed on the ${m.n} trading days ALL of these series share.`);
  if (a.limitedBy && a.shared < a.longest * 0.8) {
    parts.push(`That is well short of the ${a.longest} the longest series has — `
      + `${a.limitedBy} has the shortest history and truncates every pair in the `
      + "grid. Every number here describes that shorter window, not the year.");
  }

  if (m.threshold != null) {
    parts.push(`At this sample size anything under about `
      + `${m.threshold.toFixed(2)} is not distinguishable from zero. Cells below `
      + "that are dimmed rather than dropped, because an absent number reads as "
      + "missing data.");
  }

  if (r.effectiveBets != null && r.averageR != null) {
    parts.push(`Average pairwise correlation is ${r.averageR.toFixed(2)}, so `
      + `${r.count} tickers behave like roughly ${r.effectiveBets.toFixed(1)} `
      + "independent positions. That gap is the whole point of the grid — "
      + "counting tickers overstates diversification whenever they move "
      + "together.");
  }
  if (r.redundant.length) {
    const names = r.redundant.slice(0, 3)
      .map((p) => `${p.a}/${p.b} (${p.r.toFixed(2)})`).join(", ");
    parts.push(`Above ${REDUNDANT_R}, a pair is one trade wearing two tickers: `
      + `${names}${r.redundant.length > 3 ? ", and others" : ""}.`);
  }

  parts.push("Correlation is not causation and not stability: these are "
    + "realised co-movements over one window, and correlations across equities "
    + "converge towards 1 in a selloff — exactly when the diversification is "
    + "being relied on.");
  return parts.join(" ");
}

// ── beta, with the fit that says whether to believe it ────────────────────

export type BetaFit = {
  ticker: string;
  beta: number | null;
  /** Share of the asset's variance the benchmark explains, 0–1. */
  rSquared: number | null;
  /** Daily intercept, in percent — the part beta doesn't explain. */
  alphaPct: number | null;
  n: number;
};

/**
 * Beta AND its R².
 *
 * Beta on its own is a slope with no claim about fit. A beta of 1.8 that
 * explains 4% of the variance means the regression found essentially nothing
 * and the slope is an artefact; presented in the same column as a beta that
 * explains 80%, the two are indistinguishable. R² is what separates them.
 */
export function betaFit(ticker: string, asset: number[], bench: number[],
                        minN = MIN_OBSERVATIONS): BetaFit {
  const n = Math.min(asset.length, bench.length);
  if (n < minN) return { ticker, beta: null, rSquared: null, alphaPct: null, n };

  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += asset[i]; mb += bench[i]; }
  ma /= n; mb /= n;

  let cov = 0, varb = 0, vara = 0;
  for (let i = 0; i < n; i++) {
    cov += (asset[i] - ma) * (bench[i] - mb);
    varb += (bench[i] - mb) ** 2;
    vara += (asset[i] - ma) ** 2;
  }
  // A benchmark that never moved has no slope to regress against.
  if (varb <= 0) return { ticker, beta: null, rSquared: null, alphaPct: null, n };

  const beta = cov / varb;
  const r = vara > 0 ? cov / Math.sqrt(vara * varb) : null;
  return {
    ticker,
    beta,
    rSquared: r == null ? null : r * r,
    alphaPct: (ma - beta * mb) * 100,
    n,
  };
}

/** Below this, the benchmark explains so little that the slope is an artefact. */
export const WEAK_FIT = 0.2;

export function betaNote(fits: BetaFit[], bench: string): string {
  const usable = fits.filter((f) => f.beta != null);
  if (!usable.length) {
    return `No series has enough overlap with ${bench} to regress against it.`;
  }
  const weak = usable.filter((f) => (f.rSquared ?? 0) < WEAK_FIT);
  const parts = [
    `Slopes against ${bench} over the shared window, each with the R² that `
      + "says whether to believe it — a beta explaining 4% of the variance is "
      + "an artefact of the regression, not a sensitivity, and without R² it "
      + "looks identical to one explaining 80%.",
  ];
  if (weak.length) {
    parts.push(`${weak.map((f) => f.ticker).join(", ")} `
      + `${weak.length === 1 ? "has" : "have"} an R² under ${WEAK_FIT}: `
      + `${bench} explains almost none of their movement, so their betas mean `
      + "little whatever the number says.");
  }
  parts.push("These are computed here from daily returns over this window. They "
    + "will differ from the provider beta on the Snapshot and WACC screens, "
    + "which is typically five years of monthly returns against the listing "
    + "exchange's index — neither is more correct, and the difference is the "
    + "window, not an error.");
  return parts.join(" ");
}
