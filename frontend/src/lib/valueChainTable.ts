/** The table half of SPLC.
 *
 *  Bloomberg's Supply Chain Analysis screen is two views of one dataset: a
 *  bowtie chart, and — the one people actually work in — a sortable table of
 *  quantified relationships, one row per counterparty, with the share of
 *  revenue or cost it accounts for, what that is worth, where the figure came
 *  from, and as of when.
 *
 *  We had only the chart. A graph is good for "who is connected to whom" and
 *  poor for "rank these twenty suppliers by exposure and tell me which
 *  numbers are estimates" — which is the actual research question.
 *
 *  Everything here is pure so the sorting, grouping, country inference and
 *  CSV export are testable without a browser.
 *
 *  Where this beats the original: Bloomberg shows a source label per row and
 *  leaves it at that. Every row here also carries whether the number was
 *  generated, estimated or human-verified, and the export carries it too — so
 *  a spreadsheet built from this screen can't silently launder an AI estimate
 *  into a fact.
 */

import type { MergedEntity, Role } from "@/lib/valueChainGraph";

export type ChainRow = {
  key: string;
  name: string;
  ticker: string | null;
  /** Every role, and the one that decides which tab it appears under. */
  roles: Role[];
  role: Role;
  /** ISO-ish country/exchange code inferred from the ticker suffix. */
  country: string | null;
  /** Share of the SUBJECT's revenue this counterparty accounts for. */
  pctRevenue: number | null;
  /** Share of the SUBJECT's input costs. */
  pctCOGS: number | null;
  /** Estimated annual value of the relationship, in USD. */
  valueUsd: number | null;
  /** Year-on-year change in that value, where the model offered one. */
  yoyPct: number | null;
  /** Where the number came from. */
  confidence: "verified" | "estimated";
  /** Date the figure is as of — verification date, else generation date. */
  asOf: string | null;
  note: string | null;
  /** Live price and day move, when the ticker resolves to a real listing. */
  price: number | null;
  changePct: number | null;
  currency: string | null;
};

/** Ticker suffix -> where the listing trades.
 *
 *  Inference, not a database: a suffix is what the provider gives us and it
 *  identifies the EXCHANGE, which is usually but not always the country of
 *  the business. A US-listed ADR of an Indian company reads as US here, and
 *  the column header says "listing" for that reason.
 */
export const EXCHANGE_COUNTRY: Record<string, string> = {
  NS: "IN", BO: "IN", TW: "TW", TWO: "TW", KS: "KR", KQ: "KR",
  T: "JP", HK: "HK", SS: "CN", SZ: "CN", L: "GB", DE: "DE", F: "DE",
  PA: "FR", AS: "NL", BR: "BE", MI: "IT", MC: "ES", ST: "SE", OL: "NO",
  CO: "DK", HE: "FI", SW: "CH", VX: "CH", VI: "AT", LS: "PT",
  AX: "AU", NZ: "NZ", TO: "CA", V: "CA", SA: "BR", MX: "MX",
  SI: "SG", KL: "MY", BK: "TH", JK: "ID", TA: "IL", IS: "TR",
};

export function countryOf(ticker: string | null | undefined): string | null {
  const t = (ticker || "").trim().toUpperCase();
  if (!t) return null;
  const dot = t.lastIndexOf(".");
  if (dot < 0) {
    // No suffix is the US convention (AAPL, AVGO). Only treat it as such
    // when it actually looks like a symbol, not like free text.
    return /^[A-Z][A-Z0-9.\-]{0,6}$/.test(t) ? "US" : null;
  }
  return EXCHANGE_COUNTRY[t.slice(dot + 1)] ?? null;
}

export type QuoteLike = {
  price?: number | null;
  change_pct?: number | null;
  currency?: string | null;
};

export function buildRows(
  entities: MergedEntity[],
  opts: { quotes?: Record<string, QuoteLike | null>; generatedAt?: string | null } = {},
): ChainRow[] {
  const { quotes = {}, generatedAt = null } = opts;
  return entities.map((e) => {
    const role = e.primaryRole;
    const m = e.metricsByRole[role] ?? {
      pctRevenue: null, pctCOGS: null, estUSDValue: null, yoyPct: null,
    };
    const ticker = (e.ticker || "").trim().toUpperCase() || null;
    const q = ticker ? quotes[ticker] : null;
    return {
      key: e.key,
      name: e.name,
      ticker,
      roles: e.roles,
      role,
      country: countryOf(ticker),
      pctRevenue: m.pctRevenue,
      pctCOGS: m.pctCOGS,
      valueUsd: m.estUSDValue,
      yoyPct: m.yoyPct,
      confidence: e.confidence === "verified" ? "verified" : "estimated",
      // A verified edge is as-of the day a human checked it. Everything else
      // is as-of the generation run, which is the only honest stamp we have.
      asOf: (e.confidence === "verified" ? e.verified_at : null) ?? generatedAt,
      note: e.notesByRole[role] ?? e.note ?? null,
      price: q?.price ?? null,
      changePct: q?.change_pct ?? null,
      currency: q?.currency ?? null,
    };
  });
}

export const SORT_KEYS = [
  "name", "ticker", "country", "pctRevenue", "pctCOGS", "valueUsd",
  "yoyPct", "confidence", "changePct",
] as const;
export type SortKey = typeof SORT_KEYS[number];

/**
 * Sort, with nulls always last regardless of direction.
 *
 * This matters more than it sounds: most relationships have no quantified
 * value, and letting nulls sort to the top in ascending order buries every
 * row that actually carries a number.
 */
export function sortRows(rows: ChainRow[], key: SortKey, dir: "asc" | "desc"): ChainRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key] as number | string | null;
    const bv = b[key] as number | string | null;
    const aNull = av == null || av === "";
    const bNull = bv == null || bv === "";
    if (aNull && bNull) return a.name.localeCompare(b.name);
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * sign || a.name.localeCompare(b.name);
    }
    return String(av).localeCompare(String(bv)) * sign
      || a.name.localeCompare(b.name);
  });
}

export const GROUP_KEYS = ["none", "role", "country", "confidence"] as const;
export type GroupKey = typeof GROUP_KEYS[number];

const GROUP_FALLBACK = "Not disclosed";

export function groupLabel(row: ChainRow, key: GroupKey): string {
  switch (key) {
    case "role": return row.role;
    case "country": return row.country ?? GROUP_FALLBACK;
    case "confidence": return row.confidence;
    default: return "";
  }
}

/** Grouped in descending group size, so the concentration is at the top. */
export function groupRows(rows: ChainRow[], key: GroupKey): [string, ChainRow[]][] {
  if (key === "none") return [["", rows]];
  const by = new Map<string, ChainRow[]>();
  for (const r of rows) {
    const g = groupLabel(r, key);
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(r);
  }
  return [...by.entries()].sort((a, b) =>
    b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** Totals for a set of rows — the answer to "how much of this is quantified". */
export function totals(rows: ChainRow[]): {
  n: number; quantified: number; verified: number;
  pctRevenue: number | null; pctCOGS: number | null; valueUsd: number | null;
} {
  const sum = (pick: (r: ChainRow) => number | null) => {
    const vals = rows.map(pick).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    n: rows.length,
    quantified: rows.filter((r) =>
      r.pctRevenue != null || r.pctCOGS != null || r.valueUsd != null).length,
    verified: rows.filter((r) => r.confidence === "verified").length,
    pctRevenue: sum((r) => r.pctRevenue),
    pctCOGS: sum((r) => r.pctCOGS),
    valueUsd: sum((r) => r.valueUsd),
  };
}

const CSV_COLUMNS: [string, (r: ChainRow) => string | number | null][] = [
  ["Name", (r) => r.name],
  ["Ticker", (r) => r.ticker],
  ["Listing", (r) => r.country],
  ["Role", (r) => r.role],
  ["All roles", (r) => r.roles.join(" / ")],
  ["% of revenue", (r) => r.pctRevenue],
  ["% of input costs", (r) => r.pctCOGS],
  ["Est. value (USD)", (r) => r.valueUsd],
  ["YoY %", (r) => r.yoyPct],
  ["Basis", (r) => r.confidence],
  ["As of", (r) => r.asOf],
  ["Note", (r) => r.note],
];

function csvCell(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV export.
 *
 * The header carries the provenance warning, not just the columns. A table
 * of AI estimates pasted into a model becomes a table of numbers with no
 * memory of where they came from; a comment line at the top is the cheapest
 * possible defence against that.
 */
export function toCSV(rows: ChainRow[], subject: string, generatedAt?: string | null): string {
  const header = [
    `# Value chain for ${subject}`,
    `# Generated ${generatedAt || "unknown"} by a language model. Rows marked`,
    "# 'estimated' are NOT sourced from filings; 'verified' rows were checked",
    "# by an administrator. Percentages and values are estimates in every case",
    "# unless marked verified. Do not present these as reported figures.",
  ].join("\n");
  const body = [
    CSV_COLUMNS.map(([h]) => csvCell(h)).join(","),
    ...rows.map((r) => CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(",")),
  ].join("\n");
  return `${header}\n${body}\n`;
}
