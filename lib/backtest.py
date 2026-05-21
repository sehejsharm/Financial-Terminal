"""Lightweight long/flat strategy backtester on daily price history.

Educational only: these are mechanical rule simulations on past data, not
trading advice and not predictive of future results.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from lib.signals import rsi


def _stats(equity: pd.Series, strat_ret: pd.Series, position: pd.Series,
           bh_equity: pd.Series) -> dict:
    if equity.empty:
        return {}
    total_ret = float(equity.iloc[-1] - 1.0) * 100
    years = max(len(equity) / 252.0, 1e-9)
    cagr = float(equity.iloc[-1] ** (1 / years) - 1.0) * 100
    dd = float((equity / equity.cummax() - 1.0).min() * 100)
    ann_vol = float(strat_ret.std() * np.sqrt(252) * 100)
    sharpe = float((strat_ret.mean() * 252) / (strat_ret.std() * np.sqrt(252))
                   ) if strat_ret.std() else 0.0
    trades = int((position.diff().abs() > 0).sum())
    win_days = float((strat_ret[strat_ret != 0] > 0).mean() * 100) if (
        (strat_ret != 0).any()) else 0.0
    return {
        "total_return_pct": round(total_ret, 1),
        "buy_hold_pct": round(float(bh_equity.iloc[-1] - 1.0) * 100, 1),
        "cagr_pct": round(cagr, 1),
        "max_drawdown_pct": round(dd, 1),
        "ann_vol_pct": round(ann_vol, 1),
        "sharpe": round(sharpe, 2),
        "trades": trades,
        "win_rate_pct": round(win_days, 1),
    }


def run_backtest(df: pd.DataFrame, strategy: str, params: dict) -> dict:
    """Run a strategy and return equity curve, signals, markers and stats.

    strategy: 'sma_cross' | 'rsi'. Positions are long (1) or flat (0), entered
    on the next bar's open-equivalent (signals shifted by one day).
    """
    if df is None or df.empty or "Close" not in df:
        return {}
    close = df["Close"].dropna().astype(float)
    if len(close) < 60:
        return {}

    if strategy == "sma_cross":
        fast = int(params.get("fast", 50))
        slow = int(params.get("slow", 200))
        f = close.rolling(fast).mean()
        s = close.rolling(slow).mean()
        signal = (f > s).astype(float)
    elif strategy == "rsi":
        low = float(params.get("low", 30))
        high = float(params.get("high", 70))
        r = rsi(close, int(params.get("period", 14)))
        # Long when oversold recovery; exit when overbought.
        signal = pd.Series(np.nan, index=close.index)
        signal[r < low] = 1.0
        signal[r > high] = 0.0
        signal = signal.ffill().fillna(0.0)
    else:
        return {}

    position = signal.shift(1).fillna(0.0)
    rets = close.pct_change().fillna(0.0)
    strat_ret = position * rets
    equity = (1.0 + strat_ret).cumprod()
    bh_equity = (1.0 + rets).cumprod()

    # Entry/exit markers.
    change = position.diff().fillna(position)
    entries = close[change > 0]
    exits = close[change < 0]

    return {
        "equity": equity,
        "buy_hold": bh_equity,
        "close": close,
        "entries": entries,
        "exits": exits,
        "stats": _stats(equity, strat_ret, position, bh_equity),
    }
