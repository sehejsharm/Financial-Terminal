"""FRED macro indicator helpers."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from lib.config import get_fred_key

# Display name -> (FRED series id, transform).
# transform: "level" | "yoy" (year-over-year % change) | "pct" (already a %).
INDICATORS: dict[str, dict] = {
    "Real GDP (QoQ SAAR)": {"id": "A191RL1Q225SBEA", "unit": "%", "kind": "level"},
    "Unemployment rate": {"id": "UNRATE", "unit": "%", "kind": "level"},
    "CPI (YoY)": {"id": "CPIAUCSL", "unit": "%", "kind": "yoy"},
    "Core CPI (YoY)": {"id": "CPILFESL", "unit": "%", "kind": "yoy"},
    "Fed funds rate": {"id": "FEDFUNDS", "unit": "%", "kind": "level"},
    "10Y-2Y spread": {"id": "T10Y2Y", "unit": "%", "kind": "level"},
    "Retail sales (YoY)": {"id": "RSAFS", "unit": "%", "kind": "yoy"},
    "Industrial production (YoY)": {"id": "INDPRO", "unit": "%", "kind": "yoy"},
}


@st.cache_resource(show_spinner=False)
def _fred():
    key = get_fred_key()
    if not key:
        return None
    try:
        from fredapi import Fred
        return Fred(api_key=key)
    except Exception:
        return None


@st.cache_data(ttl=3600, show_spinner=False)
def get_series(series_id: str, observations: int = 400) -> pd.Series:
    """Return a FRED series (most recent observations), or empty on failure.

    Retries transient FRED failures with a short backoff before giving up.
    """
    import time

    fred = _fred()
    if fred is None:
        return pd.Series(dtype=float)
    for attempt in range(3):
        try:
            s = fred.get_series(series_id)
            return s.dropna().tail(observations)
        except Exception:
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
    return pd.Series(dtype=float)


@st.cache_data(ttl=3600, show_spinner=False)
def get_indicator(name: str) -> dict:
    """Return {name, value, prior, change, date, unit} for one indicator."""
    cfg = INDICATORS.get(name)
    if not cfg:
        return {}
    s = get_series(cfg["id"])
    if s.empty:
        return {"name": name, "value": None, "prior": None, "change": None,
                "date": None, "unit": cfg["unit"]}

    if cfg["kind"] == "yoy":
        yoy = s.pct_change(12) * 100
        yoy = yoy.dropna()
        if yoy.empty:
            return {"name": name, "value": None, "prior": None, "change": None,
                    "date": None, "unit": cfg["unit"]}
        value = float(yoy.iloc[-1])
        prior = float(yoy.iloc[-2]) if len(yoy) >= 2 else None
        date = yoy.index[-1]
    else:
        value = float(s.iloc[-1])
        prior = float(s.iloc[-2]) if len(s) >= 2 else None
        date = s.index[-1]

    change = (value - prior) if prior is not None else None
    return {
        "name": name, "value": value, "prior": prior, "change": change,
        "date": pd.Timestamp(date).date().isoformat(), "unit": cfg["unit"],
    }


def get_dashboard() -> list[dict]:
    """Return all configured indicators as a list of dicts."""
    return [get_indicator(name) for name in INDICATORS]
