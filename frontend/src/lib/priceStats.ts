/** How the stock has actually done.
 *
 *  The snapshot showed a P/E, a beta and a chart. What it never showed is the
 *  thing every reader works out for themselves in the first ten seconds: how
 *  has this performed over a week, a month, a year, and how rough was the
 *  ride. Those come free from the candles the chart has already fetched — no
 *  extra request, no new provider.
 *
 *  Pure, because the horizon arithmetic has an easy mistake in it: counting
 *  BACK a fixed number of bars is not the same as counting back a fixed
 *  number of calendar days, and a market with holidays makes the two diverge.
 *  These use dates.
 */

export type Candle = Record<string, unknown>;

export type Bar = { t: number; close: number };

const CLOSE_KEYS = ["close", "Close", "c", "adjClose", "Adj Close"];
const TIME_KEYS = ["time", "Date", "date", "Datetime", "datetime", "t"];

function pick(c: Candle, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

/** Candles in, clean ascending bars out. Anything unparseable is dropped. */
export function toBars(candles: Candle[] | null | undefined): Bar[] {
  const out: Bar[] = [];
  for (const c of candles ?? []) {
    if (!c || typeof c !== "object") continue;
    const rawClose = pick(c, CLOSE_KEYS);
    const rawTime = pick(c, TIME_KEYS);
    const close = typeof rawClose === "number" ? rawClose : Number(rawClose);
    if (!Number.isFinite(close) || close <= 0) continue;
    let t: number;
    if (typeof rawTime === "number") {
      // Seconds or milliseconds — anything below this is not a plausible
      // millisecond timestamp for a traded security.
      t = rawTime < 1e11 ? rawTime * 1000 : rawTime;
    } else {
      t = Date.parse(String(rawTime));
    }
    if (!Number.isFinite(t)) continue;
    out.push({ t, close });
  }
  return out.sort((a, b) => a.t - b.t);
}

export const HORIZONS = [
  { key: "1w", label: "1 week", days: 7 },
  { key: "1m", label: "1 month", days: 30 },
  { key: "3m", label: "3 months", days: 91 },
  { key: "6m", label: "6 months", days: 182 },
  { key: "1y", label: "1 year", days: 365 },
] as const;

export type HorizonReturn = {
  key: string;
  label: string;
  pct: number | null;
  /** The bar the return was measured from, so the window is inspectable. */
  fromDate: string | null;
};

/**
 * Return over each horizon, measured from the last bar backwards in DAYS.
 *
 * Counting back a fixed number of bars would be simpler and wrong: a market
 * with holidays gives "20 bars ago" a different date every time you ask, and
 * two names on different exchanges stop being comparable.
 *
 * The bar used is the last one at or before the cutoff, so a window whose
 * start lands on a holiday takes the previous session rather than skipping
 * to the next one and shortening the period.
 */
export function horizonReturns(bars: Bar[]): HorizonReturn[] {
  if (bars.length < 2) {
    return HORIZONS.map((h) => ({ key: h.key, label: h.label, pct: null, fromDate: null }));
  }
  const last = bars[bars.length - 1];
  const firstT = bars[0].t;

  return HORIZONS.map((h) => {
    const cutoff = last.t - h.days * 86_400_000;
    // Not enough history to cover this window: report nothing rather than
    // measuring from the oldest bar and labelling a 4-month return "1 year".
    if (cutoff < firstT) {
      return { key: h.key, label: h.label, pct: null, fromDate: null };
    }
    let idx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].t <= cutoff) { idx = i; break; }
    }
    if (idx < 0) return { key: h.key, label: h.label, pct: null, fromDate: null };
    const base = bars[idx];
    return {
      key: h.key,
      label: h.label,
      pct: ((last.close / base.close) - 1) * 100,
      fromDate: new Date(base.t).toISOString().slice(0, 10),
    };
  });
}

/** Year-to-date, from the last close of the previous calendar year. */
export function ytdReturn(bars: Bar[]): HorizonReturn {
  const empty = { key: "ytd", label: "Year to date", pct: null, fromDate: null };
  if (bars.length < 2) return empty;
  const last = bars[bars.length - 1];
  const startOfYear = Date.UTC(new Date(last.t).getUTCFullYear(), 0, 1);
  let idx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].t < startOfYear) { idx = i; break; }
  }
  if (idx < 0) return empty;
  const base = bars[idx];
  return {
    key: "ytd", label: "Year to date",
    pct: ((last.close / base.close) - 1) * 100,
    fromDate: new Date(base.t).toISOString().slice(0, 10),
  };
}

export type RideStats = {
  /** Annualised standard deviation of daily log returns, in percent. */
  annualVolPct: number | null;
  /** Deepest peak-to-trough fall across the window, in percent (negative). */
  maxDrawdownPct: number | null;
  /** Where the last close sits between the window's low and high, 0–100. */
  rangePosition: number | null;
  high: number | null;
  low: number | null;
  bars: number;
};

/** Volatility, drawdown and where in its own range the price sits. */
export function rideStats(bars: Bar[], periodsPerYear = 252): RideStats {
  const empty: RideStats = {
    annualVolPct: null, maxDrawdownPct: null, rangePosition: null,
    high: null, low: null, bars: bars.length,
  };
  if (bars.length < 3) return empty;

  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    rets.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  // Sample standard deviation: n-1, because these are a sample of the
  // return process rather than the whole of it.
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance * periodsPerYear) * 100;

  let peak = bars[0].close;
  let worst = 0;
  for (const b of bars) {
    if (b.close > peak) peak = b.close;
    const dd = (b.close / peak - 1) * 100;
    if (dd < worst) worst = dd;
  }

  const closes = bars.map((b) => b.close);
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const last = closes[closes.length - 1];

  return {
    annualVolPct: Number.isFinite(vol) ? vol : null,
    maxDrawdownPct: worst,
    rangePosition: high > low ? ((last - low) / (high - low)) * 100 : null,
    high, low, bars: bars.length,
  };
}

/** One line about the ride, stating the window it used. */
export function performanceNote(bars: Bar[], stats: RideStats): string {
  if (bars.length < 3) {
    return "Not enough price history loaded to measure performance. Switch to "
      + "a longer chart period.";
  }
  const from = new Date(bars[0].t).toISOString().slice(0, 10);
  const to = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
  const parts = [
    `Measured across ${stats.bars} sessions, ${from} to ${to}, on the same `
      + "candles the chart is drawing — change the chart period and these "
      + "change with it.",
  ];
  if (stats.maxDrawdownPct != null && stats.maxDrawdownPct < -20) {
    parts.push(`The worst peak-to-trough fall inside that window was `
      + `${stats.maxDrawdownPct.toFixed(0)}%, which is what holding it `
      + "actually felt like — an annual return hides that entirely.");
  }
  parts.push("Returns are price only: dividends are not added back, so total "
    + "return on a high-yielding name is higher than shown.");
  return parts.join(" ");
}
