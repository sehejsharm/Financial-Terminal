/** Grouping and interpretation for macro indicators.
 *
 *  The API returns a flat list of series with display names. Presenting them
 *  as one undifferentiated grid makes the reader do the sorting; grouping them
 *  into the four blocks a macro desk actually thinks in — growth, inflation,
 *  policy, labour — turns the same data into a picture.
 *
 *  Pure and tested, because the classification is string matching over
 *  provider-supplied names and it should be obvious when a name stops matching
 *  rather than silently landing in "Other".
 */

export type MacroGroup = "growth" | "inflation" | "policy" | "labour" | "other";

export type MacroIndicator = {
  name: string;
  value: number | null;
  prior: number | null;
  change: number | null;
  date: string | null;
  unit: string;
  stale?: boolean;
};

export const GROUP_LABEL: Record<MacroGroup, string> = {
  growth: "Growth & activity",
  inflation: "Inflation",
  policy: "Policy & rates",
  labour: "Labour",
  other: "Other series",
};

export const GROUP_ORDER: MacroGroup[] = ["growth", "inflation", "policy", "labour", "other"];

/**
 * Which block a series belongs to.
 *
 * Order matters: "unemployment rate" contains "rate", so labour is tested
 * before policy or the reader would find joblessness filed under interest
 * rates.
 */
export function groupOf(name: string): MacroGroup {
  const n = (name || "").toLowerCase();
  if (/unemploy|payroll|jobless|employment|labou?r|wage|claims/.test(n)) return "labour";
  if (/\bcpi\b|inflat|price index|ppi|deflator|core pce|pce/.test(n)) return "inflation";
  if (/fed funds|policy rate|repo|bank rate|treasury|yield|bond|spread|\brate\b/.test(n)) return "policy";
  if (/gdp|industrial|production|retail|pmi|manufactur|output|sales|confidence|sentiment/.test(n)) return "growth";
  return "other";
}

export function groupIndicators(inds: MacroIndicator[]):
    [MacroGroup, MacroIndicator[]][] {
  const by = new Map<MacroGroup, MacroIndicator[]>();
  for (const i of inds) {
    const g = groupOf(i.name);
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(i);
  }
  return GROUP_ORDER
    .filter((g) => by.has(g))
    .map((g) => [g, by.get(g)!] as [MacroGroup, MacroIndicator[]]);
}

/**
 * Is a rise in this series good, bad, or neither?
 *
 * Deliberately conservative. Unemployment rising is bad and GDP rising is
 * good, but for most series — an interest rate, an exchange rate — "up" has
 * no universal sign, and colouring it green or red would assert a view the
 * data doesn't support. Those return "neutral" and render without a tone.
 */
export type Direction = "good" | "bad" | "neutral";

export function directionOf(name: string, change: number | null | undefined): Direction {
  if (change == null || !Number.isFinite(change) || change === 0) return "neutral";
  const n = (name || "").toLowerCase();
  const up = change > 0;
  if (/unemploy|jobless|claims/.test(n)) return up ? "bad" : "good";
  if (/\bcpi\b|inflat|price index|ppi|deflator|pce/.test(n)) return up ? "bad" : "good";
  if (/gdp|industrial|production|retail|payroll|employment|pmi|output|sales/.test(n)) {
    return up ? "good" : "bad";
  }
  // Rates, FX, spreads and anything unrecognised: no inherent direction.
  return "neutral";
}

export type Regime = {
  /** Counts of series moving in a helpful / unhelpful direction. */
  good: number;
  bad: number;
  neutral: number;
  /** Series whose latest observation is older than its release cadence. */
  stale: number;
  /** Total series considered. */
  n: number;
};

export function regimeSummary(inds: MacroIndicator[]): Regime {
  const r: Regime = { good: 0, bad: 0, neutral: 0, stale: 0, n: inds.length };
  for (const i of inds) {
    if (i.stale) r.stale += 1;
    const d = directionOf(i.name, i.change);
    if (d === "good") r.good += 1;
    else if (d === "bad") r.bad += 1;
    else r.neutral += 1;
  }
  return r;
}

/**
 * One honest sentence about the picture.
 *
 * Explicitly refuses to call a regime from a handful of directional series —
 * counting arrows is not a macro forecast, and saying so is more useful than
 * a confident label the data can't carry.
 */
export function regimeNote(r: Regime): string {
  if (r.n === 0) return "No indicators returned for this economy.";
  const directional = r.good + r.bad;
  if (directional === 0) {
    return `${r.n} series, none with a clear directional reading — most of `
      + "these (rates, FX, spreads) have no inherently good or bad direction.";
  }
  const lead = r.good > r.bad ? "improving" : r.bad > r.good ? "deteriorating" : "mixed";
  return `Of ${r.n} series, ${r.good} are moving in a helpful direction and `
    + `${r.bad} in an unhelpful one — on balance ${lead}. That is a count of `
    + "arrows on the latest prints, not a forecast: it weights a monthly PMI "
    + "the same as a quarterly GDP revision and ignores magnitude entirely."
    + (r.stale > 0 ? ` ${r.stale} of them are stale.` : "");
}
