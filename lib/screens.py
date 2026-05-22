"""Fundamental stock screens over an Indian universe.

IMPORTANT - data caveats: free data (yfinance) does not expose 5- and 7-year
EPS/sales growth, promoter holding (only an insider-holding proxy), industry
P/E, or a clean ROCE for every name. So these screens are BEST-EFFORT
approximations: multi-year growth uses the latest trailing growth as a proxy,
ROCE falls back to ROCE-or-ROE where ROCE is missing, "promoter holding" uses
held-by-insiders, and the industry-P/E condition is skipped. Treat results as a
starting point for research, not a definitive screen.
"""
from __future__ import annotations

import streamlit as st

from lib.market_data import get_stock_fundamentals

# Broader universe (large + some mid caps) so smaller-cap screens can match.
SCREEN_UNIVERSE = [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS",
    "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
    "LT.NS", "BAJFINANCE.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS",
    "HCLTECH.NS", "SUNPHARMA.NS", "TITAN.NS", "ULTRACEMCO.NS", "WIPRO.NS",
    "NESTLEIND.NS", "ONGC.NS", "NTPC.NS", "POWERGRID.NS", "M&M.NS",
    "TATAMOTORS.NS", "TATASTEEL.NS", "JSWSTEEL.NS", "ADANIENT.NS", "COALINDIA.NS",
    "BAJAJFINSV.NS", "GRASIM.NS", "HINDALCO.NS", "BRITANNIA.NS", "CIPLA.NS",
    "DRREDDY.NS", "EICHERMOT.NS", "HEROMOTOCO.NS", "BPCL.NS", "TATACONSUM.NS",
    "APOLLOHOSP.NS", "INDUSINDBK.NS", "SBILIFE.NS", "HDFCLIFE.NS", "TECHM.NS",
    "TRENT.NS", "DIVISLAB.NS", "PIDILITIND.NS", "DABUR.NS", "MARICO.NS",
    "GODREJCP.NS", "BERGEPAINT.NS", "PAGEIND.NS", "MUTHOOTFIN.NS", "TVSMOTOR.NS",
    "BALKRISIND.NS", "ABBOTINDIA.NS", "COFORGE.NS", "PERSISTENT.NS", "MPHASIS.NS",
    "POLYCAB.NS", "ASTRAL.NS", "DEEPAKNTR.NS", "NAVINFLUOR.NS", "LALPATHLAB.NS",
    "AARTIIND.NS", "JUBLFOOD.NS", "RELAXO.NS", "VINATIORGA.NS", "CDSL.NS",
]

# Metrics available per the filter UI: (label, key, unit).
FILTER_METRICS = [
    ("Market cap (₹ cr)", "mcap_cr", "cr"),
    ("EPS growth (%)", "eps_growth", "%"),
    ("Sales growth (%)", "sales_growth", "%"),
    ("PEG ratio", "peg", ""),
    ("Debt / Equity", "de", ""),
    ("ROCE/ROE (%)", "roce", "%"),
    ("Promoter/insider holding (%)", "promoter", "%"),
    ("P/E", "pe", ""),
    ("ROE (%)", "roe", "%"),
]


@st.cache_data(ttl=3600, show_spinner=False)
def get_metrics(ticker: str) -> dict | None:
    """Best-effort metric set for one ticker (see module caveats)."""
    f = get_stock_fundamentals(ticker)
    if not f or f.get("market_cap") is None:
        return None
    mcap_cr = f["market_cap"] / 1e7  # INR -> crore
    eps_g = (f.get("earnings_growth") or 0) * 100 if f.get("earnings_growth") is not None else None
    sales_g = (f.get("revenue_growth") or 0) * 100 if f.get("revenue_growth") is not None else None
    roce = f.get("roce")
    roce = roce * 100 if roce is not None else (
        (f.get("roe") or 0) * 100 if f.get("roe") is not None else None)
    roe = (f.get("roe") or 0) * 100 if f.get("roe") is not None else None
    de = f.get("debt_to_equity")
    de = de / 100 if de is not None else None  # percentage -> ratio
    promoter = (f.get("held_insiders") or 0) * 100 if f.get("held_insiders") is not None else None
    return {
        "ticker": ticker.replace(".NS", ""),
        "name": f.get("name", ticker),
        "mcap_cr": round(mcap_cr, 0),
        "eps_growth": round(eps_g, 1) if eps_g is not None else None,
        "sales_growth": round(sales_g, 1) if sales_g is not None else None,
        "peg": f.get("peg"),
        "de": round(de, 2) if de is not None else None,
        "roce": round(roce, 1) if roce is not None else None,
        "roe": round(roe, 1) if roe is not None else None,
        "promoter": round(promoter, 1) if promoter is not None else None,
        "pe": f.get("trailing_pe"),
    }


def _ge(v, t):
    return v is not None and v > t


def _le(v, t):
    return v is not None and v < t


# Preset screens. Each returns True if the row passes. Multi-year growth uses
# trailing growth as a proxy; industry-P/E condition is omitted (no free data).
PRESETS = {
    "PEG Screen": {
        "desc": "EPS growth > 20, Sales growth > 15, PEG < 1, D/E < 1, "
                "ROCE > 15, Market cap > ₹5000 cr.",
        "test": lambda m: (_ge(m["eps_growth"], 20) and _ge(m["sales_growth"], 15)
                           and _le(m["peg"], 1) and _le(m["de"], 1)
                           and _ge(m["roce"], 15) and _ge(m["mcap_cr"], 5000)),
    },
    "Hidden Gems": {
        "desc": "Market cap ₹500–5000 cr, Sales growth > 25, EPS growth > 25, "
                "ROCE > 20, D/E < 0.5, promoter/insider holding > 55.",
        "test": lambda m: (_le(m["mcap_cr"], 5000) and _ge(m["mcap_cr"], 500)
                           and _ge(m["sales_growth"], 25) and _ge(m["eps_growth"], 25)
                           and _ge(m["roce"], 20) and _le(m["de"], 0.5)
                           and _ge(m["promoter"], 55)),
    },
    "Growth": {
        "desc": "Market cap > ₹5000 cr, EPS growth > 20, Sales growth > 15, "
                "PEG < 1, ROCE > 18, D/E < 0.5, promoter/insider holding > 50.",
        "test": lambda m: (_ge(m["mcap_cr"], 5000) and _ge(m["eps_growth"], 20)
                           and _ge(m["sales_growth"], 15) and _le(m["peg"], 1)
                           and _ge(m["roce"], 18) and _le(m["de"], 0.5)
                           and _ge(m["promoter"], 50)),
    },
}


def scan_universe(universe: list[str] | None = None) -> list[dict]:
    """Fetch metrics for every ticker in the universe (skips failures)."""
    rows = []
    for t in (universe or SCREEN_UNIVERSE):
        m = get_metrics(t)
        if m:
            rows.append(m)
    return rows


def run_preset(name: str, rows: list[dict]) -> list[dict]:
    test = PRESETS[name]["test"]
    return [m for m in rows if test(m)]


def apply_filters(rows: list[dict], filters: list[dict]) -> list[dict]:
    """filters: [{key, op ('>'|'<'), value}]; rows must pass all (AND)."""
    out = []
    for m in rows:
        ok = True
        for flt in filters:
            v = m.get(flt["key"])
            if v is None:
                ok = False
                break
            if flt["op"] == ">" and not v > flt["value"]:
                ok = False
                break
            if flt["op"] == "<" and not v < flt["value"]:
                ok = False
                break
        if ok:
            out.append(m)
    return out
