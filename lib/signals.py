"""Technical and fundamental scoring.

IMPORTANT (compliance): these scores are descriptive quality/strength
measures, NOT buy/sell signals. The UI must never frame them as
recommendations. Language stays neutral and factual.
"""
from __future__ import annotations

import pandas as pd


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def rsi(close: pd.Series, window: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(window).mean()
    loss = (-delta.clip(upper=0)).rolling(window).mean()
    rs = gain / loss.replace(0, pd.NA)
    return 100 - (100 / (1 + rs))


def _tier(value, thresholds, labels):
    """Map a value to a label given ascending thresholds."""
    if value is None:
        return "—"
    for t, lab in zip(thresholds, labels):
        if value < t:
            return lab
    return labels[-1]


def compute_technical_score(history: pd.DataFrame, fundamentals: dict | None = None):
    """Return (score 0-100, drivers list, details dict).

    Built from trend (vs 200/50DMA), momentum (RSI), price position in the
    52-week range, and medium-term return. Purely descriptive of price action.
    """
    drivers: list[str] = []
    details: dict = {}
    if history is None or history.empty or "Close" not in history:
        return 50.0, ["Not enough price history to score trend"], details

    close = history["Close"].dropna().astype(float)
    if len(close) < 20:
        return 50.0, ["Not enough price history to score trend"], details

    last = float(close.iloc[-1])
    dma200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
    dma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
    rsi_val = float(rsi(close).iloc[-1]) if len(close) >= 15 else None
    hi = float(close.max())
    lo = float(close.min())
    rng_pos = (last - lo) / (hi - lo) * 100 if hi > lo else 50.0
    ret_3m = (last / float(close.iloc[-63]) - 1) * 100 if len(close) >= 63 else None

    details = {
        "last": last, "dma200": dma200, "dma50": dma50, "rsi": rsi_val,
        "range_pos": rng_pos, "ret_3m": ret_3m, "high_52w": hi, "low_52w": lo,
    }

    sub: list[float] = []

    # Trend vs 200DMA (weight via repetition in average).
    if dma200:
        above = (last / dma200 - 1) * 100
        sub.append(_clamp(50 + above * 2.5))
        if last >= dma200:
            drivers.append(f"Price above 200-day average ({above:+.1f}%)")
        else:
            drivers.append(f"Price below 200-day average ({above:+.1f}%)")

    # Trend vs 50DMA.
    if dma50:
        above50 = (last / dma50 - 1) * 100
        sub.append(_clamp(50 + above50 * 3.0))
        drivers.append(
            f"Price {'above' if last >= dma50 else 'below'} 50-day average ({above50:+.1f}%)"
        )

    # 50 vs 200 cross.
    if dma50 and dma200:
        if dma50 >= dma200:
            sub.append(70)
            drivers.append("50-day average above 200-day average")
        else:
            sub.append(35)
            drivers.append("50-day average below 200-day average")

    # Momentum (RSI). Mid-high RSI scores higher; extremes are noted.
    if rsi_val is not None:
        sub.append(_clamp(rsi_val))
        bucket = _tier(rsi_val, [30, 45, 55, 70],
                       ["Weak", "Soft", "Steady", "Firm", "Very firm"])
        drivers.append(f"RSI {rsi_val:.0f} ({bucket} momentum)")

    # 52-week range position.
    sub.append(_clamp(rng_pos))
    drivers.append(f"At {rng_pos:.0f}% of the 52-week range")

    # 3-month return.
    if ret_3m is not None:
        sub.append(_clamp(50 + ret_3m * 1.5))
        drivers.append(f"3-month return {ret_3m:+.1f}%")

    score = round(sum(sub) / len(sub), 0) if sub else 50.0
    return score, drivers, details


def compute_fundamental_score(f: dict | None):
    """Return (score 0-100, drivers list, details dict) from fundamentals."""
    drivers: list[str] = []
    if not f:
        return 50.0, ["Fundamental data unavailable"], {}

    sub: list[float] = []

    roe = f.get("roe")
    if roe is not None:
        sub.append(_clamp(roe * 100 * 3))  # 33% ROE -> ~100
        drivers.append(f"ROE {roe * 100:.1f}%")

    pm = f.get("profit_margin")
    if pm is not None:
        sub.append(_clamp(pm * 100 * 4))  # 25% margin -> 100
        drivers.append(f"Net margin {pm * 100:.1f}%")

    om = f.get("operating_margin")
    if om is not None:
        sub.append(_clamp(om * 100 * 3.5))
        drivers.append(f"Operating margin {om * 100:.1f}%")

    rg = f.get("revenue_growth")
    if rg is not None:
        sub.append(_clamp(50 + rg * 100 * 2.5))
        drivers.append(f"Revenue growth {rg * 100:+.1f}%")

    eg = f.get("earnings_growth")
    if eg is not None:
        sub.append(_clamp(50 + eg * 100 * 2.0))
        drivers.append(f"Earnings growth {eg * 100:+.1f}%")

    de = f.get("debt_to_equity")
    if de is not None:
        # Lower leverage scores higher. D/E is reported as a percentage.
        sub.append(_clamp(100 - de / 2))
        drivers.append(f"Debt/Equity {de:.0f}")

    cr = f.get("current_ratio")
    if cr is not None:
        sub.append(_clamp(cr * 40))  # 2.5x -> 100
        drivers.append(f"Current ratio {cr:.2f}")

    score = round(sum(sub) / len(sub), 0) if sub else 50.0
    return score, drivers, {}


def at_a_glance(history: pd.DataFrame, f: dict | None) -> list[dict]:
    """Return descriptive, neutral-language chips for the At a glance card.

    Each item: {label, value, tone} where tone in
    {positive, neutral, caution} for coloring only (not a recommendation).
    """
    chips: list[dict] = []
    f = f or {}

    close = (
        history["Close"].dropna().astype(float)
        if history is not None and not history.empty and "Close" in history
        else pd.Series(dtype=float)
    )
    last = float(close.iloc[-1]) if len(close) else None

    # Trend vs 200DMA.
    if len(close) >= 200:
        dma200 = float(close.rolling(200).mean().iloc[-1])
        if last >= dma200:
            chips.append({"label": "Trend", "value": "Above 200-day average",
                          "tone": "positive"})
        else:
            chips.append({"label": "Trend", "value": "Below 200-day average",
                          "tone": "caution"})
    else:
        chips.append({"label": "Trend", "value": "Insufficient history",
                      "tone": "neutral"})

    # Momentum (RSI bucket).
    if len(close) >= 15:
        r = float(rsi(close).iloc[-1])
        if r >= 70:
            chips.append({"label": "Momentum", "value": "Strong (RSI 70+)",
                          "tone": "neutral"})
        elif r >= 55:
            chips.append({"label": "Momentum", "value": "Firm momentum",
                          "tone": "positive"})
        elif r >= 45:
            chips.append({"label": "Momentum", "value": "Steady",
                          "tone": "neutral"})
        elif r >= 30:
            chips.append({"label": "Momentum", "value": "Soft",
                          "tone": "caution"})
        else:
            chips.append({"label": "Momentum", "value": "Weak (RSI under 30)",
                          "tone": "caution"})

    # 52-week range position.
    if len(close):
        hi, lo = float(close.max()), float(close.min())
        pos = (last - lo) / (hi - lo) * 100 if hi > lo else 50
        bucket = _tier(pos, [25, 45, 70, 90],
                       ["Near 52-week low", "Lower half", "Mid-range",
                        "Upper half", "Near 52-week high"])
        chips.append({"label": "52-week range", "value": f"{bucket} ({pos:.0f}%)",
                      "tone": "neutral"})

    # Profitability (ROE tier).
    roe = f.get("roe")
    if roe is not None:
        pct = roe * 100
        bucket = _tier(pct, [5, 15, 25], ["Low", "Moderate", "Strong", "High"])
        tone = "positive" if pct >= 15 else "neutral" if pct >= 5 else "caution"
        chips.append({"label": "Profitability", "value": f"{bucket} ROE ({pct:.0f}%)",
                      "tone": tone})

    # Leverage (D/E tier).
    de = f.get("debt_to_equity")
    if de is not None:
        bucket = _tier(de, [50, 100, 200], ["Low", "Moderate", "Elevated", "High"])
        tone = "positive" if de < 50 else "neutral" if de < 150 else "caution"
        chips.append({"label": "Leverage", "value": f"{bucket} debt ({de:.0f} D/E)",
                      "tone": tone})

    # Volatility (beta vs market).
    beta = f.get("beta")
    if beta is not None:
        if beta < 0.8:
            chips.append({"label": "Volatility", "value": f"Lower than market (β {beta:.2f})",
                          "tone": "neutral"})
        elif beta <= 1.2:
            chips.append({"label": "Volatility", "value": f"In line with market (β {beta:.2f})",
                          "tone": "neutral"})
        else:
            chips.append({"label": "Volatility", "value": f"Higher than market (β {beta:.2f})",
                          "tone": "caution"})

    # Valuation (P/E tier).
    pe = f.get("trailing_pe")
    if pe is not None and pe > 0:
        bucket = _tier(pe, [15, 25, 40], ["Low multiple", "Moderate multiple",
                                          "High multiple", "Very high multiple"])
        chips.append({"label": "Valuation", "value": f"{bucket} (P/E {pe:.1f})",
                      "tone": "neutral"})

    return chips
