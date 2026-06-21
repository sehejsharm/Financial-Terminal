"""NSE bulk / block deal feeds (end-of-day).

Honest scope: a genuine real-time bulk/block/mutual-fund order feed needs a
paid market-data subscription. NSE/BSE only publish these end-of-day, and not
via a clean public API. This pulls NSE's daily archive CSVs on a best-effort
basis (it can fail if NSE blocks programmatic access), and is therefore EOD,
not real-time.
"""
from __future__ import annotations

from io import StringIO

import pandas as pd
import requests
import streamlit as st

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "text/csv,*/*",
    "Referer": "https://www.nseindia.com/",
}
_BULK_URL = "https://nsearchives.nseindia.com/content/equities/bulk.csv"
_BLOCK_URL = "https://nsearchives.nseindia.com/content/equities/block.csv"


def _fetch_csv(url: str) -> pd.DataFrame:
    """Fetch an NSE archive CSV. NSE blocks bare datacenter requests, so we use
    the same curl_cffi Chrome impersonation + warmed homepage cookie as lib.nse
    (falls back to plain requests if curl_cffi is unavailable)."""
    text = None
    try:
        from curl_cffi import requests as cc
        s = cc.Session(impersonate="chrome120")
        s.get("https://www.nseindia.com", headers=_HEADERS, timeout=8)  # warm cookies
        r = s.get(url, headers=_HEADERS, timeout=12)
        if r.status_code == 200 and r.text:
            text = r.text
    except Exception:
        text = None
    if text is None:
        try:
            resp = requests.get(url, headers=_HEADERS, timeout=12)
            resp.raise_for_status()
            text = resp.text
        except Exception:
            return pd.DataFrame()
    try:
        df = pd.read_csv(StringIO(text))
        df.columns = [str(c).strip() for c in df.columns]
        return df
    except Exception:
        return pd.DataFrame()


@st.cache_data(ttl=900, show_spinner=False)
def get_bulk_deals() -> pd.DataFrame:
    return _fetch_csv(_BULK_URL)


@st.cache_data(ttl=900, show_spinner=False)
def get_block_deals() -> pd.DataFrame:
    return _fetch_csv(_BLOCK_URL)
