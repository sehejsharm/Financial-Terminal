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

export type MacroGroup =
  "growth" | "inflation" | "policy" | "labour" | "external" | "other";

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
  policy: "Policy, rates & money",
  labour: "Labour",
  external: "External balance & currency",
  other: "Other series",
};

/** What each block tells you, shown next to the heading. */
export const GROUP_BLURB: Record<MacroGroup, string> = {
  growth: "How much the economy is producing and how confident it feels.",
  inflation: "What prices are doing, which sets the ceiling on policy easing.",
  policy: "The price of money and how much of it there is.",
  labour: "Whether the economy is creating work — the slowest-moving pillar.",
  external: "Trade, the current account, reserves and the exchange rate.",
  other: "Series that don't fit the four standard blocks.",
};

export const GROUP_ORDER: MacroGroup[] = [
  "growth", "inflation", "policy", "labour", "external", "other",
];

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
  if (/\bcpi\b|inflat|price index|ppi|deflator|core pce|pce|hicp/.test(n)) return "inflation";
  // External before policy: "Real effective exchange RATE" contains "rate",
  // and an exchange rate is not a policy rate.
  if (/current account|export|import|trade balance|reserves|exchange rate|reer|\/\s*(inr|usd|jpy|cny|eur|gbp)|\b(usd|eur|gbp|jpy|cny)\s*\//.test(n)) {
    return "external";
  }
  if (/fed funds|policy rate|repo|bank rate|treasury|yield|bond|spread|money supply|broad money|\bm[23]\b|\bdebt\b|\brate\b/.test(n)) return "policy";
  if (/gdp|industrial|production|retail|pmi|manufactur|output|sales|confidence|sentiment|housing|leading indicator/.test(n)) return "growth";
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
  // Before the growth rule: "Federal debt (% GDP)" contains "gdp", and
  // rising public debt is not an improvement the way rising output is.
  if (/\bdebt\b|deficit/.test(n)) return "neutral";
  if (/gdp|industrial|production|retail|payroll|employment|pmi|output|sales|confidence|sentiment|housing|leading indicator/.test(n)) {
    return up ? "good" : "bad";
  }
  // External strength: more reserves, a bigger current-account balance and
  // rising exports all describe a stronger external position. Imports are
  // deliberately left unsigned — rising imports can be domestic demand
  // (healthy) or a widening deficit (not), and the series alone can't say.
  if (/reserves|current account|export/.test(n)) return up ? "good" : "bad";
  // Rates, FX, spreads, debt levels and anything unrecognised: no inherent
  // direction. A weaker rupee helps exporters and hurts importers; calling
  // it "bad" would be a view, not a reading.
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

/** Per-pillar read: the same counting, done block by block. */
export type Pillar = Regime & {
  group: MacroGroup;
  /** Series that reported nothing at all — the feed had no observation. */
  missing: number;
  /** "improving" | "deteriorating" | "mixed" | null when nothing is signed. */
  lean: "improving" | "deteriorating" | "mixed" | null;
};

export function pillarReports(inds: MacroIndicator[]): Pillar[] {
  return groupIndicators(inds).map(([group, list]) => {
    const r = regimeSummary(list);
    const missing = list.filter((i) => i.value == null).length;
    const lean = r.good + r.bad === 0
      ? null
      : r.good > r.bad ? "improving"
      : r.bad > r.good ? "deteriorating" : "mixed";
    return { group, ...r, missing, lean };
  });
}

/**
 * How much of the requested picture actually arrived.
 *
 * Worth showing plainly: several of the series in this app come from OECD
 * collections FRED has been retiring, so "12 of 17 series reported" is a
 * fact the reader needs before they weigh anything below it.
 */
export function coverage(inds: MacroIndicator[]): {
  reported: number; total: number; pct: number;
} {
  const total = inds.length;
  const reported = inds.filter((i) => i.value != null).length;
  return { reported, total, pct: total ? (reported / total) * 100 : 0 };
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
