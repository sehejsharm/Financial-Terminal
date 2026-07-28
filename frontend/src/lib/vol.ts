/** Realized-volatility analytics: term structure and the vol cone.
 *
 *  WHY REALIZED AND NOT IMPLIED: an implied-vol surface needs a live option
 *  chain, and the free data path has none — yfinance's option endpoint is
 *  IP-blocked from cloud hosts and NSE F&O isn't wired in. Rather than ship a
 *  surface that renders empty, this computes what the price history can
 *  actually support: close-to-close realized vol, its term structure, and
 *  where today sits inside its own historical distribution.
 *
 *  Pure and dependency-free so it is unit-testable and re-runs in the browser.
 */

export type VolBar = { date: string; close: number };

/** Log returns. Log (not simple) because vol is aggregated by √t, and log
 *  returns are the ones that actually add across periods. */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Annualised realized vol (%) over the LAST `window` returns.
 * NaN — never 0 — when there aren't enough observations to measure.
 */
export function realizedVol(rets: number[], window: number, barsPerYear = 252): number {
  if (rets.length < window || window < 2) return NaN;
  return stdev(rets.slice(-window)) * Math.sqrt(barsPerYear) * 100;
}

/** Rolling annualised vol at every point where the window is full. */
export function rollingVol(rets: number[], window: number, barsPerYear = 252): number[] {
  const out: number[] = [];
  if (window < 2) return out;
  for (let i = window; i <= rets.length; i++) {
    out.push(stdev(rets.slice(i - window, i)) * Math.sqrt(barsPerYear) * 100);
  }
  return out;
}

/** Linear-interpolated percentile of a sorted-able sample. */
export function percentile(values: number[], p: number): number {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return NaN;
  if (xs.length === 1) return xs[0];
  const idx = (p / 100) * (xs.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

/** Where `v` sits inside `values`, as a 0-100 rank. */
export function percentileRank(values: number[], v: number): number {
  const xs = values.filter(Number.isFinite);
  if (!xs.length || !Number.isFinite(v)) return NaN;
  const below = xs.filter((x) => x < v).length;
  const equal = xs.filter((x) => x === v).length;
  return ((below + equal / 2) / xs.length) * 100;
}

export const CONE_WINDOWS = [10, 20, 30, 60, 90, 120, 180, 252];

export type ConePoint = {
  window: number;
  current: number;
  p5: number; p25: number; p50: number; p75: number; p95: number;
  min: number; max: number;
  /** Percentile rank of `current` within this window's own history. */
  rank: number;
  /** Rolling observations behind the distribution. */
  samples: number;
};

export type VolProfile = {
  points: ConePoint[];
  barsPerYear: number;
  bars: number;
  years: number;
  from: string;
  to: string;
  /** Windows dropped because the history couldn't support them. */
  skipped: number[];
};

function yearsBetween(a: string, b: string): number {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 0;
  return (t1 - t0) / (365.2425 * 864e5);
}

/** Minimum rolling observations before a percentile band means anything. */
export const MIN_CONE_SAMPLES = 30;

/**
 * Build the vol cone: for each lookback window, the distribution of that
 * window's rolling realized vol over all available history, plus where the
 * CURRENT reading sits inside it.
 *
 * This is the honest answer to "is vol high right now?" — high relative to
 * this name's own history, at this horizon, rather than against some absolute
 * number that means different things for a utility and a small-cap miner.
 */
export function volProfile(bars: VolBar[]): VolProfile | null {
  const clean = (bars || []).filter((b) => b && Number.isFinite(b.close) && b.close > 0);
  if (clean.length < 40) return null;

  const dates = clean.map((b) => b.date);
  const years = yearsBetween(dates[0], dates[dates.length - 1]);
  // Inferred, not hardcoded: the history feed serves WEEKLY bars on 3Y+
  // windows, and annualising those at √252 would roughly double every figure.
  const barsPerYear = years > 0
    ? Math.min(252, Math.max(4, clean.length / years)) : 252;

  const rets = logReturns(clean.map((b) => b.close));
  const points: ConePoint[] = [];
  const skipped: number[] = [];

  for (const w of CONE_WINDOWS) {
    const roll = rollingVol(rets, w, barsPerYear).filter(Number.isFinite);
    if (roll.length < MIN_CONE_SAMPLES) { skipped.push(w); continue; }
    const current = roll[roll.length - 1];
    points.push({
      window: w,
      current,
      p5: percentile(roll, 5), p25: percentile(roll, 25), p50: percentile(roll, 50),
      p75: percentile(roll, 75), p95: percentile(roll, 95),
      min: Math.min(...roll), max: Math.max(...roll),
      rank: percentileRank(roll, current),
      samples: roll.length,
    });
  }

  if (!points.length) return null;
  return {
    points, barsPerYear, bars: clean.length, years,
    from: dates[0], to: dates[dates.length - 1], skipped,
  };
}

/**
 * Term-structure shape from the shortest to the longest measured window.
 * Backwardation (short vol above long) is the stress signature; contango is
 * the calm one.
 */
export function termShape(p: VolProfile):
    { label: "backwardation" | "contango" | "flat"; shortVol: number; longVol: number; spread: number } {
  const short = p.points[0], long = p.points[p.points.length - 1];
  const spread = short.current - long.current;
  // A couple of vol points either way is noise, not a regime.
  const label = Math.abs(spread) < 2 ? "flat" : spread > 0 ? "backwardation" : "contango";
  return { label, shortVol: short.current, longVol: long.current, spread };
}

/** Plain-English read of a percentile rank, for the headline line. */
export function rankLabel(rank: number): string {
  if (!Number.isFinite(rank)) return "unknown";
  if (rank >= 90) return "extreme";
  if (rank >= 75) return "elevated";
  if (rank >= 25) return "normal";
  if (rank >= 10) return "subdued";
  return "very low";
}

/**
 * Rough 1-sigma move implied by an annualised vol over `days` calendar-ish
 * trading days. Explicitly a normal-distribution approximation — fat tails
 * mean the real chance of a bigger move is higher than the label suggests.
 */
export function expectedMove(spot: number, annVolPct: number, days: number,
                             barsPerYear = 252): number {
  if (!Number.isFinite(spot) || !Number.isFinite(annVolPct) || days <= 0) return NaN;
  return spot * (annVolPct / 100) * Math.sqrt(days / barsPerYear);
}
