/** FX cross-rate matrix, derived from the USD pairs the feed actually quotes.
 *
 *  The providers publish majors against the dollar (EURUSD, USDJPY, USDINR…).
 *  Every other cross — EUR/JPY, GBP/INR — is arithmetic on those. Deriving it
 *  here is legitimate and standard, but it is NOT the same as a quoted cross:
 *  a derived rate carries both legs' staleness and none of the real cross's
 *  bid-ask. The UI says so.
 *
 *  Pure, so the triangulation can be tested without a feed.
 */

export type UsdQuote = {
  /** The symbol as the feed names it, e.g. "EURUSD=X" or "USDINR=X". */
  sym: string;
  rate: number | null;
};

/** Currencies the matrix can express, in display order. */
export const FX_CCYS = ["USD", "EUR", "GBP", "JPY", "CHF", "INR", "AUD", "CAD", "CNY", "SGD"];

/**
 * Value of ONE unit of each currency in USD.
 *
 * Two symbol shapes exist and they mean opposite things:
 *   EURUSD=X  -> dollars per euro          (already USD-per-unit)
 *   USDINR=X  -> rupees per dollar         (must be inverted)
 * Getting this backwards silently produces rates that are off by orders of
 * magnitude but still look like numbers, so it's handled explicitly.
 */
export function usdPerUnit(quotes: UsdQuote[]): Record<string, number> {
  const out: Record<string, number> = { USD: 1 };
  for (const q of quotes) {
    if (q.rate == null || !Number.isFinite(q.rate) || q.rate <= 0) continue;
    const m = /^([A-Z]{3})([A-Z]{3})=X$/.exec(q.sym.toUpperCase());
    if (!m) continue;
    const [, base, quote] = m;
    if (quote === "USD") out[base] = q.rate;          // EURUSD: USD per EUR
    else if (base === "USD") out[quote] = 1 / q.rate; // USDINR: invert
  }
  return out;
}

/**
 * Cross rate: how many units of `quote` buy one unit of `base`.
 * Null when either leg is missing — never a guess.
 */
export function cross(usd: Record<string, number>, base: string, quote: string): number | null {
  if (base === quote) return 1;
  const b = usd[base], q = usd[quote];
  if (b == null || q == null || !(q > 0)) return null;
  return b / q;
}

export type CrossMatrix = {
  ccys: string[];
  /** rows[i][j] = units of ccys[j] per one ccys[i]. */
  rows: (number | null)[][];
  /** Currencies with no usable quote, so the UI can say which are absent. */
  missing: string[];
};

export function crossMatrix(quotes: UsdQuote[], ccys: string[] = FX_CCYS): CrossMatrix {
  const usd = usdPerUnit(quotes);
  const missing = ccys.filter((c) => usd[c] == null);
  return {
    ccys,
    rows: ccys.map((b) => ccys.map((q) => cross(usd, b, q))),
    missing,
  };
}

/** Sensible precision: JPY-style rates want 2 dp, EURUSD wants 4. */
export function fxDigits(rate: number | null): number {
  if (rate == null || !Number.isFinite(rate)) return 2;
  const a = Math.abs(rate);
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  return 6;
}
