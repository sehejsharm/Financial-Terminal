"""FRED macro indicator helpers.

Outage note: this module previously used `fredapi`, whose get_series() calls
urllib with NO timeout. A stalled FRED connection would hang a request thread
forever; the macro page fires ~19 of these in parallel, which exhausted the
whole FastAPI threadpool and took down every endpoint (incl. /healthz and
login) on the single-worker VM. We now call FRED's REST API directly with
requests + hard connect/read timeouts.
"""
from __future__ import annotations

import time

import pandas as pd
import requests
import streamlit as st

from lib.config import get_fred_key

# Display name -> {"ids": [FRED series ids, tried in order], unit, kind}.
# kind: "level" | "yoy" (year-over-year % change).
#
# Several OECD "Main Economic Indicators" series FRED used to carry (the
# *MEI / *IXOB / IRSTCI / IRLTLT families) stopped updating when OECD
# retired MEI in 2024 — that's why non-US tabs went blank or froze (India's
# repo-rate proxy last printed 2022). Each indicator now lists candidate
# series tried in order, and every response carries as_of + a stale flag so
# old data is BADGED, never silently presented as current.
INDICATORS: dict[str, dict] = {
    "Real GDP (QoQ SAAR)": {"ids": ["A191RL1Q225SBEA"], "unit": "%", "kind": "level"},
    "Unemployment rate": {"ids": ["UNRATE"], "unit": "%", "kind": "level"},
    "CPI (YoY)": {"ids": ["CPIAUCSL"], "unit": "%", "kind": "yoy"},
    "Core CPI (YoY)": {"ids": ["CPILFESL"], "unit": "%", "kind": "yoy"},
    "Fed funds rate": {"ids": ["FEDFUNDS"], "unit": "%", "kind": "level"},
    "10Y-2Y spread": {"ids": ["T10Y2Y"], "unit": "%", "kind": "level"},
    "Retail sales (YoY)": {"ids": ["RSAFS"], "unit": "%", "kind": "yoy"},
    "Industrial production (YoY)": {"ids": ["INDPRO"], "unit": "%", "kind": "yoy"},
}

COUNTRY_INDICATORS: dict[str, dict[str, dict]] = {
    "US": INDICATORS,
    "IN": {
        "Real GDP growth": {"ids": ["NGDPRSAXDCINQ"], "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"ids": ["INDCPIALLMINMEI", "INDCPALTT01IXOBM",
                              "INDCPALTT01IXOBQ"], "unit": "%", "kind": "yoy"},
        "Industrial production (YoY)": {"ids": ["INDPROINDMISMEI",
                                                "INDPROINMISMEI"], "unit": "%", "kind": "yoy"},
        "Interbank / policy rate": {"ids": ["IRSTCI01INM156N",
                                            "INTDSRINM193N"], "unit": "%", "kind": "level"},
        "10Y govt yield": {"ids": ["IRLTLT01INM156N"], "unit": "%", "kind": "level"},
        "USD / INR": {"ids": ["DEXINUS"], "unit": "INR", "kind": "level"},
        "Unemployment rate": {"ids": ["LRUNTTTTINQ156S"], "unit": "%", "kind": "level"},
    },
    "EU": {
        "Real GDP growth": {"ids": ["CLVMNACSCAB1GQEA19"], "unit": "%", "kind": "yoy"},
        "HICP (YoY)": {"ids": ["CP0000EZ19M086NEST"], "unit": "%", "kind": "yoy"},
        "ECB deposit rate": {"ids": ["ECBDFR"], "unit": "%", "kind": "level"},
        "Unemployment rate": {"ids": ["LRHUTTTTEZM156S"], "unit": "%", "kind": "level"},
        "10Y bund yield": {"ids": ["IRLTLT01DEM156N"], "unit": "%", "kind": "level"},
        "Industrial production (YoY)": {"ids": ["EA19PRINTO01GYSAM",
                                                "EU28PRINTO01GYSAM"], "unit": "%", "kind": "yoy"},
        "EUR / USD": {"ids": ["DEXUSEU"], "unit": "USD", "kind": "level"},
    },
    "UK": {
        "Real GDP growth": {"ids": ["NGDPRSAXDCGBQ"], "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"ids": ["GBRCPIALLMINMEI", "CPALTT01GBM659N"], "unit": "%", "kind": "yoy"},
        "BoE bank rate / SONIA": {"ids": ["IUDSOIA", "BOERUKM"], "unit": "%", "kind": "level"},
        "Unemployment rate": {"ids": ["LRUN64TTGBM156S"], "unit": "%", "kind": "level"},
        "10Y gilt yield": {"ids": ["IRLTLT01GBM156N"], "unit": "%", "kind": "level"},
        "GBP / USD": {"ids": ["DEXUSUK"], "unit": "USD", "kind": "level"},
    },
    "JP": {
        "Real GDP growth": {"ids": ["JPNRGDPEXP"], "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"ids": ["JPNCPIALLMINMEI", "CPALTT01JPM659N"], "unit": "%", "kind": "yoy"},
        "BoJ policy rate": {"ids": ["IRSTCI01JPM156N"], "unit": "%", "kind": "level"},
        "Unemployment rate": {"ids": ["LRUNTTTTJPM156S"], "unit": "%", "kind": "level"},
        "10Y JGB yield": {"ids": ["IRLTLT01JPM156N"], "unit": "%", "kind": "level"},
        "USD / JPY": {"ids": ["DEXJPUS"], "unit": "JPY", "kind": "level"},
    },
    "CN": {
        "Real GDP growth": {"ids": ["MKTGDPCNA646NWDB"], "unit": "%", "kind": "yoy"},
        "CPI (YoY)": {"ids": ["CHNCPIALLMINMEI", "CPALTT01CNM659N"], "unit": "%", "kind": "yoy"},
        "Industrial production (YoY)": {"ids": ["CHNPROINDMISMEI"], "unit": "%", "kind": "yoy"},
        "USD / CNY": {"ids": ["DEXCHUS"], "unit": "CNY", "kind": "level"},
    },
}

# Staleness thresholds (days since last observation) by indicator flavor.
# Beyond these, the UI shows a STALE badge instead of presenting old data
# as current.
def _max_age_days(name: str, unit: str) -> int:
    n = name.lower()
    if "gdp" in n:
        return 200          # quarterly, long publication lag
    if "/" in name and unit != "%":
        return 10           # FX — daily series
    if "spread" in n or "rate" in n or "yield" in n or "sonia" in n:
        return 45
    return 75               # CPI / IP / retail / unemployment (monthly)

COUNTRIES = list(COUNTRY_INDICATORS.keys())


_FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"


@st.cache_data(ttl=3600, show_spinner=False)
def get_series(series_id: str, observations: int = 400) -> pd.Series:
    """Return a FRED series (most recent observations), or empty on failure.

    Direct REST call with (connect=5s, read=15s) timeouts — a slow upstream
    can never hang a worker thread. Retries transient failures with a short
    backoff before giving up.
    """
    key = get_fred_key()
    if not key:
        return pd.Series(dtype=float)
    for attempt in range(3):
        try:
            r = requests.get(_FRED_OBS_URL, params={
                "series_id": series_id, "api_key": key, "file_type": "json",
                "sort_order": "desc", "limit": observations,
            }, timeout=(5, 15))
            r.raise_for_status()
            obs = r.json().get("observations", [])
            idx, vals = [], []
            for o in reversed(obs):  # desc from API -> ascending series
                v = o.get("value")
                if v not in (None, "", "."):
                    idx.append(pd.Timestamp(o["date"]))
                    vals.append(float(v))
            return pd.Series(vals, index=idx)
        except Exception:
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
    return pd.Series(dtype=float)


@st.cache_data(ttl=3600, show_spinner=False)
def get_indicator(name: str, country: str = "US") -> dict:
    """Return {name, value, prior, change, date, unit, stale} for one
    indicator. Tries each candidate FRED series id in order."""
    cfg = COUNTRY_INDICATORS.get(country, INDICATORS).get(name)
    if not cfg:
        return {}
    empty = {"name": name, "value": None, "prior": None, "change": None,
             "date": None, "unit": cfg["unit"], "stale": False}

    ids = cfg.get("ids") or ([cfg["id"]] if cfg.get("id") else [])
    s = pd.Series(dtype=float)
    for sid in ids:
        s = get_series(sid)
        if not s.empty:
            break
    if s.empty:
        return empty

    if cfg["kind"] == "yoy":
        yoy = s.pct_change(12) * 100
        yoy = yoy.dropna()
        if yoy.empty:
            return empty
        value = float(yoy.iloc[-1])
        prior = float(yoy.iloc[-2]) if len(yoy) >= 2 else None
        date = yoy.index[-1]
    else:
        value = float(s.iloc[-1])
        prior = float(s.iloc[-2]) if len(s) >= 2 else None
        date = s.index[-1]

    change = (value - prior) if prior is not None else None
    ts = pd.Timestamp(date)
    age_days = (pd.Timestamp.now() - ts).days
    return {
        "name": name, "value": value, "prior": prior, "change": change,
        "date": ts.date().isoformat(), "unit": cfg["unit"],
        "stale": age_days > _max_age_days(name, cfg["unit"]),
    }


def _cadence_days(name: str, unit: str) -> int | None:
    """Typical release cadence; None for daily series (FX, spreads)."""
    n = name.lower()
    if "gdp" in n:
        return 91
    if "/" in name and unit != "%":
        return None        # FX — daily
    if "spread" in n:
        return None        # daily
    return 30              # monthly indicators


def get_calendar(country: str = "US") -> list[dict]:
    """Economic release calendar with a change-vs-prior 'surprise' proxy.

    Honest scope: true surprise indexes need CONSENSUS estimates, which no
    free API provides — 'surprise' here is actual vs prior print, labeled as
    such. Next-release dates are estimated from cadence, not an official
    schedule."""
    inds = COUNTRY_INDICATORS.get(country, INDICATORS)
    rows = []
    for name, cfg in inds.items():
        cadence = _cadence_days(name, cfg["unit"])
        if cadence is None:
            continue  # daily series don't belong on a release calendar
        ind = get_indicator(name, country)
        next_est = None
        if ind.get("date"):
            try:
                next_est = (pd.Timestamp(ind["date"])
                            + pd.Timedelta(days=cadence)).date().isoformat()
            except Exception:
                next_est = None
        rows.append({
            "name": name, "unit": cfg["unit"],
            "last_value": ind.get("value"), "prior": ind.get("prior"),
            "surprise_vs_prior": ind.get("change"),
            "last_release": ind.get("date"), "stale": ind.get("stale", False),
            "next_release_est": next_est,
        })
    rows.sort(key=lambda r: (r["next_release_est"] is None,
                             r["next_release_est"] or ""))
    return rows


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
