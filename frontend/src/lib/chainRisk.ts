/** Turning a relationship map into something you could size a position on.
 *
 *  A picture of who supplies whom is a research artefact. Before anyone
 *  commits real money against it, four questions have to be answerable from
 *  the same screen:
 *
 *    1. How concentrated is this chain — does one counterparty carry it?
 *    2. If a given node stops delivering, how much of the subject's cost base
 *       or revenue is exposed, in money?
 *    3. Where is that exposure physically, and does one jurisdiction hold
 *       enough of it to matter?
 *    4. Can the resulting trade actually be executed at the size intended?
 *
 *  All of it is arithmetic over the map plus figures we already have. None of
 *  it is a forecast, and every function returns null rather than a number it
 *  cannot support — a concentration score computed from two quantified edges
 *  out of twenty is worse than no score, because it looks like an answer.
 */

import type { ChainRow } from "@/lib/valueChainTable";

/** Below this share of edges quantified, a chain-level statistic is a lie. */
export const MIN_QUANTIFIED_SHARE = 0.4;

export type Concentration = {
  /** Herfindahl index over the exposure shares, 0–10,000. */
  hhi: number | null;
  /** 1/Σs² — how many counterparties this chain effectively has. */
  effectiveCount: number | null;
  /** Largest single share, and the top three combined. */
  top1: number | null;
  top3: number | null;
  /** Counterparties above the single-point-of-failure threshold. */
  singlePoints: { name: string; pct: number; ticker: string | null }[];
  /** Edges carrying a number, out of all edges considered. */
  quantified: number;
  total: number;
  /** Why a null was returned, when one was. */
  reason: string | null;
};

/** A supplier above this share of input cost cannot be replaced quickly. */
export const SINGLE_POINT_PCT = 15;

function shareOf(r: ChainRow): number | null {
  // A supplier's exposure is its share of input cost; a customer's is its
  // share of revenue. They are different denominators and must never be
  // added together — this picks the one that applies to the row's role.
  const v = r.role === "customer" ? r.pctRevenue : r.pctCOGS;
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * How concentrated the exposure is.
 *
 * HHI is computed over the shares as a fraction of the QUANTIFIED total, not
 * of 100. The map covers the largest relationships it knows about, not the
 * whole book, so treating the unmapped remainder as a single silent
 * competitor would understate concentration badly.
 */
export function concentration(rows: ChainRow[]): Concentration {
  const shares = rows.map((r) => ({ r, s: shareOf(r) }))
    .filter((x): x is { r: ChainRow; s: number } => x.s != null);
  const empty: Concentration = {
    hhi: null, effectiveCount: null, top1: null, top3: null,
    singlePoints: [], quantified: shares.length, total: rows.length, reason: null,
  };
  if (!rows.length) return { ...empty, reason: "No relationships in this map." };
  if (shares.length < 2) {
    return { ...empty, reason: "Fewer than two relationships carry a figure — "
      + "not enough to describe concentration." };
  }
  const covered = shares.length / rows.length;
  if (covered < MIN_QUANTIFIED_SHARE) {
    return { ...empty, reason: `Only ${shares.length} of ${rows.length} `
      + "relationships carry a figure — too thin to score concentration." };
  }

  const total = shares.reduce((a, x) => a + x.s, 0);
  const fractions = shares.map((x) => ({ ...x, f: x.s / total }))
    .sort((a, b) => b.f - a.f);
  const hhi = fractions.reduce((a, x) => a + (x.f * 100) ** 2, 0);

  return {
    hhi: Math.round(hhi),
    effectiveCount: Number((1 / fractions.reduce((a, x) => a + x.f * x.f, 0)).toFixed(2)),
    top1: Number((fractions[0].f * 100).toFixed(1)),
    top3: Number((fractions.slice(0, 3).reduce((a, x) => a + x.f, 0) * 100).toFixed(1)),
    singlePoints: fractions
      .filter((x) => x.s >= SINGLE_POINT_PCT)
      .map((x) => ({ name: x.r.name, pct: x.s, ticker: x.r.ticker })),
    quantified: shares.length,
    total: rows.length,
    reason: null,
  };
}

/** HHI bands, using the competition-authority convention. */
export function hhiBand(hhi: number | null): string {
  if (hhi == null) return "unknown";
  if (hhi >= 2500) return "highly concentrated";
  if (hhi >= 1500) return "moderately concentrated";
  return "diffuse";
}

export type ExposureRow = {
  name: string;
  ticker: string | null;
  role: ChainRow["role"];
  pct: number;
  /** Money exposed if this relationship stops, in the subject's currency. */
  atRisk: number | null;
  country: string | null;
  confidence: ChainRow["confidence"];
};

/**
 * What each relationship is worth to the subject in money.
 *
 * A supplier's share of input cost applied to cost of revenue; a customer's
 * share of revenue applied to revenue. Falls back to the model's own
 * estimated value where the subject's financials aren't available — and says
 * which was used, because one is derived from a filing and the other is not.
 */
export function exposures(
  rows: ChainRow[],
  financials: { revenue?: number | null; cogs?: number | null } = {},
): { rows: ExposureRow[]; basis: "financials" | "model" | "none" } {
  const { revenue, cogs } = financials;
  const haveFinancials = (revenue != null && revenue > 0)
    || (cogs != null && cogs > 0);

  const out: ExposureRow[] = rows.map((r) => {
    const pct = shareOf(r);
    let atRisk: number | null = null;
    if (pct != null) {
      const base = r.role === "customer" ? revenue : cogs;
      if (base != null && base > 0) atRisk = (pct / 100) * base;
      else if (r.valueUsd != null) atRisk = r.valueUsd;
    } else if (r.valueUsd != null) {
      atRisk = r.valueUsd;
    }
    return {
      name: r.name, ticker: r.ticker, role: r.role,
      pct: pct ?? 0, atRisk, country: r.country, confidence: r.confidence,
    };
  }).filter((x) => x.atRisk != null || x.pct > 0);

  out.sort((a, b) => (b.atRisk ?? 0) - (a.atRisk ?? 0) || b.pct - a.pct);
  return {
    rows: out,
    basis: haveFinancials ? "financials" : (out.some((x) => x.atRisk != null) ? "model" : "none"),
  };
}

export type CountryExposure = {
  country: string;
  pct: number;
  names: string[];
  atRisk: number | null;
};

/**
 * Exposure by where the counterparty is listed.
 *
 * The header on this is deliberately "listing", not "country": a suffix
 * identifies an exchange, and an ADR of an Indian company reads as US. It is
 * still the best available proxy for jurisdictional concentration, and
 * saying which it is costs one word.
 */
export function byCountry(rows: ExposureRow[]): CountryExposure[] {
  const by = new Map<string, CountryExposure>();
  for (const r of rows) {
    const key = r.country ?? "Unlisted / unknown";
    const cur = by.get(key) ?? { country: key, pct: 0, names: [], atRisk: null };
    cur.pct += r.pct;
    cur.names.push(r.name);
    if (r.atRisk != null) cur.atRisk = (cur.atRisk ?? 0) + r.atRisk;
    by.set(key, cur);
  }
  return [...by.values()]
    .map((c) => ({ ...c, pct: Number(c.pct.toFixed(1)) }))
    .sort((a, b) => b.pct - a.pct || a.country.localeCompare(b.country));
}

export type Liquidity = {
  days: number | null;
  verdict: string;
  adv_value?: number | null;
  basis_value?: number | null;
};

export type TradePlanRow = ExposureRow & {
  /** Position implied by weighting the notional by exposure. */
  notional: number;
  days: number | null;
  verdict: string;
};

/**
 * Turn the exposure ranking into a sized, executable plan.
 *
 * Weights the notional by each name's exposure share, then asks the
 * liquidity profile how long that leg takes. This is the step that decides
 * whether an analysis is actionable at a given size: an idea that requires
 * three weeks of buying in a name that reprices on the news is not the same
 * idea at $50m and at $1bn.
 */
export function tradePlan(
  rows: ExposureRow[],
  liquidity: Record<string, Liquidity | undefined>,
  notionalTotal: number,
): { rows: TradePlanRow[]; deployable: number; blocked: number; worstDays: number | null } {
  const tradable = rows.filter((r) => r.ticker);
  const weightTotal = tradable.reduce((a, r) => a + (r.pct || 0), 0);
  const out: TradePlanRow[] = tradable.map((r) => {
    // Equal weight when nothing is quantified — an arbitrary split is still
    // better than pretending a zero-weight name needs no capacity check.
    const w = weightTotal > 0 ? (r.pct || 0) / weightTotal : 1 / tradable.length;
    const notional = notionalTotal * w;
    const l = liquidity[r.ticker!.toUpperCase()];
    // The stored profile was computed for its own notional; days scale
    // linearly with size, so rescale rather than re-fetching.
    const days = l?.days != null && l.basis_value
      ? notional / (l.basis_value * 0.15)
      : null;
    return {
      ...r, notional,
      days: days == null ? null : Number(days.toFixed(2)),
      verdict: days == null ? "unknown"
        : days <= 1 ? "same day" : days <= 5 ? "days"
        : days <= 20 ? "weeks" : days <= 60 ? "months" : "untradable at size",
    };
  }).sort((a, b) => b.notional - a.notional);

  const ok = out.filter((r) => r.days != null && r.days <= 20);
  return {
    rows: out,
    deployable: ok.reduce((a, r) => a + r.notional, 0),
    blocked: out.filter((r) => r.days == null || r.days > 20)
      .reduce((a, r) => a + r.notional, 0),
    worstDays: out.reduce<number | null>(
      (a, r) => (r.days == null ? a : a == null ? r.days : Math.max(a, r.days)), null),
  };
}

/**
 * The one-paragraph read, stating its own coverage.
 *
 * Written so that someone who reads only this sentence is not misled about
 * how much of the chain the numbers actually cover.
 */
export function riskNote(c: Concentration, countries: CountryExposure[]): string {
  if (c.reason) return c.reason;
  const top = countries[0];
  const parts = [
    `${c.quantified} of ${c.total} relationships carry a figure.`,
    `The largest is ${c.top1}% of the quantified exposure and the top three are ${c.top3}%,`,
    `which is ${hhiBand(c.hhi)} (HHI ${c.hhi}, effectively ${c.effectiveCount} counterparties).`,
  ];
  if (c.singlePoints.length) {
    parts.push(`${c.singlePoints.length} ${c.singlePoints.length === 1 ? "name is" : "names are"} `
      + `above ${SINGLE_POINT_PCT}% on their own — those cannot be replaced quickly.`);
  }
  if (top && top.pct > 30) {
    parts.push(`${top.pct}% of the exposure sits in one listing jurisdiction (${top.country}).`);
  }
  parts.push("Shares are the model's estimates unless marked verified, and the "
    + "map covers the largest relationships it knows about, not the whole book — "
    + "so real concentration is at least this high, not lower.");
  return parts.join(" ");
}
