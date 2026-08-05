/** What cadence a statement is ACTUALLY on, as opposed to what was asked for.
 *
 *  The Financials panel has an Annual/Quarterly toggle and assumed the answer
 *  matched the question. It does not always. Indian listings have no annual
 *  source at all — the numbers come from the XBRL a company files with each
 *  quarterly result — so the backend returns quarters under an annual request
 *  and says so in the payload. The panel ignored that and rendered quarter-end
 *  dates under an "Annual" heading.
 *
 *  Two things went wrong from there, and the second is worse than the
 *  mislabelling. Growth was annualised at one period per year, so a compound
 *  rate computed across four quarters was reported as four years of growth —
 *  roughly a fourfold overstatement, printed in the same type as a real one.
 *
 *  The columns are the ground truth here. A statement whose period ends sit
 *  ninety days apart is quarterly whatever the request said and whatever any
 *  flag claims, so cadence is inferred from them and the server's flag is only
 *  a fallback for the case where there are too few columns to measure.
 */

export type Cadence = "annual" | "quarterly";

/** Days between period ends, below which the columns are quarters.
 *
 *  Set between a quarter (~91 days) and a half-year (~183), not above both.
 *  A half-year filer has to land on the ANNUAL side: annualising six-month
 *  periods at four per year doubles every growth rate on the screen. */
const QUARTERLY_MAX_GAP_DAYS = 140;

export const PERIODS_PER_YEAR: Record<Cadence, number> = {
  annual: 1,
  quarterly: 4,
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Cadence read off the column dates themselves.
 *
 * Null when there are fewer than two parseable dates — one column has no
 * spacing to measure, and guessing from a single date would be inventing the
 * answer rather than reading it.
 */
export function inferCadence(columns: string[]): Cadence | null {
  const days = columns
    .map((c) => Date.parse(String(c).slice(0, 10)))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (days.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    gaps.push((days[i] - days[i - 1]) / 86_400_000);
  }
  const gap = median(gaps);
  if (gap == null || gap <= 0) return null;
  return gap < QUARTERLY_MAX_GAP_DAYS ? "quarterly" : "annual";
}

export type CadenceRead = {
  requested: Cadence;
  /** What the columns actually are. Falls back to `requested` only when
   *  nothing could be measured or claimed. */
  actual: Cadence;
  mismatch: boolean;
  /** Divisor for annualising growth. Using the requested cadence here is what
   *  turned four quarters of growth into four years of it. */
  periodsPerYear: number;
  note: string | null;
};

type Statementish = {
  columns?: string[] | null;
  quarterly?: boolean | null;
  rows?: unknown[] | null;
  note?: string | null;
} | null;

/**
 * Reconcile what was asked for with what arrived.
 *
 * Prefers the columns, then the server's own flag. A panel that renders the
 * result of this can never again label a quarter-end column as a fiscal year.
 */
export function readCadence(statements: Statementish[],
                            requested: Cadence): CadenceRead {
  const withRows = statements.filter(
    (s): s is NonNullable<Statementish> => !!s && !!(s.rows?.length));

  let actual: Cadence | null = null;
  for (const s of withRows) {
    actual = inferCadence(s.columns ?? []);
    if (actual) break;
  }
  if (!actual) {
    const flagged = withRows.find((s) => typeof s.quarterly === "boolean");
    if (flagged) actual = flagged.quarterly ? "quarterly" : "annual";
  }
  const resolved = actual ?? requested;
  const mismatch = withRows.length > 0 && resolved !== requested;

  return {
    requested,
    actual: resolved,
    mismatch,
    periodsPerYear: PERIODS_PER_YEAR[resolved],
    note: mismatch ? mismatchNote(requested, resolved) : null,
  };
}

function mismatchNote(requested: Cadence, actual: Cadence): string {
  if (requested === "annual" && actual === "quarterly") {
    return "These columns are QUARTERS, not financial years. The only free "
      + "source of statements for this listing is the XBRL a company files "
      + "with each quarterly result, and there is no annual filing behind it "
      + "— so the annual view would have to build years by summing quarters, "
      + "which silently reports a part-year as a full one whenever a quarter "
      + "is missing. Growth figures below are annualised at four periods a "
      + "year to match what is actually on screen.";
  }
  return "These columns are FINANCIAL YEARS, not quarters — the provider "
    + "returned annual statements for this ticker. Growth figures below are "
    + "annualised to match.";
}

/** The label the toggle should carry: what is on screen, not what was asked.
 *  A button reading "Annual" above quarter-end columns is the whole bug. */
export function cadenceLabel(c: CadenceRead): string {
  return c.actual === "quarterly" ? "Quarterly" : "Annual";
}
