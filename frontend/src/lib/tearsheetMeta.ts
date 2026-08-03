/** What a printed tear sheet has to say about itself.
 *
 *  A tear sheet outlives the session that made it. Someone prints it, puts it
 *  in a folder, and reads it three weeks later — which makes two things on the
 *  old sheet actively misleading rather than merely thin.
 *
 *  It stamped "as of <now>", taken from the browser clock at render. That is
 *  when the PAGE was drawn, not when the data was true, and on a piece of
 *  paper the distinction is invisible. A reader has no way to know whether the
 *  price is from that moment or from a provider's overnight file.
 *
 *  And a blank cell on screen invites a second look; a blank cell on paper is
 *  just a gap. So the sheet needs to say how much of it actually populated,
 *  and which fields the provider didn't cover.
 */

export type Snap = Record<string, unknown>;

/** The metrics the sheet's header grid promises to show. */
export const HEADER_FIELDS = [
  { key: "market_cap", label: "Market cap" },
  { key: "trailing_pe", label: "P/E" },
  { key: "beta", label: "Beta" },
  { key: "dividend_yield", label: "Dividend yield" },
  { key: "roe", label: "ROE" },
  { key: "profit_margin", label: "Profit margin" },
  { key: "debt_to_equity", label: "Debt / equity" },
  { key: "fifty_two_high", label: "52-week range" },
] as const;

export type Coverage = {
  filled: number;
  total: number;
  missing: string[];
};

export function headerCoverage(snap: Snap | null): Coverage {
  const missing: string[] = [];
  let filled = 0;
  for (const f of HEADER_FIELDS) {
    const v = snap?.[f.key];
    // NaN and empty string are the provider saying nothing, same as null.
    const ok = v != null && v !== ""
      && !(typeof v === "number" && !Number.isFinite(v));
    if (ok) filled++;
    else missing.push(f.label);
  }
  return { filled, total: HEADER_FIELDS.length, missing };
}

/**
 * The line that distinguishes when this was PRINTED from when the data was
 * true.
 *
 * `printedAt` is passed in rather than read from the clock so this stays pure
 * and the sheet's stamp is testable — a date read inside a render is exactly
 * the kind of thing that silently drifts.
 */
export function printedLine(printedAt: Date): string {
  return `Printed ${printedAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
}

/**
 * What the numbers on the sheet are, and are not.
 *
 * Deliberately blunt about the timestamp problem: the header price is the last
 * one the provider had, which on a closed market is the previous close and on
 * a free feed can be minutes old. A printed sheet cannot refresh, so this is
 * the only place a reader learns that.
 */
export function provenanceNote(c: Coverage, printedAt: Date): string {
  const parts = [
    printedLine(printedAt),
    "The price and metrics are whatever the free providers last reported when "
      + "this page was rendered — NOT a quote at the printed time. On a closed "
      + "market that is the previous close, and a printed sheet never "
      + "refreshes.",
  ];
  if (c.missing.length) {
    parts.push(`${c.filled} of ${c.total} header metrics populated. Missing: `
      + `${c.missing.join(", ")}. A blank on paper is a coverage gap in the `
      + "free feed, not a zero and not a company that lacks the figure.");
  }
  parts.push("Fundamentals can lag by a reporting period, comparables are peers "
    + "by sector and exchange rather than a curated set, and none of this is "
    + "investment advice. Verify anything you act on.");
  return parts.join(" ");
}

/** Column labels for the comparables table on the sheet. */
const COMP_LABELS: Record<string, string> = {
  ticker: "Ticker",
  symbol: "Ticker",
  name: "Name",
  sector: "Sector",
  price: "Price",
  market_cap: "Market cap",
  trailing_pe: "P/E",
  forward_pe: "Fwd P/E",
  pe: "P/E",
  pb: "P/B",
  price_to_book: "P/B",
  ev_to_ebitda: "EV/EBITDA",
  roe: "ROE",
  profit_margin: "Margin",
  dividend_yield: "Yield",
  debt_to_equity: "D/E",
  revenue_growth: "Rev growth",
  beta: "Beta",
};

export function compLabel(key: string): string {
  return COMP_LABELS[key]
    ?? key.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
}

/** Comp columns whose values are fractions from the provider (0.22 = 22%). */
const FRACTION_KEYS = new Set([
  "roe", "profit_margin", "dividend_yield", "revenue_growth", "operating_margin",
]);

/** Comp columns holding raw magnitudes that must never be printed in full. */
const MAGNITUDE_KEYS = new Set([
  "market_cap", "enterprise_value", "revenue", "ebitda",
]);

/**
 * A comparables cell, formatted for print.
 *
 * The old sheet ran String() over the raw value, so a market cap printed as
 * 17768137097216 — seventeen characters of digits in a table cell on a page
 * someone is meant to read. This is the same humanisation the rest of the app
 * uses, applied where it matters most.
 */
export function compCell(key: string, v: unknown, cur = ""): string {
  if (v == null || v === "") return "—";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "—";
  if (MAGNITUDE_KEYS.has(key)) {
    const a = Math.abs(v);
    for (const [div, suf] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
      // The 0.999995 threshold matches humanNumber: a value that ROUNDS up to
      // the next unit should step to it rather than print as "1000.00M".
      if (a >= div * 0.999995) return `${cur}${(v / div).toFixed(2)}${suf}`;
    }
    return `${cur}${v.toFixed(0)}`;
  }
  if (FRACTION_KEYS.has(key)) return `${(v * 100).toFixed(1)}%`;
  if (key === "debt_to_equity") return `${(v / 100).toFixed(2)}x`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Is this comps row the company the sheet is about? */
export function isSubject(row: Record<string, unknown>, ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  if (!t) return false;
  for (const k of ["ticker", "symbol"]) {
    const v = row[k];
    if (typeof v !== "string") continue;
    const rowT = v.trim().toUpperCase();
    // A comps feed may return the bare symbol where the sheet has the
    // exchange-qualified one, so compare on the stem too.
    if (rowT === t || rowT === t.split(".")[0] || rowT.split(".")[0] === t.split(".")[0]) {
      return true;
    }
  }
  return false;
}
