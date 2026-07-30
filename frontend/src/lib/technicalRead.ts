/** What the indicators are actually saying.
 *
 *  GIP drew a chart with fourteen indicators available and left every reading
 *  to the eye. Drawing RSI is not the same as telling someone it is at 78 and
 *  what that means, and a reader flipping between overlays is doing the
 *  interpretation the screen could have done.
 *
 *  So each indicator gets its latest value, a signal, and one line of plain
 *  language. Then the signals are counted — NOT averaged into a score, because
 *  they are not independent: four trend-following indicators agreeing is one
 *  observation repeated four times, and a "9 of 12 bullish" gauge dressed up
 *  as a verdict is the most misleading thing a technicals screen can do.
 *
 *  Pure, so the thresholds are visible and testable rather than buried in a
 *  component.
 */

import { bollinger, ema, macd, rsi, sma } from "@/lib/indicators";
import { adx, atr, mfi, stochastic, supertrend } from "@/lib/indicatorsPlus";
import type { Bar } from "@/lib/indicatorsPlus";

export type Signal = "bullish" | "bearish" | "neutral";

export type Reading = {
  key: string;
  label: string;
  /** The latest value, formatted by the caller. */
  value: number | null;
  /** A second number where the indicator is a pair (MACD/signal, %K/%D). */
  extra?: number | null;
  unit: "" | "%" | "px";
  signal: Signal;
  /** One sentence on what this reading means. */
  read: string;
  group: "Trend" | "Momentum" | "Volatility" | "Volume";
};

function lastNum(xs: (number | null)[]): number | null {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] != null) return xs[i]!;
  }
  return null;
}

function lastBool(xs: (boolean | null)[]): boolean | null {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] != null) return xs[i]!;
  }
  return null;
}

/** Sessions needed before any of this is worth computing. */
export const MIN_BARS = 60;

const KEYS = {
  time: ["time", "Date", "Datetime", "date", "datetime", "index", "t"],
  open: ["open", "Open", "o"],
  high: ["high", "High", "h"],
  low: ["low", "Low", "l"],
  close: ["close", "Close", "c"],
  volume: ["volume", "Volume", "v"],
};

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

/**
 * Raw provider candles → OHLC bars, ascending, unusable rows dropped.
 *
 * Deliberately leaves `volume` null when the provider didn't send one instead
 * of substituting 0: a zero volume would let the money-flow reads compute off
 * nothing and print a confident number, whereas a null makes them drop out.
 */
export function toOhlc(candles: Record<string, unknown>[] | null | undefined): Bar[] {
  const out: Bar[] = [];
  for (const c of candles ?? []) {
    if (!c || typeof c !== "object") continue;
    const close = Number(pick(c, KEYS.close));
    if (!Number.isFinite(close) || close <= 0) continue;
    const rawTime = pick(c, KEYS.time);
    const t = typeof rawTime === "string"
      // Twelve Data sends "YYYY-MM-DD HH:MM:SS"; Safari refuses the space.
      ? Date.parse(rawTime.replace(" ", "T"))
      : Number(rawTime) < 1e11 ? Number(rawTime) * 1000 : Number(rawTime);
    if (!Number.isFinite(t)) continue;
    const open = Number(pick(c, KEYS.open) ?? close);
    const rawVol = pick(c, KEYS.volume);
    const vol = rawVol == null ? null : Number(rawVol);
    out.push({
      time: t,
      open: Number.isFinite(open) ? open : close,
      high: Number(pick(c, KEYS.high) ?? Math.max(open, close)),
      low: Number(pick(c, KEYS.low) ?? Math.min(open, close)),
      close,
      volume: vol != null && Number.isFinite(vol) && vol > 0 ? vol : null,
    });
  }
  return out
    .filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low))
    .sort((a, b) => (a.time as number) - (b.time as number));
}

export function technicalReadings(bars: Bar[]): Reading[] {
  if (bars.length < MIN_BARS) return [];
  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];
  const out: Reading[] = [];

  // ── trend ─────────────────────────────────────────────────────────────
  const ma50 = lastNum(sma(closes, 50));
  const ma200 = lastNum(sma(closes, 200));
  if (ma50 != null) {
    const above = price >= ma50;
    out.push({
      key: "ma50", label: "Price vs 50-day", value: ((price / ma50) - 1) * 100,
      unit: "%", signal: above ? "bullish" : "bearish", group: "Trend",
      read: above
        ? "Trading above its 50-day average — the medium-term trend is up."
        : "Trading below its 50-day average — the medium-term trend is down.",
    });
  }
  if (ma200 != null) {
    const above = price >= ma200;
    out.push({
      key: "ma200", label: "Price vs 200-day", value: ((price / ma200) - 1) * 100,
      unit: "%", signal: above ? "bullish" : "bearish", group: "Trend",
      read: above
        ? "Above the 200-day average, the line most long-only mandates watch."
        : "Below the 200-day average, which many mandates treat as a stop.",
    });
  }
  if (ma50 != null && ma200 != null) {
    const golden = ma50 >= ma200;
    out.push({
      key: "cross", label: "50-day vs 200-day",
      value: ((ma50 / ma200) - 1) * 100, unit: "%",
      signal: golden ? "bullish" : "bearish", group: "Trend",
      read: golden
        ? "The 50-day sits above the 200-day — a 'golden cross' structure. It "
          + "is a slow signal: by the time it forms, much of the move has run."
        : "The 50-day sits below the 200-day — a 'death cross' structure, and "
          + "equally slow to form.",
    });
  }

  const st = supertrend(bars);
  // `rising` is per-bar and only set once ATR exists, so take the last one
  // that is actually a boolean rather than the last element of the array.
  const stUp = lastBool(st.rising);
  if (stUp != null) {
    out.push({
      key: "supertrend", label: "Supertrend stop",
      value: lastNum(st.line), unit: "px",
      signal: stUp ? "bullish" : "bearish", group: "Trend",
      read: stUp
        ? "Supertrend is long — the trailing stop sits below the price."
        : "Supertrend is short — the trailing stop sits above the price.",
    });
  }

  const ax = adx(bars);
  const adxV = lastNum(ax.adx);
  if (adxV != null) {
    // ADX measures trend STRENGTH, not direction. Reading it as bullish is
    // one of the most common misuses of an indicator.
    out.push({
      key: "adx", label: "ADX (trend strength)", value: adxV, unit: "",
      signal: "neutral", group: "Trend",
      read: adxV >= 25
        ? `At ${adxV.toFixed(0)}, the trend is strong enough that trend-following `
          + "reads carry weight. ADX says nothing about direction."
        : `At ${adxV.toFixed(0)}, there is no strong trend — which is exactly when `
          + "trend indicators produce false signals. ADX says nothing about "
          + "direction.",
    });
  }

  // ── momentum ──────────────────────────────────────────────────────────
  const r = lastNum(rsi(closes, 14));
  if (r != null) {
    out.push({
      key: "rsi", label: "RSI (14)", value: r, unit: "",
      signal: r >= 70 ? "bearish" : r <= 30 ? "bullish" : "neutral",
      group: "Momentum",
      read: r >= 70
        ? `Overbought at ${r.toFixed(0)}. In a strong uptrend RSI can sit above `
          + "70 for months, so this is a caution rather than a sell."
        : r <= 30
          ? `Oversold at ${r.toFixed(0)}. In a downtrend it can stay there just `
            + "as long — cheap is not the same as turning."
          : `Neutral at ${r.toFixed(0)}.`,
    });
  }

  const m = macd(closes);
  const macdV = lastNum(m.macd);
  const sigV = lastNum(m.signal);
  if (macdV != null && sigV != null) {
    const above = macdV >= sigV;
    out.push({
      key: "macd", label: "MACD vs signal", value: macdV, extra: sigV, unit: "px",
      signal: above ? "bullish" : "bearish", group: "Momentum",
      read: above
        ? "MACD is above its signal line — momentum is positive."
        : "MACD is below its signal line — momentum is negative.",
    });
  }

  const stoch = stochastic(bars);
  const k = lastNum(stoch.k);
  if (k != null) {
    out.push({
      key: "stoch", label: "Stochastic %K", value: k,
      extra: lastNum(stoch.d), unit: "", group: "Momentum",
      signal: k >= 80 ? "bearish" : k <= 20 ? "bullish" : "neutral",
      read: k >= 80 ? "In the top fifth of its recent range."
        : k <= 20 ? "In the bottom fifth of its recent range."
        : "Mid-range.",
    });
  }

  // ── volatility ────────────────────────────────────────────────────────
  const bb = bollinger(closes, 20, 2);
  const upper = lastNum(bb.upper);
  const lower = lastNum(bb.lower);
  if (upper != null && lower != null && upper > lower) {
    const pos = ((price - lower) / (upper - lower)) * 100;
    out.push({
      key: "bb", label: "Position in Bollinger band", value: pos, unit: "%",
      // Touching a band is not a signal on its own — price rides the upper
      // band through an entire advance — so this is reported, not scored.
      signal: "neutral", group: "Volatility",
      read: pos >= 100 ? "Above the upper band: stretched, but price rides the "
          + "band throughout a strong advance."
        : pos <= 0 ? "Below the lower band: stretched to the downside, with the "
          + "same caveat in reverse."
        : `${pos.toFixed(0)}% of the way up the band.`,
    });
  }

  const a = lastNum(atr(bars, 14));
  if (a != null && price > 0) {
    const pct = (a / price) * 100;
    out.push({
      key: "atr", label: "ATR (14) as % of price", value: pct, unit: "%",
      signal: "neutral", group: "Volatility",
      read: `A typical day moves about ${pct.toFixed(1)}% — size a stop against `
        + "this rather than a round number.",
    });
  }

  // ── volume ────────────────────────────────────────────────────────────
  const mf = lastNum(mfi(bars, 14));
  if (mf != null) {
    out.push({
      key: "mfi", label: "Money flow index", value: mf, unit: "", group: "Volume",
      signal: mf >= 80 ? "bearish" : mf <= 20 ? "bullish" : "neutral",
      read: mf >= 80 ? "Money flow is stretched high — buying has been heavy."
        : mf <= 20 ? "Money flow is stretched low — selling has been heavy."
        : "Money flow is unremarkable.",
    });
  }

  const e20 = lastNum(ema(closes, 20));
  if (e20 != null) {
    out.push({
      key: "ema20", label: "Price vs 20-day EMA",
      value: ((price / e20) - 1) * 100, unit: "%",
      signal: price >= e20 ? "bullish" : "bearish", group: "Trend",
      read: price >= e20
        ? "Above the 20-day EMA — short-term drift is up."
        : "Below the 20-day EMA — short-term drift is down.",
    });
  }

  return out;
}

// ── key levels ────────────────────────────────────────────────────────────

export type Level = {
  label: string;
  price: number;
  /** Distance from the last close, in percent (signed: + is above). */
  distancePct: number;
  kind: "resistance" | "support";
  /** How many sessions touched within 1% of this level. */
  touches: number;
};

/** Swing pivots: a bar whose high is the highest (or low the lowest) within
 *  `span` bars either side. Fewer, more meaningful levels than every local
 *  wiggle, which is what makes them worth drawing. */
function pivots(bars: Bar[], span: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [], lows: number[] = [];
  for (let i = span; i < bars.length - span; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) highs.push(bars[i].high);
    if (isLow) lows.push(bars[i].low);
  }
  return { highs, lows };
}

/** Collapse levels within `tolPct` of each other into one, keeping the mean
 *  and counting the members — a level three swings agree on is a real level,
 *  and three lines an inch apart on a chart is noise. */
function cluster(prices: number[], tolPct: number): { price: number; n: number }[] {
  const sorted = [...prices].sort((a, b) => a - b);
  const out: { price: number; n: number }[] = [];
  for (const p of sorted) {
    const tail = out[out.length - 1];
    if (tail && Math.abs(p - tail.price) / tail.price * 100 <= tolPct) {
      tail.price = (tail.price * tail.n + p) / (tail.n + 1);
      tail.n += 1;
    } else {
      out.push({ price: p, n: 1 });
    }
  }
  return out;
}

/**
 * The levels a trader would actually mark up: the window high and low, and the
 * nearest clustered swing pivots above and below the price.
 *
 * Capped at the two nearest on each side. A screen listing twelve levels has
 * told the reader nothing — the useful question is what is directly overhead
 * and what is directly beneath.
 */
export function keyLevels(bars: Bar[], maxPerSide = 2): Level[] {
  if (bars.length < 20) return [];
  const price = bars[bars.length - 1].close;
  const { highs, lows } = pivots(bars, 5);
  const near = (p: number) =>
    bars.filter((b) => b.high >= p * 0.99 && b.low <= p * 1.01).length;

  const mk = (label: string, p: number): Level => ({
    label, price: p,
    distancePct: ((p / price) - 1) * 100,
    kind: p >= price ? "resistance" : "support",
    touches: near(p),
  });

  const above = cluster(highs.filter((h) => h > price), 1.5)
    .sort((a, b) => a.price - b.price).slice(0, maxPerSide)
    .map((c, i) => mk(i === 0 ? "Nearest resistance" : "Next resistance", c.price));
  const below = cluster(lows.filter((l) => l < price), 1.5)
    .sort((a, b) => b.price - a.price).slice(0, maxPerSide)
    .map((c, i) => mk(i === 0 ? "Nearest support" : "Next support", c.price));

  const windowHigh = Math.max(...bars.map((b) => b.high));
  const windowLow = Math.min(...bars.map((b) => b.low));
  const extremes = [
    mk("Window high", windowHigh),
    mk("Window low", windowLow),
  ];

  // Drop a pivot that is effectively the window extreme already listed.
  const isDupe = (l: Level) => extremes.some((e) =>
    Math.abs(l.price - e.price) / e.price * 100 <= 0.5);

  return [...extremes, ...above.filter((l) => !isDupe(l)),
          ...below.filter((l) => !isDupe(l))]
    .sort((a, b) => b.price - a.price);
}

/** What the level structure means for sizing a trade. */
export function levelNote(levels: Level[]): string {
  if (!levels.length) {
    return "Not enough bars loaded to identify swing levels.";
  }
  const res = levels.filter((l) => l.kind === "resistance" && l.label !== "Window high");
  const sup = levels.filter((l) => l.kind === "support" && l.label !== "Window low");
  const parts: string[] = [];
  if (res[0] && sup[0]) {
    const room = res[0].distancePct;
    const risk = -sup[0].distancePct;
    parts.push(`Roughly ${room.toFixed(1)}% of room to the nearest resistance `
      + `against ${risk.toFixed(1)}% to the nearest support — a `
      + `${(room / risk).toFixed(1)}:1 ratio before any position sizing.`);
  }
  parts.push("These are swing pivots clustered within 1.5%, not lines anyone "
    + "else is watching: they come from this window's bars only, so a different "
    + "chart period gives different levels. Volume at a level matters more than "
    + "the level, and neither is a reason to trade on its own.");
  return parts.join(" ");
}

export type SignalTally = {
  bullish: number;
  bearish: number;
  neutral: number;
  /** Signals that carry a direction at all. */
  directional: number;
};

export function tally(readings: Reading[]): SignalTally {
  const bullish = readings.filter((r) => r.signal === "bullish").length;
  const bearish = readings.filter((r) => r.signal === "bearish").length;
  const neutral = readings.filter((r) => r.signal === "neutral").length;
  return { bullish, bearish, neutral, directional: bullish + bearish };
}

/**
 * The honest summary.
 *
 * Reports the count and then says why the count is not a score. Most of these
 * indicators are functions of the same moving averages, so "nine of twelve
 * bullish" is one observation repeated, and presenting it as a consensus is
 * the single most misleading thing a technicals screen can do.
 */
export function technicalNote(readings: Reading[], t: SignalTally,
                              bars: number): string {
  if (!readings.length) {
    return `Only ${bars} sessions loaded — under ${MIN_BARS} the longer `
      + "averages don't exist yet and the rest would be computed off a "
      + "handful of bars. Switch to a longer chart period.";
  }
  const lead = t.bullish > t.bearish
    ? `${t.bullish} of ${t.directional} directional indicators read bullish`
    : t.bearish > t.bullish
      ? `${t.bearish} of ${t.directional} directional indicators read bearish`
      : `Directional indicators are split ${t.bullish}–${t.bearish}`;

  return `${lead}, with ${t.neutral} carrying no direction. That is a COUNT, `
    + "not a score, and it should not be read as a consensus: most of these "
    + "are functions of the same few moving averages, so several agreeing is "
    + "often one observation repeated rather than independent confirmation. "
    + "Every indicator here is also computed from past prices only — they "
    + "describe what has happened, and they all turn late.";
}
