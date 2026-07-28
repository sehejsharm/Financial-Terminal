/** Technical indicators beyond the basic moving-average set.
 *
 *  All pure, all aligned to the input array (index i of the output describes
 *  bar i), all returning `null` where the window isn't full yet rather than
 *  0 — a zero would plot as a real value and read as a signal.
 *
 *  Every one of these is a textbook definition, not an approximation. Where a
 *  choice exists (Wilder's smoothing vs a simple average, for instance) the
 *  conventional one is used and the comment says which.
 */

export type Bar = {
  time: number | string;
  open: number; high: number; low: number; close: number;
  volume?: number | null;
};

type Series = (number | null)[];

const nulls = (n: number): Series => new Array(n).fill(null);

/** Simple moving average over an arbitrary series (skips leading nulls). */
function smaOf(xs: Series, period: number): Series {
  const out = nulls(xs.length);
  let sum = 0, count = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v != null) { sum += v; count++; }
    if (i >= period) {
      const drop = xs[i - period];
      if (drop != null) { sum -= drop; count--; }
    }
    if (i >= period - 1 && count === period) out[i] = sum / period;
  }
  return out;
}

/**
 * Wilder's smoothing — the recursive average used by RSI, ATR, ADX and MFI.
 * It is NOT the same as an EMA (alpha is 1/n, not 2/(n+1)); using an EMA here
 * is a common source of values that look close but never match a real
 * terminal's.
 */
function wilder(xs: Series, period: number): Series {
  const out = nulls(xs.length);
  let acc = 0, n = 0, prev: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v == null) continue;
    if (prev == null) {
      acc += v; n++;
      if (n === period) { prev = acc / period; out[i] = prev; }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

// ── volume-weighted average price ─────────────────────────────────────────

/**
 * VWAP, cumulative from the first bar supplied.
 *
 * NOTE: a trading desk's VWAP resets each session. These series are daily
 * bars for most periods, so this is a running VWAP over the window shown —
 * useful as a cost basis, but it is not an intraday session VWAP. The chart
 * labels it accordingly.
 */
export function vwap(bars: Bar[]): Series {
  const out = nulls(bars.length);
  let pv = 0, vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const v = b.volume;
    if (v == null || !Number.isFinite(v) || v <= 0) {
      out[i] = vol > 0 ? pv / vol : null;
      continue;
    }
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * v;
    vol += v;
    out[i] = pv / vol;
  }
  return out;
}

// ── volatility ────────────────────────────────────────────────────────────

/** True range for each bar (needs the previous close). */
export function trueRange(bars: Bar[]): Series {
  const out = nulls(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { out[i] = b.high - b.low; continue; }
    const pc = bars[i - 1].close;
    out[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return out;
}

/** Average True Range (Wilder). */
export function atr(bars: Bar[], period = 14): Series {
  return wilder(trueRange(bars), period);
}

// ── oscillators ───────────────────────────────────────────────────────────

/** Stochastic oscillator: %K (raw) and %D (SMA of %K). */
export function stochastic(bars: Bar[], kPeriod = 14, dPeriod = 3,
                           smoothK = 3): { k: Series; d: Series } {
  const raw = nulls(bars.length);
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    // A flat window has no range; 50 (mid) is the conventional answer and
    // avoids a divide-by-zero producing NaN or Infinity.
    raw[i] = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
  }
  const k = smoothK > 1 ? smaOf(raw, smoothK) : raw;
  return { k, d: smaOf(k, dPeriod) };
}

/** Williams %R — the stochastic inverted, on a -100..0 scale. */
export function williamsR(bars: Bar[], period = 14): Series {
  const out = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    out[i] = hi === lo ? -50 : ((hi - bars[i].close) / (hi - lo)) * -100;
  }
  return out;
}

/** Commodity Channel Index, using the mean-absolute-deviation denominator. */
export function cci(bars: Bar[], period = 20): Series {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const ma = smaOf(tp, period);
  const out = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    const m = ma[i];
    if (m == null) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m);
    const mad = dev / period;
    out[i] = mad === 0 ? 0 : (tp[i] - m) / (0.015 * mad);
  }
  return out;
}

/** Rate of change, in percent, over `period` bars. */
export function roc(closes: number[], period = 12): Series {
  const out = nulls(closes.length);
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period];
    if (base) out[i] = ((closes[i] - base) / base) * 100;
  }
  return out;
}

/** Money Flow Index — a volume-weighted RSI. Null throughout when the bars
 *  carry no volume, rather than silently degenerating to 50. */
export function mfi(bars: Bar[], period = 14): Series {
  if (!bars.some((b) => b.volume != null && b.volume > 0)) return nulls(bars.length);
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const pos = nulls(bars.length), neg = nulls(bars.length);
  for (let i = 1; i < bars.length; i++) {
    const flow = tp[i] * (bars[i].volume ?? 0);
    pos[i] = tp[i] > tp[i - 1] ? flow : 0;
    neg[i] = tp[i] < tp[i - 1] ? flow : 0;
  }
  const out = nulls(bars.length);
  for (let i = period; i < bars.length; i++) {
    let p = 0, n = 0;
    for (let j = i - period + 1; j <= i; j++) { p += pos[j] ?? 0; n += neg[j] ?? 0; }
    out[i] = n === 0 ? 100 : 100 - 100 / (1 + p / n);
  }
  return out;
}

/** On-Balance Volume. Null throughout when there is no volume to balance. */
export function obv(bars: Bar[]): Series {
  if (!bars.some((b) => b.volume != null && b.volume > 0)) return nulls(bars.length);
  const out = nulls(bars.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < bars.length; i++) {
    const v = bars[i].volume ?? 0;
    if (bars[i].close > bars[i - 1].close) acc += v;
    else if (bars[i].close < bars[i - 1].close) acc -= v;
    out[i] = acc;
  }
  return out;
}

// ── trend strength ────────────────────────────────────────────────────────

/** ADX with its +DI / -DI components (Wilder). */
export function adx(bars: Bar[], period = 14):
    { adx: Series; plusDi: Series; minusDi: Series } {
  const n = bars.length;
  const plusDm = nulls(n), minusDm = nulls(n);
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(bars), period);
  const pdm = wilder(plusDm, period);
  const mdm = wilder(minusDm, period);

  const plusDi = nulls(n), minusDi = nulls(n), dx = nulls(n);
  for (let i = 0; i < n; i++) {
    const t = tr[i], p = pdm[i], m = mdm[i];
    if (t == null || p == null || m == null || t === 0) continue;
    plusDi[i] = (p / t) * 100;
    minusDi[i] = (m / t) * 100;
    const sum = plusDi[i]! + minusDi[i]!;
    dx[i] = sum === 0 ? 0 : (Math.abs(plusDi[i]! - minusDi[i]!) / sum) * 100;
  }
  return { adx: wilder(dx, period), plusDi, minusDi };
}

// ── channels & bands ──────────────────────────────────────────────────────

/** Donchian channel — highest high and lowest low of the last `period` bars. */
export function donchian(bars: Bar[], period = 20):
    { upper: Series; lower: Series; mid: Series } {
  const upper = nulls(bars.length), lower = nulls(bars.length), mid = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    upper[i] = hi; lower[i] = lo; mid[i] = (hi + lo) / 2;
  }
  return { upper, lower, mid };
}

/** Keltner channel — an EMA centre with ATR-scaled bands. */
export function keltner(bars: Bar[], period = 20, mult = 2, atrPeriod = 10):
    { upper: Series; lower: Series; mid: Series } {
  const closes = bars.map((b) => b.close);
  const mid = emaOf(closes, period);
  const a = atr(bars, atrPeriod);
  const upper = nulls(bars.length), lower = nulls(bars.length);
  for (let i = 0; i < bars.length; i++) {
    if (mid[i] == null || a[i] == null) continue;
    upper[i] = mid[i]! + mult * a[i]!;
    lower[i] = mid[i]! - mult * a[i]!;
  }
  return { upper, lower, mid };
}

/** EMA over a plain number array (local copy so this module stands alone). */
function emaOf(xs: number[], period: number): Series {
  const out = nulls(xs.length);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    if (i === period - 1) {
      prev = xs.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (prev != null) {
      prev = xs[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// ── trend-following overlays ──────────────────────────────────────────────

/**
 * Parabolic SAR. Returns the stop level per bar plus the trend direction, so
 * the chart can colour the dots.
 */
export function psar(bars: Bar[], step = 0.02, max = 0.2):
    { sar: Series; rising: (boolean | null)[] } {
  const n = bars.length;
  const sar = nulls(n);
  const rising: (boolean | null)[] = new Array(n).fill(null);
  if (n < 2) return { sar, rising };

  let up = bars[1].close >= bars[0].close;
  let acc = step;
  let ep = up ? bars[0].high : bars[0].low;
  let cur = up ? bars[0].low : bars[0].high;

  for (let i = 1; i < n; i++) {
    cur = cur + acc * (ep - cur);
    // The stop may not move inside the last two bars' range.
    if (up) {
      cur = Math.min(cur, bars[i - 1].low, bars[Math.max(0, i - 2)].low);
      if (bars[i].low < cur) {         // flip
        up = false; cur = ep; ep = bars[i].low; acc = step;
      } else if (bars[i].high > ep) {
        ep = bars[i].high; acc = Math.min(acc + step, max);
      }
    } else {
      cur = Math.max(cur, bars[i - 1].high, bars[Math.max(0, i - 2)].high);
      if (bars[i].high > cur) {
        up = true; cur = ep; ep = bars[i].high; acc = step;
      } else if (bars[i].low < ep) {
        ep = bars[i].low; acc = Math.min(acc + step, max);
      }
    }
    sar[i] = cur;
    rising[i] = up;
  }
  return { sar, rising };
}

/** Supertrend — an ATR band that flips side with the trend. */
export function supertrend(bars: Bar[], period = 10, mult = 3):
    { line: Series; rising: (boolean | null)[] } {
  const n = bars.length;
  const a = atr(bars, period);
  const line = nulls(n);
  const rising: (boolean | null)[] = new Array(n).fill(null);
  let upper: number | null = null, lower: number | null = null, up = true;

  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    let bUp = mid + mult * a[i]!;
    let bLo = mid - mult * a[i]!;
    // Bands ratchet: they only tighten while the trend holds.
    if (upper != null && bars[i - 1] && bars[i - 1].close <= upper) bUp = Math.min(bUp, upper);
    if (lower != null && bars[i - 1] && bars[i - 1].close >= lower) bLo = Math.max(bLo, lower);

    if (upper == null) { up = true; }
    else if (up && bars[i].close < lower!) up = false;
    else if (!up && bars[i].close > upper) up = true;

    upper = bUp; lower = bLo;
    line[i] = up ? bLo : bUp;
    rising[i] = up;
  }
  return { line, rising };
}

/** Ichimoku cloud. Spans are returned UNSHIFTED — the chart displaces them
 *  forward, since shifting here would silently misalign the time axis. */
export function ichimoku(bars: Bar[], conv = 9, base = 26, spanB = 52):
    { conversion: Series; base: Series; spanA: Series; spanB: Series; lagging: Series } {
  const midOf = (period: number): Series => {
    const out = nulls(bars.length);
    for (let i = period - 1; i < bars.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        hi = Math.max(hi, bars[j].high);
        lo = Math.min(lo, bars[j].low);
      }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };
  const conversion = midOf(conv);
  const baseLine = midOf(base);
  const spanA = bars.map((_, i) =>
    conversion[i] != null && baseLine[i] != null
      ? (conversion[i]! + baseLine[i]!) / 2 : null);
  const lagging = bars.map((_, i) =>
    i + base < bars.length ? bars[i + base].close : null);
  return { conversion, base: baseLine, spanA, spanB: midOf(spanB), lagging };
}
