"""Options pricing and Greeks via the Black-Scholes model.

Implied volatility comes from the market (yfinance option chain); the Greeks
are computed here. Educational only - not trading advice. Yahoo's option-chain
coverage is US-centric, so this is most useful for US tickers.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import streamlit as st

from lib.market_data import make_ticker

_SQRT2 = math.sqrt(2.0)
_SQRT2PI = math.sqrt(2.0 * math.pi)
_erf = np.vectorize(math.erf)


def _ncdf(x):
    return 0.5 * (1.0 + _erf(np.asarray(x, dtype=float) / _SQRT2))


def _npdf(x):
    x = np.asarray(x, dtype=float)
    return np.exp(-0.5 * x * x) / _SQRT2PI


def black_scholes_greeks(S, K, T, r, sigma, kind="call", q=0.0) -> dict:
    """Return price and Greeks for a European option (arrays or scalars).

    S spot, K strike, T years to expiry, r risk-free (decimal), sigma IV
    (decimal), q dividend yield. Vega/Rho are per 1% move; Theta is per day.
    """
    S = np.asarray(S, dtype=float)
    K = np.asarray(K, dtype=float)
    T = np.maximum(np.asarray(T, dtype=float), 1e-9)
    sigma = np.maximum(np.asarray(sigma, dtype=float), 1e-9)

    sqrtT = np.sqrt(T)
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma ** 2) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    disc_r = np.exp(-r * T)
    disc_q = np.exp(-q * T)
    pdf = _npdf(d1)

    gamma = disc_q * pdf / (S * sigma * sqrtT)
    vega = S * disc_q * pdf * sqrtT / 100.0  # per 1% vol

    if kind == "call":
        price = S * disc_q * _ncdf(d1) - K * disc_r * _ncdf(d2)
        delta = disc_q * _ncdf(d1)
        theta = (-(S * disc_q * pdf * sigma) / (2 * sqrtT)
                 - r * K * disc_r * _ncdf(d2)
                 + q * S * disc_q * _ncdf(d1)) / 365.0
        rho = K * T * disc_r * _ncdf(d2) / 100.0
    else:
        price = K * disc_r * _ncdf(-d2) - S * disc_q * _ncdf(-d1)
        delta = -disc_q * _ncdf(-d1)
        theta = (-(S * disc_q * pdf * sigma) / (2 * sqrtT)
                 + r * K * disc_r * _ncdf(-d2)
                 - q * S * disc_q * _ncdf(-d1)) / 365.0
        rho = -K * T * disc_r * _ncdf(-d2) / 100.0

    return {"price": price, "delta": delta, "gamma": gamma,
            "theta": theta, "vega": vega, "rho": rho}


@st.cache_data(ttl=120, show_spinner=False)
def get_expiries(ticker: str) -> list[str]:
    try:
        return list(make_ticker(ticker).options or [])
    except Exception:
        return []


@st.cache_data(ttl=60, show_spinner=False)
def get_option_chain(ticker: str, expiry: str) -> dict:
    """Return {'calls': df, 'puts': df} for one expiry, or empty frames."""
    try:
        oc = make_ticker(ticker).option_chain(expiry)
        return {"calls": oc.calls.copy(), "puts": oc.puts.copy()}
    except Exception:
        return {"calls": pd.DataFrame(), "puts": pd.DataFrame()}


def years_to_expiry(expiry: str) -> float:
    try:
        exp = datetime.strptime(expiry, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        days = (exp - datetime.now(timezone.utc)).total_seconds() / 86400.0
        return max(days, 0.0) / 365.0
    except Exception:
        return 0.0


def _bs_price_scalar(S: float, K: float, T: float, r: float, sigma: float,
                     kind: str, q: float = 0.0) -> float:
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    ncdf = lambda x: 0.5 * (1.0 + math.erf(x / _SQRT2))  # noqa: E731
    if kind == "call":
        return S * math.exp(-q * T) * ncdf(d1) - K * math.exp(-r * T) * ncdf(d2)
    return K * math.exp(-r * T) * ncdf(-d2) - S * math.exp(-q * T) * ncdf(-d1)


def implied_vol_from_price(price: float, S: float, K: float, T: float,
                           r: float, kind: str) -> float | None:
    """Solve Black-Scholes IV from an observed option price by bisection.
    Returns None when the price is outside no-arbitrage bounds (stale/junk
    quotes) or the inputs are unusable."""
    if not all(map(math.isfinite, (price, S, K, T, r))) or price <= 0 \
            or S <= 0 or K <= 0 or T <= 0:
        return None
    intrinsic = max(S - K * math.exp(-r * T), 0.0) if kind == "call" \
        else max(K * math.exp(-r * T) - S, 0.0)
    if price <= intrinsic + 1e-9 or price >= (S if kind == "call" else K):
        return None
    lo, hi = 1e-4, 5.0
    if _bs_price_scalar(S, K, T, r, hi, kind) < price:
        return None
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _bs_price_scalar(S, K, T, r, mid, kind) < price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# Yahoo ships impliedVolatility ≈ 1e-5 (a placeholder) or NaN on stale rows;
# anything under 0.5% or over 500% is treated as "no market IV".
_IV_MIN, _IV_MAX = 0.005, 5.0


def _usable_iv(row: pd.Series, S: float, T: float, r: float, kind: str) -> float:
    """Market IV when sane; otherwise solve from the mid (or last) price.
    NaN when nothing usable exists — honest '—' beats a fake 0.00/1.000."""
    iv = row.get("impliedVolatility")
    if iv is not None and math.isfinite(float(iv or float("nan"))) \
            and _IV_MIN <= float(iv) <= _IV_MAX:
        return float(iv)
    bid = float(row.get("bid") or 0)
    ask = float(row.get("ask") or 0)
    price = (bid + ask) / 2 if (bid > 0 and ask > 0) \
        else float(row.get("lastPrice") or 0)
    solved = implied_vol_from_price(price, S, float(row["strike"]), T, r, kind)
    return solved if solved is not None else float("nan")


def enrich_with_greeks(df: pd.DataFrame, S: float, T: float, r: float,
                       kind: str) -> pd.DataFrame:
    """Add Black-Scholes Greeks columns to an option-chain frame.

    The old implementation filled missing IV with 0 (clamped to 1e-9), which
    degenerated delta into a 0/1 step function — every call showed Δ=1.000
    and IV=0.00 whenever Yahoo's chain was stale. Missing IV is now solved
    from market prices, and rows with no usable price get NaN Greeks (the UI
    renders them as '—')."""
    if df is None or df.empty or "strike" not in df:
        return df
    out = df.copy()
    if "impliedVolatility" not in out:
        out["impliedVolatility"] = float("nan")
    iv = out.apply(lambda row: _usable_iv(row, S, T, r, kind), axis=1)
    out["impliedVolatility"] = iv  # UI shows the IV the Greeks actually used
    g = black_scholes_greeks(S, out["strike"].values, T, r, iv.values, kind=kind)
    valid = np.isfinite(iv.values)
    for k in ("delta", "gamma", "theta", "vega", "rho"):
        out[k] = np.where(valid, g[k], np.nan)
    out["bs_price"] = np.where(valid, g["price"], np.nan)
    return out


def max_pain(calls: pd.DataFrame, puts: pd.DataFrame) -> float | None:
    """Strike that minimizes total in-the-money payout to option holders."""
    if calls is None or puts is None or calls.empty or puts.empty:
        return None
    strikes = sorted(set(calls["strike"]).union(set(puts["strike"])))
    if not strikes:
        return None
    c = calls.set_index("strike")["openInterest"].fillna(0)
    p = puts.set_index("strike")["openInterest"].fillna(0)
    c_strk, c_oi = c.index.to_numpy(dtype=float), c.to_numpy(dtype=float)
    p_strk, p_oi = p.index.to_numpy(dtype=float), p.to_numpy(dtype=float)
    best_strike, best_pain = None, None
    for s in strikes:
        call_pain = float((np.maximum(s - c_strk, 0.0) * c_oi).sum())
        put_pain = float((np.maximum(p_strk - s, 0.0) * p_oi).sum())
        total = call_pain + put_pain
        if best_pain is None or total < best_pain:
            best_pain, best_strike = total, s
    return best_strike
