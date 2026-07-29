/** Reported versus expected.
 *
 *  The earnings screen drew a bar per quarter and printed the raw provider
 *  frame underneath. Neither answers the question anyone brings to it: does
 *  this company habitually beat, by how much, and is that changing?
 *
 *  A single beat is noise. A record of eight quarters, with a hit rate and a
 *  typical size, is a fact about how management guides — and it is the thing
 *  that makes the next print interpretable.
 *
 *  Pure so the surprise convention is testable. Getting the sign wrong on a
 *  loss-making quarter is easy and produces numbers that look fine.
 */

export type Frameish = {
  columns: string[];
  rows: Array<Record<string, number | string | null>>;
};

export type SurpriseRow = {
  period: string;
  actual: number;
  estimate: number;
  /** Actual less estimate, in the reporting currency. */
  diff: number;
  /**
   * Surprise as a percentage of the ESTIMATE's magnitude. Null when the
   * estimate is zero — dividing by it produces an infinity that dominates
   * every average it enters.
   */
  surprisePct: number | null;
  beat: boolean;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Column whose name matches any of these, case- and separator-insensitive. */
function pickCol(columns: string[], candidates: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = candidates.map(norm);
  for (const c of columns) if (wanted.includes(norm(c))) return c;
  return null;
}

/**
 * Turn a provider frame into comparable rows, oldest first.
 *
 * yfinance calls the columns epsActual/epsEstimate; other shapes have been
 * seen. Rows without both sides are dropped rather than defaulted — a
 * quarter with no estimate cannot be a beat or a miss.
 */
export function parseSurprises(frame: Frameish | null): SurpriseRow[] {
  if (!frame?.rows?.length) return [];
  const cols = frame.columns ?? [];
  const actCol = pickCol(cols, ["epsActual", "actual", "reportedEPS", "eps"]);
  const estCol = pickCol(cols, ["epsEstimate", "estimate", "estimatedEPS",
                                "consensus"]);
  const perCol = pickCol(cols, ["quarter", "period", "date", "index",
                                "fiscalPeriod"]) ?? cols[0];
  if (!actCol || !estCol) return [];

  const rows: SurpriseRow[] = [];
  for (const r of frame.rows) {
    const actual = num(r[actCol]);
    const estimate = num(r[estCol]);
    if (actual == null || estimate == null) continue;
    const diff = actual - estimate;
    rows.push({
      period: String(r[perCol] ?? "").slice(0, 10),
      actual,
      estimate,
      diff,
      // Magnitude in the denominator: a company expected to lose 0.50 and
      // losing 0.40 has beaten by 20%, and dividing by the signed estimate
      // would report that as −20%.
      surprisePct: estimate === 0 ? null : (diff / Math.abs(estimate)) * 100,
      beat: diff > 0,
    });
  }
  rows.sort((a, b) => {
    const ta = Date.parse(a.period), tb = Date.parse(b.period);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return a.period.localeCompare(b.period);
  });
  return rows;
}

export type SurpriseSummary = {
  n: number;
  beats: number;
  misses: number;
  inLine: number;
  /** Share of periods where the actual exceeded the estimate. */
  beatRatePct: number | null;
  /** Median surprise — the typical result, not the one skewed by an outlier. */
  medianSurprisePct: number | null;
  meanSurprisePct: number | null;
  /** The most recent surprise, which is what the market just reacted to. */
  latest: SurpriseRow | null;
  /** Longest run of consecutive beats ending at the latest period. */
  currentStreak: number;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The record, summarised.
 *
 * Reports the MEDIAN surprise alongside the mean: one quarter with a tiny
 * estimate produces a 400% surprise that drags a mean somewhere useless. The
 * median is the typical print.
 */
export function surpriseSummary(rows: SurpriseRow[]): SurpriseSummary {
  const pcts = rows.map((r) => r.surprisePct)
    .filter((v): v is number => v != null);
  // "In line" is a real category: an exact match is neither a beat nor a
  // miss, and counting it as a miss understates every hit rate.
  const beats = rows.filter((r) => r.diff > 0).length;
  const misses = rows.filter((r) => r.diff < 0).length;
  const inLine = rows.filter((r) => r.diff === 0).length;

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].diff > 0) streak += 1;
    else break;
  }

  return {
    n: rows.length,
    beats,
    misses,
    inLine,
    beatRatePct: rows.length ? (beats / rows.length) * 100 : null,
    medianSurprisePct: median(pcts),
    meanSurprisePct: pcts.length
      ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    latest: rows.length ? rows[rows.length - 1] : null,
    currentStreak: streak,
  };
}

/**
 * One honest sentence about the record.
 *
 * Says outright what a beat rate does and does not mean. A company that
 * beats every quarter is usually guiding conservatively rather than
 * outperforming, and that distinction changes what the next beat is worth.
 */
export function surpriseNote(s: SurpriseSummary): string {
  if (!s.n) return "No period has both a reported figure and an estimate, so "
    + "there is no surprise history to summarise.";
  if (s.n < 4) {
    return `Only ${s.n} comparable ${s.n === 1 ? "period" : "periods"} — too `
      + "few to call a pattern. A hit rate needs a record, not a couple of "
      + "prints.";
  }
  const parts = [
    `Beat in ${s.beats} of ${s.n} periods`
      + (s.inLine ? ` (${s.inLine} in line)` : "")
      + `, a ${s.beatRatePct!.toFixed(0)}% hit rate.`,
  ];
  if (s.medianSurprisePct != null) {
    parts.push(`The typical surprise is ${s.medianSurprisePct >= 0 ? "+" : ""}`
      + `${s.medianSurprisePct.toFixed(1)}% against the estimate.`);
  }
  if (s.currentStreak >= 3) {
    parts.push(`${s.currentStreak} consecutive beats.`);
  }
  parts.push("A high hit rate usually means management guides conservatively "
    + "rather than that the business keeps outperforming — which is why a "
    + "routine beat moves the price less than a first miss does.");
  return parts.join(" ");
}
