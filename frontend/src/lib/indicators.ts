/** Technical indicators computed client-side from daily closes.
 *  All return arrays aligned to the input (nulls where the window isn't
 *  full yet), so they plot directly against the same time axis. */

export type Point = { time: number; value: number };
export type OHLC = { time: number; open: number; high: number; low: number; close: number; volume?: number | null };

export function sma(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    if (i === period - 1) {
      prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (prev != null) {
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function bollinger(closes: number[], period = 20, mult = 2):
    { upper: (number | null)[]; lower: (number | null)[]; mid: (number | null)[] } {
  const mid = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i]!;
    const win = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(win.reduce((a, c) => a + (c - m) ** 2, 0) / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, lower, mid };
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signalP = 9):
    { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: (number | null)[] = closes.map((_, i) =>
    ef[i] != null && es[i] != null ? (ef[i]! - es[i]!) : null);
  // Signal = EMA of the MACD line over its non-null tail.
  const start = line.findIndex((v) => v != null);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  if (start >= 0) {
    const vals = line.slice(start) as number[];
    const sig = ema(vals, signalP);
    for (let i = 0; i < sig.length; i++) signal[start + i] = sig[i];
  }
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i]! : null));
  return { macd: line, signal, hist };
}
