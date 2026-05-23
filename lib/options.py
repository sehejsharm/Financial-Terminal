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


def enrich_with_greeks(df: pd.DataFrame, S: float, T: float, r: float,
                       kind: str) -> pd.DataFrame:
    """Add Black-Scholes Greeks columns to an option-chain frame."""
    if df is None or df.empty or "strike" not in df:
        return df
    out = df.copy()
    iv = out.get("impliedVolatility")
    if iv is None:
        return out
    g = black_scholes_greeks(S, out["strike"].values, T, r,
                             iv.fillna(0).values, kind=kind)
    for k in ("delta", "gamma", "theta", "vega", "rho"):
        out[k] = g[k]
    out["bs_price"] = g["price"]
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
