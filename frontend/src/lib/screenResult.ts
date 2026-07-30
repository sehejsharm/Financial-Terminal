/** Reading a screen result honestly.
 *
 *  The screener showed how much of the universe it had scanned only when the
 *  result was EMPTY. That is exactly backwards. "12 matches" out of 500 names
 *  where all 500 had usable data is a finding; "12 matches" out of 500 where
 *  only 60 could be evaluated is a statement about the data provider wearing
 *  the costume of a finding, and the two rendered identically.
 *
 *  Same problem one level down: a screen whose ROCE column is 90% dashes has
 *  not found ninety unprofitable companies, it has found a column the free
 *  feed doesn't populate. There was a hardcoded warning for ROCE specifically;
 *  every other sparse column was silent.
 *
 *  And the columns came through as raw database keys — "eps_growth", "mos",
 *  "roce" — which the reader has to decode before they can read the number.
 *
 *  Pure, because "how many of these cells are actually populated" is the kind
 *  of arithmetic that quietly rounds the wrong way and changes what a screen
 *  appears to say.
 */

export type Row = Record<string, unknown>;

export type Result = {
  rows: Row[];
  scanned?: number;
  evaluable?: number | null;
  note?: string | null;
  as_of?: string | null;
};

/** Human labels for the keys the screens emit. */
const LABELS: Record<string, string> = {
  ticker: "Ticker",
  symbol: "Symbol",
  name: "Name",
  sector: "Sector",
  industry: "Industry",
  price: "Price",
  market_cap: "Market cap",
  mcap: "Market cap",
  pe: "P/E",
  trailing_pe: "P/E (trailing)",
  forward_pe: "P/E (forward)",
  pb: "Price / book",
  peg: "PEG",
  roe: "Return on equity",
  roce: "Return on capital employed",
  roa: "Return on assets",
  eps_growth: "EPS growth",
  sales_growth: "Sales growth",
  revenue_growth: "Revenue growth",
  profit_margin: "Profit margin",
  operating_margin: "Operating margin",
  debt_to_equity: "Debt / equity",
  de: "Debt / equity",
  dividend_yield: "Dividend yield",
  promoter: "Promoter holding",
  ytd_return: "Return YTD",
  return_1y: "Return 1Y",
  margin_of_safety: "Margin of safety",
  mos: "Margin of safety",
  intrinsic_value: "Intrinsic value",
  score: "Score",
  quality_score: "Quality score",
  beta: "Beta",
  volume: "Volume",
  avg_volume: "Average volume",
};

export function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key];
  // Unmapped keys still get shown — hiding a column is worse than an
  // imperfect label, and the underlying key stays available as a tooltip.
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Columns whose numbers are percentages, so the unit isn't guessed per row. */
const PERCENT_KEYS = new Set([
  "roe", "roce", "roa", "eps_growth", "sales_growth", "revenue_growth",
  "profit_margin", "operating_margin", "promoter", "ytd_return", "return_1y",
  "margin_of_safety", "mos", "dividend_yield",
]);

export function isPercent(key: string): boolean {
  return PERCENT_KEYS.has(key);
}

// ── how much of the universe this actually looked at ──────────────────────

export type Coverage = {
  matched: number;
  scanned: number | null;
  evaluable: number | null;
  /** Matches as a share of what could be evaluated, 0–100. */
  hitRatePct: number | null;
  /** Names with usable data as a share of the universe scanned, 0–100. */
  evaluableRatePct: number | null;
};

export function coverage(r: Result): Coverage {
  const matched = r.rows?.length ?? 0;
  const scanned = typeof r.scanned === "number" ? r.scanned : null;
  const evaluable = typeof r.evaluable === "number" ? r.evaluable : null;
  return {
    matched,
    scanned,
    evaluable,
    // Against what could be EVALUATED, not against the universe: a hit rate
    // measured over names the screen couldn't read is not a hit rate.
    hitRatePct: evaluable && evaluable > 0 ? (matched / evaluable) * 100 : null,
    evaluableRatePct: scanned && scanned > 0 && evaluable != null
      ? (evaluable / scanned) * 100 : null,
  };
}

/**
 * What the screen looked at, stated whether or not it found anything.
 *
 * This used to appear only on empty results, which is the one case where it
 * matters least — an empty screen already looks like an empty screen. It
 * matters most on a screen that DID return rows, because that is when a
 * coverage problem is invisible.
 */
export function coverageNote(c: Coverage): string {
  if (c.scanned == null) {
    return "The backend didn't report how much of the universe it scanned, so "
      + "there is no way to tell whether these are the only matches.";
  }
  const parts: string[] = [];
  if (c.evaluable != null && c.evaluableRatePct != null && c.evaluableRatePct < 90) {
    parts.push(`${c.matched} match${c.matched === 1 ? "" : "es"} from `
      + `${c.evaluable} names with usable data — but the universe is `
      + `${c.scanned}, so ${c.scanned - c.evaluable} were skipped because the `
      + "free feed doesn't carry the fields this screen filters on. Those are "
      + "not names that failed the test; they are names the test could not be "
      + "applied to, and a real match may well be among them.");
  } else {
    parts.push(`${c.matched} match${c.matched === 1 ? "" : "es"} from `
      + `${c.scanned} names scanned.`);
  }
  if (c.hitRatePct != null && c.matched > 0) {
    parts.push(`That is ${c.hitRatePct.toFixed(1)}% of what could be evaluated.`);
  }
  parts.push("Fundamentals come from the same free providers as the rest of the "
    + "app and can be stale by a reporting period. A screen is a starting list, "
    + "not a conclusion.");
  return parts.join(" ");
}

// ── which columns are actually populated ──────────────────────────────────

export type ColumnCoverage = {
  key: string;
  label: string;
  filled: number;
  total: number;
  pct: number;
};

/** How many rows carry a real value in each column. */
export function columnCoverage(rows: Row[], cols: string[]): ColumnCoverage[] {
  const total = rows.length;
  return cols.map((key) => {
    let filled = 0;
    for (const r of rows) {
      const v = r[key];
      // An empty string is a provider's way of saying null; NaN is one too.
      if (v == null || v === "") continue;
      if (typeof v === "number" && !Number.isFinite(v)) continue;
      filled++;
    }
    return {
      key, label: labelFor(key), filled, total,
      pct: total > 0 ? (filled / total) * 100 : 0,
    };
  });
}

/** Below this share of populated cells, a column is reporting the provider's
 *  coverage rather than the companies. */
export const SPARSE_PCT = 50;

export function sparseColumns(cov: ColumnCoverage[],
                              threshold = SPARSE_PCT): ColumnCoverage[] {
  return cov.filter((c) => c.total > 0 && c.pct < threshold)
    .sort((a, b) => a.pct - b.pct);
}

/**
 * The plain-language warning for a column full of dashes.
 *
 * Replaces a hardcoded ROCE check that left every other sparse column silent.
 * The distinction the reader needs is between "these companies don't have
 * this" and "the feed doesn't carry this", and a dash alone cannot make it.
 */
export function columnNote(sparse: ColumnCoverage[]): string | null {
  if (!sparse.length) return null;
  const empty = sparse.filter((c) => c.filled === 0);
  const partial = sparse.filter((c) => c.filled > 0);
  const parts: string[] = [];

  if (empty.length) {
    parts.push(`${empty.map((c) => c.label).join(", ")} `
      + `${empty.length === 1 ? "is" : "are"} empty for every row here. That is `
      + "the free feed not carrying the field, not the companies lacking it — "
      + "FMP's key metrics cover mostly US listings, and NSE names have no free "
      + "source for several ratios.");
  }
  if (partial.length) {
    parts.push(`${partial.map((c) => `${c.label} (${c.pct.toFixed(0)}%)`).join(", ")} `
      + `${partial.length === 1 ? "is" : "are"} populated for under half the `
      + "rows, so sorting or comparing on those columns ranks the names the "
      + "provider happens to cover rather than the best ones.");
  }
  return parts.join(" ");
}
