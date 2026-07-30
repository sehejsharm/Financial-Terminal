/** What the street actually thinks, and how that has moved.
 *
 *  ANR printed four target cards and the provider's recommendation frame as
 *  a raw table of month codes and counts. The two things a reader wants from
 *  it were both absent: the shape of the distribution right now (how many
 *  buys against how many sells) and whether that shape is improving.
 *
 *  A downgrade cycle is visible in the trend and invisible in the latest row,
 *  and the latest row is all the old screen showed.
 *
 *  Ownership gets the same treatment in `holderConcentration`: a list of the
 *  top holders says less than what share of the register the top five hold,
 *  because that is what decides whether one seller can move the price.
 */

export type Frameish = {
  columns: string[];
  rows: Array<Record<string, number | string | null>>;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** The recommendation buckets providers emit, strongest first. */
export const REC_BUCKETS: ReadonlyArray<{
  key: string; label: string; aliases: readonly string[]; score: number;
}> = [
  { key: "strongBuy", label: "Strong buy", aliases: ["strongbuy"], score: 1 },
  { key: "buy", label: "Buy", aliases: ["buy", "outperform", "overweight"], score: 2 },
  { key: "hold", label: "Hold", aliases: ["hold", "neutral", "equalweight"], score: 3 },
  { key: "sell", label: "Sell", aliases: ["sell", "underperform", "underweight"], score: 4 },
  { key: "strongSell", label: "Strong sell", aliases: ["strongsell"], score: 5 },
];

export type RecPeriod = {
  /** The provider's label for the period ("0m", "-1m", a date). */
  period: string;
  counts: Record<string, number>;
  total: number;
  /** 1 (all strong buy) … 5 (all strong sell). Null with no ratings. */
  score: number | null;
  /** Share of ratings that are buy or better. */
  bullishPct: number | null;
};

function numOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read the recommendation frame into periods, oldest first.
 *
 * Providers label periods as "0m" (this month), "-1m", "-2m" and so on, so
 * "oldest first" means most-negative first — a plain string sort would put
 * "-1m" before "-2m" and reverse the trend.
 */
export function parseRecommendations(frame: Frameish | null): RecPeriod[] {
  if (!frame?.rows?.length) return [];
  const cols = frame.columns ?? [];
  const periodCol = cols.find((c) => /period|date|index/i.test(c)) ?? cols[0];

  const out: RecPeriod[] = frame.rows.map((r) => {
    const counts: Record<string, number> = {};
    let total = 0;
    let weighted = 0;
    for (const b of REC_BUCKETS) {
      let n = 0;
      for (const c of cols) {
        if (c === periodCol) continue;
        if (b.aliases.includes(norm(c))) n += numOf(r[c]) ?? 0;
      }
      counts[b.key] = n;
      total += n;
      weighted += n * b.score;
    }
    const bullish = counts.strongBuy + counts.buy;
    return {
      period: String(r[periodCol] ?? ""),
      counts,
      total,
      score: total ? weighted / total : null,
      bullishPct: total ? (bullish / total) * 100 : null,
    };
  }).filter((p) => p.total > 0);

  return out.sort((a, b) => monthOrder(a.period) - monthOrder(b.period));
}

/** "-2m" sorts before "-1m" before "0m"; real dates sort by time. */
function monthOrder(period: string): number {
  const m = /^(-?\d+)\s*m$/i.exec(period.trim());
  if (m) return Number(m[1]);
  const t = Date.parse(period);
  return Number.isFinite(t) ? t : 0;
}

export type ConsensusLabel =
  "Strong buy" | "Buy" | "Hold" | "Sell" | "Strong sell";

export function consensusLabel(score: number | null): ConsensusLabel | null {
  if (score == null) return null;
  if (score <= 1.5) return "Strong buy";
  if (score <= 2.5) return "Buy";
  if (score <= 3.5) return "Hold";
  if (score <= 4.5) return "Sell";
  return "Strong sell";
}

export type RecTrend = {
  latest: RecPeriod | null;
  oldest: RecPeriod | null;
  /** Change in the consensus score. NEGATIVE is an upgrade (1 is best). */
  scoreChange: number | null;
  direction: "upgrading" | "downgrading" | "unchanged" | null;
  /** Change in the number of analysts covering. */
  coverageChange: number | null;
};

export function recTrend(periods: RecPeriod[]): RecTrend {
  if (!periods.length) {
    return { latest: null, oldest: null, scoreChange: null,
             direction: null, coverageChange: null };
  }
  const latest = periods[periods.length - 1];
  const oldest = periods[0];
  const change = latest.score != null && oldest.score != null
    ? latest.score - oldest.score : null;
  return {
    latest,
    oldest,
    scoreChange: change,
    // The scale runs 1 (strong buy) to 5 (strong sell), so a FALLING score
    // is an upgrade. Reading the sign the natural way gets this backwards.
    direction: change == null ? null
      : change < -0.1 ? "upgrading"
      : change > 0.1 ? "downgrading" : "unchanged",
    coverageChange: latest.total - oldest.total,
  };
}

export function streetNote(t: RecTrend): string {
  if (!t.latest) return "No recommendation history is available for this listing.";
  const label = consensusLabel(t.latest.score);
  const parts = [
    `${t.latest.total} analyst${t.latest.total === 1 ? "" : "s"} covering, `
      + `consensus ${label ?? "unrated"}`
      + (t.latest.bullishPct != null
        ? ` (${t.latest.bullishPct.toFixed(0)}% buy or better).` : "."),
  ];
  if (t.direction === "upgrading") {
    parts.push("The balance has shifted towards buy across the periods shown.");
  } else if (t.direction === "downgrading") {
    parts.push("The balance has shifted away from buy across the periods shown.");
  }
  if (t.coverageChange != null && Math.abs(t.coverageChange) >= 2) {
    parts.push(t.coverageChange > 0
      ? `Coverage has grown by ${t.coverageChange} analysts.`
      : `Coverage has fallen by ${Math.abs(t.coverageChange)} analysts.`);
  }
  parts.push("Ratings are a poor timing signal and a decent sentiment "
    + "gauge: the street is structurally long, so 'hold' is closer to a "
    + "negative view than the word suggests.");
  return parts.join(" ");
}

// ── ownership ───────────────────────────────────────────────────────────

export type HolderConcentration = {
  n: number;
  /** Combined share of the register held by the largest five. */
  top5Pct: number | null;
  top1Pct: number | null;
  /** Herfindahl over the disclosed stakes, 0–10,000. */
  hhi: number | null;
  largest: { name: string; pct: number } | null;
  /** Column the percentages were read from, for the caveat line. */
  basis: string | null;
};

/**
 * How concentrated the disclosed register is.
 *
 * A list of the top holders tells you who owns it. What matters for a
 * position is whether ONE of them selling can move the price, and that is a
 * concentration question the list does not answer.
 *
 * Percentages are of the whole company where the provider gives "% Out", so
 * they will not sum to 100 — the rest is retail, promoters and everyone
 * below the disclosure threshold. The caller says so.
 */
export function holderConcentration(frame: Frameish | null): HolderConcentration {
  const empty: HolderConcentration = {
    n: 0, top5Pct: null, top1Pct: null, hhi: null, largest: null, basis: null,
  };
  if (!frame?.rows?.length) return empty;
  const cols = frame.columns ?? [];
  const pctCol = cols.find((c) => /%\s*out|pctheld|percent|% held/i.test(c));
  const nameCol = cols.find((c) => /holder|name/i.test(c)) ?? cols[0];
  if (!pctCol) return { ...empty, n: frame.rows.length };

  // Providers send either 0.0512 or 5.12 for the same stake, so the scale has
  // to be decided for the COLUMN, not per row: a row-by-row rule reads a
  // genuine 1.0% holding as 100%, which it did until a test caught it. If
  // every disclosed stake is at or below 1, the column is fractions.
  const raw = frame.rows.map((r) => numOf(r[pctCol]))
    .filter((v): v is number => v != null && v > 0);
  const asFractions = raw.length > 0 && Math.max(...raw) <= 1;

  const held = frame.rows
    .map((r) => {
      const v = numOf(r[pctCol]);
      if (v == null) return null;
      const pct = asFractions ? v * 100 : v;
      return { name: String(r[nameCol] ?? "").trim() || "Unnamed holder", pct };
    })
    .filter((x): x is { name: string; pct: number } => x != null && x.pct > 0)
    .sort((a, b) => b.pct - a.pct);

  if (!held.length) return { ...empty, n: frame.rows.length };
  return {
    n: held.length,
    top5Pct: held.slice(0, 5).reduce((a, x) => a + x.pct, 0),
    top1Pct: held[0].pct,
    hhi: Math.round(held.reduce((a, x) => a + x.pct * x.pct, 0)),
    largest: held[0],
    basis: pctCol,
  };
}

export function ownershipNote(c: HolderConcentration): string {
  if (!c.n) return "No institutional holdings are disclosed for this listing.";
  if (c.top5Pct == null) {
    return `${c.n} holders disclosed, but the feed gives no percentage column, `
      + "so concentration can't be measured.";
  }
  const parts = [
    `The five largest disclosed holders own ${c.top5Pct.toFixed(1)}% of the `
      + `company between them; the largest single one, ${c.largest!.name}, `
      + `owns ${c.largest!.pct.toFixed(1)}%.`,
  ];
  if (c.top1Pct != null && c.top1Pct > 10) {
    parts.push("A stake that size cannot be sold quickly without moving the "
      + "price, which cuts both ways: it is a stabiliser until it is an "
      + "overhang.");
  }
  parts.push("These are DISCLOSED institutional stakes only. They do not sum "
    + "to 100% — promoters, retail and everyone below the disclosure "
    + "threshold are absent — and filings lag, so the register shown is "
    + "weeks to months old.");
  return parts.join(" ");
}
