/** Where a company sits against its peers.
 *
 *  The comps screen printed a grid of multiples and left the reader to scan
 *  columns and do the comparison in their head. But the grid is not the
 *  point — the point is one question per metric: is this name expensive or
 *  cheap relative to the others, and by how much?
 *
 *  So every metric gets a peer median, a premium or discount against it, and
 *  a rank. Those three turn a table into an answer.
 *
 *  The median, not the mean: a peer set of eight where one has a P/E of 180
 *  because its earnings collapsed produces a mean nobody would use, and the
 *  screen would then report everything else as a huge discount.
 */

export type CompRowish = Record<string, number | string | null>;

export type MetricDef = {
  key: string;
  label: string;
  /** Lower is cheaper (valuation) or higher is better (quality). */
  direction: "lower-cheaper" | "higher-better";
  unit: "x" | "%";
};

/** The columns the comps endpoint emits, and how to read each one. */
export const COMP_METRICS: MetricDef[] = [
  { key: "P/E", label: "P/E", direction: "lower-cheaper", unit: "x" },
  { key: "Fwd P/E", label: "Forward P/E", direction: "lower-cheaper", unit: "x" },
  { key: "P/B", label: "P/B", direction: "lower-cheaper", unit: "x" },
  { key: "P/S", label: "P/S", direction: "lower-cheaper", unit: "x" },
  { key: "EV/EBITDA*", label: "EV/EBITDA", direction: "lower-cheaper", unit: "x" },
  { key: "ROE%", label: "ROE", direction: "higher-better", unit: "%" },
];

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The subject's row, matched on ticker however the provider spelled it. */
export function findSubject(rows: CompRowish[], ticker: string): CompRowish | null {
  // The endpoint strips ".NS", so "RELIANCE.NS" has to match "RELIANCE".
  const want = ticker.split(".")[0].toUpperCase();
  return rows.find((r) => String(r.Ticker ?? "").toUpperCase() === want) ?? null;
}

export type MetricComparison = {
  key: string;
  label: string;
  unit: MetricDef["unit"];
  /** The subject's own value. */
  value: number | null;
  /** Median across every peer that reported this metric, subject included. */
  peerMedian: number | null;
  /** Subject vs median, in percent. Positive = above the median. */
  premiumPct: number | null;
  /** 1 = lowest value. Only meaningful alongside `n`. */
  rank: number | null;
  n: number;
  /**
   * "cheap" / "expensive" for a valuation multiple, "strong" / "weak" for a
   * quality metric, null when there is nothing to say.
   */
  verdict: "cheap" | "expensive" | "in line" | "strong" | "weak" | null;
};

/** Below this many reporting peers, a median is not a comparison. */
export const MIN_PEERS = 3;

/** A premium or discount smaller than this is noise, not a position. */
export const IN_LINE_PCT = 10;

export function compareMetric(rows: CompRowish[], ticker: string,
                              def: MetricDef): MetricComparison {
  const vals = rows.map((r) => numOf(r[def.key]))
    .filter((v): v is number => v != null);
  const subject = findSubject(rows, ticker);
  const value = subject ? numOf(subject[def.key]) : null;
  const med = median(vals);

  const base: MetricComparison = {
    key: def.key, label: def.label, unit: def.unit,
    value, peerMedian: med, premiumPct: null, rank: null,
    n: vals.length, verdict: null,
  };
  if (value == null || med == null || med === 0 || vals.length < MIN_PEERS) {
    return base;
  }

  const premium = ((value - med) / Math.abs(med)) * 100;
  const sorted = [...vals].sort((a, b) => a - b);
  const rank = sorted.indexOf(value) + 1;

  let verdict: MetricComparison["verdict"];
  if (Math.abs(premium) < IN_LINE_PCT) {
    verdict = "in line";
  } else if (def.direction === "lower-cheaper") {
    verdict = premium > 0 ? "expensive" : "cheap";
  } else {
    verdict = premium > 0 ? "strong" : "weak";
  }
  return { ...base, premiumPct: premium, rank, verdict };
}

export function compareAll(rows: CompRowish[], ticker: string,
                           defs: MetricDef[] = COMP_METRICS): MetricComparison[] {
  return defs
    .filter((d) => rows.some((r) => numOf(r[d.key]) != null))
    .map((d) => compareMetric(rows, ticker, d));
}

/**
 * One sentence on where the name trades.
 *
 * Counts how many valuation multiples say expensive versus cheap rather than
 * averaging them, because the multiples are on different scales and an
 * average of a P/E and a P/B is not a number.
 */
export function peerNote(cmps: MetricComparison[], ticker: string,
                         peerCount: number): string {
  const valuation = cmps.filter((c) => c.unit === "x" && c.verdict);
  if (peerCount < MIN_PEERS + 1) {
    return `Only ${peerCount} names in this set. A median across fewer than `
      + `${MIN_PEERS} reporting peers is not a comparison — add more peers `
      + "above.";
  }
  if (!valuation.length) {
    return "No valuation multiple is available for enough of this peer set to "
      + "compare against.";
  }
  const rich = valuation.filter((c) => c.verdict === "expensive").length;
  const cheap = valuation.filter((c) => c.verdict === "cheap").length;
  const inLine = valuation.filter((c) => c.verdict === "in line").length;

  const lead = rich > cheap
    ? `${ticker} trades above the peer median on ${rich} of ${valuation.length} multiples`
    : cheap > rich
      ? `${ticker} trades below the peer median on ${cheap} of ${valuation.length} multiples`
      : `${ticker} sits close to the peer median (${inLine} of ${valuation.length} in line)`;

  return `${lead}. A discount is not automatically an opportunity: peers with `
    + "different growth, leverage and returns should trade at different "
    + "multiples, and this screen deliberately does not adjust for any of "
    + "that.";
}

/**
 * Sort rows for display, nulls last.
 *
 * Same rule as everywhere else in the app: most peers are missing at least
 * one multiple, and letting nulls float to the top in ascending order buries
 * every row that carries a number.
 */
export function sortComps(rows: CompRowish[], key: string,
                          dir: "asc" | "desc"): CompRowish[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    const an = numOf(av), bn = numOf(bv);
    const aMissing = an == null && (av == null || av === "");
    const bMissing = bn == null && (bv == null || bv === "");
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (an != null && bn != null) return (an - bn) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
}
