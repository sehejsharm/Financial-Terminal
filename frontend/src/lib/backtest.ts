/** Long/flat strategy backtester over daily bars.
 *
 *  Pure and dependency-free so it can be unit-tested and re-run instantly in
 *  the browser when a parameter changes — no round trip per tweak.
 *
 *  EXECUTION MODEL (stated here because it is the thing that makes or breaks
 *  a backtest's honesty):
 *    - A signal is computed from bar `i`'s CLOSE.
 *    - It is acted on at bar `i+1`'s close, i.e. position[i] = signal[i-1].
 *      No same-bar fills, so the engine cannot buy a move it only knew about
 *      after the fact.
 *    - Returns are close-to-close. Costs (bps, round-turn) are charged on the
 *      bar the position changes.
 *    - Long or flat only. No leverage, no shorting, no dividends, no slippage
 *      model beyond the flat cost, no survivorship correction.
 *
 *  Everything here is in-sample on whatever window the caller passes. That is
 *  a description of the past, not a forecast, and the UI says so.
 */
import { ema, macd as macdOf, rsi, sma } from "@/lib/indicators";

export type Bar = { date: string; close: number };

export type StrategyId =
  | "sma_cross" | "ema_cross" | "rsi_reversion" | "macd_cross" | "donchian";

export type StrategyDef = {
  id: StrategyId;
  label: string;
  /** Plain-English rule, shown under the result so the numbers are legible. */
  rule: string;
  params: { key: string; label: string; def: number; min: number; max: number }[];
};

export const STRATEGIES: StrategyDef[] = [
  {
    id: "sma_cross",
    label: "SMA crossover",
    rule: "Long while the fast simple moving average is above the slow one; flat otherwise.",
    params: [
      { key: "fast", label: "Fast", def: 50, min: 2, max: 200 },
      { key: "slow", label: "Slow", def: 200, min: 3, max: 400 },
    ],
  },
  {
    id: "ema_cross",
    label: "EMA crossover",
    rule: "Long while the fast exponential moving average is above the slow one; flat otherwise.",
    params: [
      { key: "fast", label: "Fast", def: 12, min: 2, max: 200 },
      { key: "slow", label: "Slow", def: 26, min: 3, max: 400 },
    ],
  },
  {
    id: "rsi_reversion",
    label: "RSI mean reversion",
    rule: "Buy when RSI drops below the low threshold, hold until it rises above the high one.",
    params: [
      { key: "period", label: "Period", def: 14, min: 2, max: 60 },
      { key: "low", label: "Buy below", def: 30, min: 1, max: 49 },
      { key: "high", label: "Sell above", def: 70, min: 51, max: 99 },
    ],
  },
  {
    id: "macd_cross",
    label: "MACD signal cross",
    rule: "Long while the MACD line is above its signal line; flat otherwise.",
    params: [
      { key: "fast", label: "Fast", def: 12, min: 2, max: 100 },
      { key: "slow", label: "Slow", def: 26, min: 3, max: 200 },
      { key: "signal", label: "Signal", def: 9, min: 2, max: 50 },
    ],
  },
  {
    id: "donchian",
    label: "Donchian breakout",
    rule: "Buy on a new N-day closing high, exit on a new M-day closing low.",
    params: [
      { key: "entry", label: "Entry high", def: 55, min: 5, max: 300 },
      { key: "exit", label: "Exit low", def: 20, min: 3, max: 300 },
    ],
  },
];

export type Trade = {
  entryDate: string; exitDate: string | null;
  entryPx: number; exitPx: number | null;
  /** Net of costs, in percent. Null while the trade is still open. */
  retPct: number | null;
  bars: number;
  open: boolean;
};

export type Stats = {
  totalPct: number;
  buyHoldPct: number;
  cagrPct: number | null;
  maxDdPct: number;
  buyHoldMaxDdPct: number;
  annVolPct: number;
  sharpe: number | null;
  sortino: number | null;
  trades: number;
  winRatePct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  exposurePct: number;
  bestTradePct: number | null;
  worstTradePct: number | null;
  years: number;
  /** Bars per year inferred from the data — 252ish daily, 52ish weekly. */
  barsPerYear: number;
};

export type BacktestResult = {
  dates: string[];
  /** Growth of 1.0, net of costs. */
  equity: number[];
  buyHold: number[];
  position: number[];
  trades: Trade[];
  stats: Stats;
};

export type BacktestOptions = {
  strategy: StrategyId;
  params: Record<string, number>;
  /** Round-turn cost in basis points, charged on every position change. */
  costBps?: number;
};

const TRADING_DAYS = 252;

/**
 * Annualisation factor inferred from the bars themselves.
 *
 * The history feed serves DAILY bars for windows up to 2Y and WEEKLY bars for
 * 3Y/5Y/10Y. Hard-coding √252 would inflate weekly volatility by ~2.2x and
 * quietly wreck Sharpe on exactly the long windows a backtest cares about, so
 * the rate is derived from bar count over elapsed years instead.
 */
export function inferBarsPerYear(n: number, years: number): number {
  if (years <= 0 || n < 2) return TRADING_DAYS;
  return Math.min(TRADING_DAYS, Math.max(4, n / years));
}

function param(p: Record<string, number>, key: string, def: number): number {
  const v = p[key];
  return Number.isFinite(v) ? v : def;
}

/**
 * Raw 1/0 target exposure per bar, computed from that bar's close.
 * `null` means "not enough history yet" and is treated as flat.
 */
export function signalsFor(closes: number[], opts: BacktestOptions): number[] {
  const p = opts.params || {};
  const n = closes.length;
  const out = new Array<number>(n).fill(0);

  switch (opts.strategy) {
    case "sma_cross":
    case "ema_cross": {
      const f = Math.max(2, Math.round(param(p, "fast", 50)));
      const s = Math.max(f + 1, Math.round(param(p, "slow", 200)));
      const fn = opts.strategy === "sma_cross" ? sma : ema;
      const fa = fn(closes, f), sl = fn(closes, s);
      for (let i = 0; i < n; i++) {
        if (fa[i] != null && sl[i] != null) out[i] = fa[i]! > sl[i]! ? 1 : 0;
      }
      break;
    }
    case "rsi_reversion": {
      const period = Math.max(2, Math.round(param(p, "period", 14)));
      const low = param(p, "low", 30);
      const high = param(p, "high", 70);
      const r = rsi(closes, period);
      // State machine: entering on oversold, holding through the middle of
      // the range, exiting only on overbought. A plain `r < low` mask would
      // sell the instant RSI recovered to 31, which is not the rule.
      let held = 0;
      for (let i = 0; i < n; i++) {
        const v = r[i];
        if (v != null) {
          if (v < low) held = 1;
          else if (v > high) held = 0;
        }
        out[i] = held;
      }
      break;
    }
    case "macd_cross": {
      const { macd, signal } = macdOf(
        closes,
        Math.max(2, Math.round(param(p, "fast", 12))),
        Math.max(3, Math.round(param(p, "slow", 26))),
        Math.max(2, Math.round(param(p, "signal", 9))),
      );
      for (let i = 0; i < n; i++) {
        if (macd[i] != null && signal[i] != null) out[i] = macd[i]! > signal[i]! ? 1 : 0;
      }
      break;
    }
    case "donchian": {
      const up = Math.max(2, Math.round(param(p, "entry", 55)));
      const dn = Math.max(2, Math.round(param(p, "exit", 20)));
      let held = 0;
      for (let i = 0; i < n; i++) {
        // Compare against the window BEFORE this bar, so touching the prior
        // high counts as a breakout instead of trivially matching itself.
        if (i >= up) {
          const hi = Math.max(...closes.slice(i - up, i));
          if (closes[i] > hi) held = 1;
        }
        if (i >= dn) {
          const lo = Math.min(...closes.slice(i - dn, i));
          if (closes[i] < lo) held = 0;
        }
        out[i] = held;
      }
      break;
    }
  }
  return out;
}

function maxDrawdown(equity: number[]): number {
  let peak = -Infinity, worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst * 100;
}

function yearsBetween(a: string, b: string): number {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 0;
  return (t1 - t0) / (365.2425 * 864e5);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Minimum bars before a result is meaningful rather than noise. */
export const MIN_BARS = 60;

export function runBacktest(bars: Bar[], opts: BacktestOptions): BacktestResult | null {
  const clean = (bars || []).filter((b) => b && Number.isFinite(b.close) && b.close > 0);
  if (clean.length < MIN_BARS) return null;

  const dates = clean.map((b) => b.date);
  const closes = clean.map((b) => b.close);
  const n = closes.length;
  const cost = Math.max(0, opts.costBps ?? 0) / 10_000;

  const signal = signalsFor(closes, opts);
  // Act one bar late — position[i] is what we hold THROUGH bar i.
  const position = signal.map((_, i) => (i === 0 ? 0 : signal[i - 1]));

  const equity = new Array<number>(n).fill(1);
  const buyHold = new Array<number>(n).fill(1);
  const daily: number[] = [];
  const trades: Trade[] = [];
  let openEntryIdx = -1;
  let openEntryEquity = 1;

  for (let i = 1; i < n; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    const changed = position[i] !== position[i - 1];
    const net = position[i] * r - (changed ? cost : 0);
    daily.push(net);
    equity[i] = equity[i - 1] * (1 + net);
    buyHold[i] = buyHold[i - 1] * (1 + r);

    if (changed && position[i] === 1) {
      openEntryIdx = i;
      openEntryEquity = equity[i - 1];
    } else if (changed && position[i] === 0 && openEntryIdx >= 0) {
      trades.push({
        entryDate: dates[openEntryIdx], exitDate: dates[i],
        entryPx: closes[openEntryIdx], exitPx: closes[i],
        // Measured on equity so the round-turn cost is inside the trade P&L.
        retPct: (equity[i] / openEntryEquity - 1) * 100,
        bars: i - openEntryIdx,
        open: false,
      });
      openEntryIdx = -1;
    }
  }
  if (openEntryIdx >= 0) {
    trades.push({
      entryDate: dates[openEntryIdx], exitDate: null,
      entryPx: closes[openEntryIdx], exitPx: null,
      retPct: (equity[n - 1] / openEntryEquity - 1) * 100,
      bars: n - 1 - openEntryIdx, open: true,
    });
  }

  const closed = trades.filter((t) => !t.open && t.retPct != null);
  const wins = closed.filter((t) => t.retPct! > 0);
  const losses = closed.filter((t) => t.retPct! <= 0);
  const grossWin = wins.reduce((a, t) => a + t.retPct!, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.retPct!, 0);

  const sd = stdev(daily);
  const downside = stdev(daily.filter((r) => r < 0));
  const years = yearsBetween(dates[0], dates[n - 1]);
  const ppy = inferBarsPerYear(n, years);
  const rootPpy = Math.sqrt(ppy);
  const final = equity[n - 1];
  const allRets = closed.map((t) => t.retPct!);

  const stats: Stats = {
    totalPct: (final - 1) * 100,
    buyHoldPct: (buyHold[n - 1] - 1) * 100,
    // Annualising a sub-year window turns noise into a headline number.
    cagrPct: years >= 0.75 && final > 0 ? (final ** (1 / years) - 1) * 100 : null,
    maxDdPct: maxDrawdown(equity),
    buyHoldMaxDdPct: maxDrawdown(buyHold),
    annVolPct: sd * rootPpy * 100,
    // Excess over a 0% risk-free rate — labelled as such in the UI.
    sharpe: sd > 0 ? (mean(daily) * ppy) / (sd * rootPpy) : null,
    sortino: downside > 0 ? (mean(daily) * ppy) / (downside * rootPpy) : null,
    trades: closed.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    avgWinPct: wins.length ? mean(wins.map((t) => t.retPct!)) : null,
    avgLossPct: losses.length ? mean(losses.map((t) => t.retPct!)) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    exposurePct: (position.reduce((a, b) => a + b, 0) / n) * 100,
    bestTradePct: allRets.length ? Math.max(...allRets) : null,
    worstTradePct: allRets.length ? Math.min(...allRets) : null,
    years,
    barsPerYear: ppy,
  };

  return { dates, equity, buyHold, position, trades, stats };
}

// ── parameter sweep ────────────────────────────────────────────────────────
// Shown deliberately: seeing how wide the spread of outcomes is across
// neighbouring parameters is the fastest way to understand that the single
// best cell is a fit to this window, not an edge.

export type SweepCell = { a: number; b: number; totalPct: number; trades: number };

export function sweep(
  bars: Bar[], strategy: StrategyId, keyA: string, valuesA: number[],
  keyB: string, valuesB: number[], base: Record<string, number>, costBps = 0,
): SweepCell[] {
  const out: SweepCell[] = [];
  for (const a of valuesA) {
    for (const b of valuesB) {
      const res = runBacktest(bars, {
        strategy, costBps, params: { ...base, [keyA]: a, [keyB]: b },
      });
      if (res) out.push({ a, b, totalPct: res.stats.totalPct, trades: res.stats.trades });
    }
  }
  return out;
}

/** Evenly spaced integer grid for a sweep axis, always including `centre`. */
export function gridAround(centre: number, step: number, count = 5): number[] {
  const half = Math.floor(count / 2);
  const out: number[] = [];
  for (let i = -half; i <= half; i++) {
    const v = Math.round(centre + i * step);
    if (v > 1 && !out.includes(v)) out.push(v);
  }
  return out;
}
