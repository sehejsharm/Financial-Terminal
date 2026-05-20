"""FRED Treasury yield-curve helpers."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from lib.macro import get_series

# Maturity label -> FRED daily Treasury constant-maturity series id.
CURVE_SERIES: dict[str, str] = {
    "1M": "DGS1MO",
    "3M": "DGS3MO",
    "6M": "DGS6MO",
    "1Y": "DGS1",
    "2Y": "DGS2",
    "3Y": "DGS3",
    "5Y": "DGS5",
    "7Y": "DGS7",
    "10Y": "DGS10",
    "20Y": "DGS20",
    "30Y": "DGS30",
}

# Approximate maturity in years for x-axis ordering.
MATURITY_YEARS = {
    "1M": 1 / 12, "3M": 0.25, "6M": 0.5, "1Y": 1, "2Y": 2, "3Y": 3,
    "5Y": 5, "7Y": 7, "10Y": 10, "20Y": 20, "30Y": 30,
}


@st.cache_data(ttl=3600, show_spinner=False)
def get_yield_curve() -> pd.DataFrame:
    """Return the latest Treasury yield curve.

    Columns: maturity, years, yield. Empty if FRED is unavailable.
    """
    rows: list[dict] = []
    for label, sid in CURVE_SERIES.items():
        s = get_series(sid, observations=10)
        if s.empty:
            continue
        rows.append({
            "maturity": label,
            "years": MATURITY_YEARS[label],
            "yield": float(s.iloc[-1]),
        })
    df = pd.DataFrame(rows)
    return df.sort_values("years").reset_index(drop=True) if not df.empty else df
