"""Long/flat strategy backtesting on daily price history.

Educational only: these are mechanical rule simulations on past data, not
trading advice and not predictive of future results.

Three things were wrong with the previous version, and all three flattered the
strategy.

It charged NOTHING to trade. Zero commission, zero slippage, zero spread — so
a rule that flips position forty times a year looked identical to one that
trades twice, and every result was better than anything achievable. Costs are
now charged on every position change and are the first input on the screen.

It reported a "win rate" that was the share of winning DAYS, not winning
trades. A trend strategy has more losing days than winning ones and still
makes money; a reader comparing that number to a strategy's hit rate is
comparing two different quantities with the same name.

And it counted every position CHANGE as a trade, so one round trip — buy,
then sell — was reported as two. Halving a trade count halves the costs a
reader imagines and doubles the average trade they infer.

What is added beyond fixing those: time in market (a strategy that is flat
80% of the time carries very different risk from one always invested), a
per-trade log with the real distribution, and a parameter sweep — because a
single backtest of tuned parameters is a curve fit, and the only honest way to
show that is to run the neighbours and let the reader see whether the result
survives.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from lib.signals import rsi

TRADING_DAYS = 252

# What a round trip actually costs a retail account: brokerage, exchange fees,
# STT/stamp duty and the half-spread you cross on each side. Charged per
# position CHANGE, so a round trip pays it twice.
DEFAULT_COST_BPS = 15.0


def _positions(close: pd.Series, strategy: str, params: dict) -> pd.Series | None:
    """Target exposure per bar: 1 long, 0 flat. None for an unknown strategy."""
    if strategy == "sma_cross":
        fast = int(params.get("fast", 50))
        slow = int(params.get("slow", 200))
        if fast >= slow or fast < 2:
            return None
        f = close.rolling(fast).mean()
        s = close.rolling(slow).mean()
        # NaN while either average is still filling: flat, not long. Treating
        # an unformed average as a signal front-runs the strategy's own start.
        return (f > s).astype(float).where(s.notna(), 0.0)

    if strategy == "rsi":
        low = float(params.get("low", 30))
        high = float(params.get("high", 70))
        if low >= high:
            return None
        r = rsi(close, int(params.get("period", 14)))
        sig = pd.Series(np.nan, index=close.index)
        sig[r < low] = 1.0
        sig[r > high] = 0.0
        return sig.ffill().fillna(0.0)

    if strategy == "breakout":
        window = int(params.get("window", 55))
        exit_w = int(params.get("exit", 20))
        if window < 5 or exit_w < 2:
            return None
        hi = close.rolling(window).max()
        lo = close.rolling(exit_w).min()
        sig = pd.Series(np.nan, index=close.index)
        # A new high enters; a low of the shorter window exits. Compared
        # against the PREVIOUS bar's extreme, or the bar that sets the high is
        # also the bar that triggers on it, which is lookahead.
        sig[close >= hi.shift(1)] = 1.0
        sig[close <= lo.shift(1)] = 0.0
        return sig.ffill().fillna(0.0)

    return None


def extract_trades(position: pd.Series, close: pd.Series) -> list[dict]:
    """Every completed round trip, with its own return.

    A trade is an entry and its matching exit, not each side counted
    separately. An open position at the end of the series is deliberately
    excluded: an unrealised winner counted as a completed trade inflates both
    the hit rate and the average.
    """
    trades: list[dict] = []
    entry_i: int | None = None
    prev = 0.0
    for i, p in enumerate(position.to_numpy()):
        if p > 0 and prev <= 0:
            entry_i = i
        elif p <= 0 and prev > 0 and entry_i is not None:
            e, x = float(close.iloc[entry_i]), float(close.iloc[i])
            if e > 0:
                trades.append({
                    "entry_date": str(close.index[entry_i])[:10],
                    "exit_date": str(close.index[i])[:10],
                    "entry": round(e, 2),
                    "exit": round(x, 2),
                    "return_pct": round((x / e - 1.0) * 100, 2),
                    "bars": i - entry_i,
                })
            entry_i = None
        prev = p
    return trades


def _trade_stats(trades: list[dict]) -> dict:
    """The distribution of outcomes, which an average alone hides."""
    if not trades:
        return {"trades": 0, "win_rate_pct": None, "avg_trade_pct": None,
                "best_trade_pct": None, "worst_trade_pct": None,
                "avg_bars_held": None, "profit_factor": None}
    rets = [t["return_pct"] for t in trades]
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    return {
        "trades": len(trades),
        # Winning TRADES, not winning days. The two differ a lot for a trend
        # strategy and the old label described the wrong one.
        "win_rate_pct": round(len(wins) / len(rets) * 100, 1),
        "avg_trade_pct": round(sum(rets) / len(rets), 2),
        "best_trade_pct": round(max(rets), 2),
        "worst_trade_pct": round(min(rets), 2),
        "avg_bars_held": round(sum(t["bars"] for t in trades) / len(trades), 1),
        # Gross win over gross loss. Below 1 the strategy loses money however
        # good the hit rate looks.
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
    }


def _curve_stats(equity: pd.Series, strat_ret: pd.Series,
                 position: pd.Series, bh_equity: pd.Series,
                 rf_pct: float = 0.0) -> dict:
    if equity.empty:
        return {}
    final = float(equity.iloc[-1])
    years = max(len(equity) / TRADING_DAYS, 1e-9)
    # A negative or zero final equity has no CAGR — a fractional power of a
    # negative number is complex, and 0 would print as "-100% a year forever".
    cagr = (final ** (1 / years) - 1.0) * 100 if final > 0 else None
    dd = float((equity / equity.cummax() - 1.0).min() * 100)
    sd = float(strat_ret.std())
    ann_vol = sd * np.sqrt(TRADING_DAYS) * 100
    ann_ret = float(strat_ret.mean()) * TRADING_DAYS * 100
    # Excess over the risk-free rate: a 6% return in a 7% rate environment is
    # not a positive Sharpe, and assuming rf=0 quietly claims it is.
    sharpe = ((ann_ret - rf_pct) / ann_vol) if ann_vol > 0 else None
    exposure = float((position > 0).mean() * 100)

    bh_final = float(bh_equity.iloc[-1])
    bh_dd = float((bh_equity / bh_equity.cummax() - 1.0).min() * 100)
    return {
        "total_return_pct": round((final - 1.0) * 100, 1),
        "buy_hold_pct": round((bh_final - 1.0) * 100, 1),
        "buy_hold_max_drawdown_pct": round(bh_dd, 1),
        "cagr_pct": round(cagr, 1) if cagr is not None else None,
        "max_drawdown_pct": round(dd, 1),
        "ann_vol_pct": round(ann_vol, 1),
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        # Share of bars actually holding the position. A strategy flat 80% of
        # the time carries very different risk from one always invested, and
        # a return figure alone cannot tell them apart.
        "exposure_pct": round(exposure, 1),
        "bars": int(len(equity)),
    }


def run_backtest(df: pd.DataFrame, strategy: str, params: dict) -> dict:
    """Run a strategy and return the curve, markers, trades and statistics.

    Signals are acted on the NEXT bar (positions shifted by one), and every
    position change is charged `cost_bps`. Without costs a rule that flips
    forty times a year looks identical to one that trades twice.
    """
    if df is None or df.empty or "Close" not in df:
        return {}
    close = df["Close"].dropna().astype(float)
    if len(close) < 60:
        return {}

    signal = _positions(close, strategy, params or {})
    if signal is None:
        return {}

    # Acting on the same bar that produced the signal is lookahead: the close
    # that triggers a cross is not tradeable until the next session.
    position = signal.shift(1).fillna(0.0)
    rets = close.pct_change().fillna(0.0)

    cost_bps = float((params or {}).get("cost_bps", DEFAULT_COST_BPS))
    turnover = position.diff().abs().fillna(position.abs())
    costs = turnover * (cost_bps / 10_000.0)

    gross_ret = position * rets
    strat_ret = gross_ret - costs
    equity = (1.0 + strat_ret).cumprod()
    bh_equity = (1.0 + rets).cumprod()

    change = position.diff().fillna(position)
    trades = extract_trades(position, close)

    rf_pct = float((params or {}).get("risk_free_pct", 0.0))
    stats = {
        **_curve_stats(equity, strat_ret, position, bh_equity, rf_pct),
        **_trade_stats(trades),
        "cost_bps": cost_bps,
        # What the costs took out, in percentage points of final equity. The
        # number a reader most needs when a strategy trades often.
        "cost_drag_pct": round(float(costs.sum()) * 100, 2),
    }

    return {
        "equity": equity,
        "buy_hold": bh_equity,
        "close": close,
        "entries": close[change > 0],
        "exits": close[change < 0],
        "trades": trades,
        "stats": stats,
    }


# ── does the result survive its own neighbourhood ────────────────────────

SWEEPS: dict[str, dict[str, list]] = {
    "sma_cross": {"fast": [10, 20, 50, 100], "slow": [100, 150, 200, 250]},
    "rsi": {"low": [20, 25, 30, 35], "high": [65, 70, 75, 80]},
    "breakout": {"window": [20, 34, 55, 89], "exit": [10, 13, 20, 34]},
}


def parameter_sweep(df: pd.DataFrame, strategy: str, params: dict) -> dict:
    """The same strategy across a grid of neighbouring parameters.

    A single backtest of tuned parameters is a curve fit, and nothing in one
    equity curve reveals that. Running the neighbours does: a rule that works
    only at 50/200 and nowhere near it has found an artefact of this price
    history, while one that works across the grid has found something with at
    least a chance of being real.

    Returns the grid plus the share of combinations that beat buy-and-hold —
    the one number that says whether the headline result was luck.
    """
    spec = SWEEPS.get(strategy)
    if not spec:
        return {}
    keys = list(spec.keys())
    rows_key, cols_key = keys[0], keys[1]

    grid: list[list[float | None]] = []
    beat = 0
    total = 0
    bh: float | None = None
    for rv in spec[rows_key]:
        row: list[float | None] = []
        for cv in spec[cols_key]:
            res = run_backtest(df, strategy, {**(params or {}),
                                              rows_key: rv, cols_key: cv})
            s = res.get("stats") or {}
            val = s.get("total_return_pct")
            row.append(val)
            if val is not None:
                total += 1
                bh = s.get("buy_hold_pct") if bh is None else bh
                if bh is not None and val > bh:
                    beat += 1
        grid.append(row)

    vals = [v for row in grid for v in row if v is not None]
    return {
        "row_key": rows_key, "col_key": cols_key,
        "rows": spec[rows_key], "cols": spec[cols_key],
        "grid": grid,
        "buy_hold_pct": bh,
        "beat_buy_hold": beat,
        "combinations": total,
        "best_pct": round(max(vals), 1) if vals else None,
        "worst_pct": round(min(vals), 1) if vals else None,
        "median_pct": round(float(np.median(vals)), 1) if vals else None,
    }
