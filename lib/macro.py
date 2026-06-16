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

# FRED tracks many international series too. These cover the biggies users
# ask about — IMF/World Bank could plug in for the rest later.
COUNTRY_INDICATORS: dict[str, dict[str, dict]] = {
    "US": INDICATORS,
    "IN": {
        "Real GDP growth": {"id": "NGDPRSAXDCINQ", "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"id": "INDCPALTT01IXOBQ", "unit": "%", "kind": "yoy"},
        "Industrial production (YoY)": {"id": "INDPROINMISMEI", "unit": "%", "kind": "yoy"},
        "Policy repo rate": {"id": "INTDSRINM193N", "unit": "%", "kind": "level"},
        "10Y govt yield": {"id": "IRLTLT01INM156N", "unit": "%", "kind": "level"},
        "USD / INR": {"id": "DEXINUS", "unit": "INR", "kind": "level"},
        "Unemployment rate": {"id": "LRUNTTTTINQ156S", "unit": "%", "kind": "level"},
    },
    "EU": {
        "Real GDP growth": {"id": "CLVMNACSCAB1GQEA19", "unit": "%", "kind": "yoy"},
        "HICP (YoY)": {"id": "CP0000EZ19M086NEST", "unit": "%", "kind": "yoy"},
        "ECB deposit rate": {"id": "ECBDFR", "unit": "%", "kind": "level"},
        "Unemployment rate": {"id": "LRHUTTTTEZM156S", "unit": "%", "kind": "level"},
        "10Y bund yield": {"id": "IRLTLT01DEM156N", "unit": "%", "kind": "level"},
        "Industrial production (YoY)": {"id": "EU28PRINTO01GYSAM", "unit": "%", "kind": "yoy"},
        "EUR / USD": {"id": "DEXUSEU", "unit": "USD", "kind": "level"},
    },
    "UK": {
        "Real GDP growth": {"id": "NGDPRSAXDCGBQ", "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"id": "GBRCPIALLMINMEI", "unit": "%", "kind": "yoy"},
        "BoE bank rate": {"id": "IUDSOIA", "unit": "%", "kind": "level"},
        "Unemployment rate": {"id": "LRUN64TTGBM156S", "unit": "%", "kind": "level"},
        "10Y gilt yield": {"id": "IRLTLT01GBM156N", "unit": "%", "kind": "level"},
        "GBP / USD": {"id": "DEXUSUK", "unit": "USD", "kind": "level"},
    },
    "JP": {
        "Real GDP growth": {"id": "JPNRGDPEXP", "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"id": "JPNCPIALLMINMEI", "unit": "%", "kind": "yoy"},
        "BoJ policy rate": {"id": "IRSTCI01JPM156N", "unit": "%", "kind": "level"},
        "Unemployment rate": {"id": "LRUNTTTTJPM156S", "unit": "%", "kind": "level"},
        "10Y JGB yield": {"id": "IRLTLT01JPM156N", "unit": "%", "kind": "level"},
        "USD / JPY": {"id": "DEXJPUS", "unit": "JPY", "kind": "level"},
    },
    "CN": {
        "Real GDP growth": {"id": "MKTGDPCNA646NWDB", "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"id": "CHNCPIALLMINMEI", "unit": "%", "kind": "yoy"},
        "Industrial production (YoY)": {"id": "CHNPROINDMISMEI", "unit": "%", "kind": "yoy"},
        "USD / CNY": {"id": "DEXCHUS", "unit": "CNY", "kind": "level"},
    },
}

COUNTRIES = list(COUNTRY_INDICATORS.keys())


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
def get_indicator(name: str, country: str = "US") -> dict:
    """Return {name, value, prior, change, date, unit} for one indicator."""
    cfg = COUNTRY_INDICATORS.get(country, INDICATORS).get(name)
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


def get_dashboard(country: str = "US") -> list[dict]:
    """Return all configured indicators for the given country as a list of dicts.

    Parallelised — FRED is the slowest dep here; pulling 7 series serially
    means a multi-second page load.
    """
    from concurrent.futures import ThreadPoolExecutor
    inds = COUNTRY_INDICATORS.get(country, INDICATORS)
    names = list(inds.keys())
    with ThreadPoolExecutor(max_workers=min(8, len(names) or 1)) as pool:
        results = list(pool.map(lambda n: get_indicator(n, country), names))
    return results
