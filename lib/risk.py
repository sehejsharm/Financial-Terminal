"""Risk scoring for ETFs and portfolios.

Score is 0-100 where higher means more risk/aggressiveness. Built from
annualized volatility, maximum drawdown, and (where available) holdings
concentration. Descriptive only, never a recommendation.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

RISK_BANDS = [
    (20, "Conservative", "#22c55e"),
    (40, "Moderate", "#84cc16"),
    (60, "Balanced", "#eab308"),
    (80, "Aggressive", "#f97316"),
    (101, "Very aggressive", "#ef4444"),
]


def risk_label(score: float) -> tuple[str, str]:
    for threshold, label, color in RISK_BANDS:
        if score < threshold:
            return label, color
    return RISK_BANDS[-1][1], RISK_BANDS[-1][2]


def _annualized_vol(close: pd.Series, periods_per_year: int = 252) -> float | None:
    rets = close.pct_change().dropna()
    if len(rets) < 5:
        return None
    return float(rets.std() * np.sqrt(periods_per_year) * 100)


def _max_drawdown(close: pd.Series) -> float | None:
    if len(close) < 2:
        return None
    cummax = close.cummax()
    dd = (close / cummax - 1.0)
    return float(dd.min() * 100)  # negative number


def _concentration(holdings: list[dict] | None) -> float | None:
    """Sum of the top-10 holding weights as a percentage (0-100)."""
    if not holdings:
        return None
    weights = [h.get("weight") for h in holdings if h.get("weight") is not None]
    if not weights:
        return None
    # Weights from yfinance are fractions (0-1).
    return float(sum(weights[:10]) * 100)


def etf_risk_score(history: pd.DataFrame, holdings: list[dict] | None = None):
    """Return (score 0-100, label, color, components dict)."""
    components: dict = {}
    parts: list[float] = []

    if history is not None and not history.empty and "Close" in history:
        close = history["Close"].dropna().astype(float)
        vol = _annualized_vol(close)
        dd = _max_drawdown(close)
        if vol is not None:
            components["volatility_pct"] = round(vol, 1)
            # ~10% vol -> 25, ~40% vol -> 100.
            parts.append(min(100, vol / 40 * 100))
        if dd is not None:
            components["max_drawdown_pct"] = round(dd, 1)
            # -10% -> 20, -60% -> 100.
            parts.append(min(100, abs(dd) / 60 * 100))

    conc = _concentration(holdings)
    if conc is not None:
        components["top10_concentration_pct"] = round(conc, 1)
        # 20% top-10 -> low, 70%+ -> high.
        parts.append(min(100, max(0, (conc - 20) / 50 * 100)))

    score = round(sum(parts) / len(parts), 0) if parts else 50.0
    label, color = risk_label(score)
    return score, label, color, components
