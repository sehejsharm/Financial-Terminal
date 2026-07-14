"""Institutional analytics helpers (ownership, ratings, earnings, WACC, comps).

Proprietary 'Motherboard' module names map to these. Built on free data, so
some legacy terminal functions (debt maturity schedules, supply-chain graphs)
are approximated or generated descriptively rather than sourced from a feed.
"""
from __future__ import annotations

import pandas as pd
import streamlit as st

from lib.market_data import get_stock_fundamentals, make_ticker


@st.cache_data(ttl=3600, show_spinner=False)
def get_officers(ticker: str) -> list[dict]:
    try:
        officers = make_ticker(ticker).info.get("companyOfficers") or []
    except Exception:
        return []
    out = []
    for o in officers[:8]:
        out.append({
            "name": o.get("name", ""),
            "title": o.get("title", ""),
            "pay": o.get("totalPay"),
            "age": o.get("age"),
        })
    return out


@st.cache_data(ttl=3600, show_spinner=False)
def get_ownership(ticker: str) -> dict:
    t = make_ticker(ticker)
    out = {}
    for attr in ("major_holders", "institutional_holders", "mutualfund_holders"):
        try:
            df = getattr(t, attr)
            out[attr] = df if isinstance(df, pd.DataFrame) else pd.DataFrame()
        except Exception:
            out[attr] = pd.DataFrame()
    return out


@st.cache_data(ttl=3600, show_spinner=False)
def get_ratings(ticker: str) -> dict:
    t = make_ticker(ticker)
    out = {}
    try:
        out["recommendations"] = t.recommendations
    except Exception:
        out["recommendations"] = pd.DataFrame()
    try:
        out["targets"] = t.analyst_price_targets
    except Exception:
        out["targets"] = {}
    return out


@st.cache_data(ttl=3600, show_spinner=False)
def get_earnings_history(ticker: str) -> pd.DataFrame:
    t = make_ticker(ticker)
    for attr in ("earnings_history", "earnings_dates"):
        try:
            df = getattr(t, attr)
            if isinstance(df, pd.DataFrame) and not df.empty:
                return df
        except Exception:
            continue
    return pd.DataFrame()


def capm_cost_of_equity(rf_pct: float, beta: float, erp_pct: float) -> float:
    """CAPM: Re = Rf + beta x equity risk premium (all in %)."""
    return rf_pct + (beta or 1.0) * erp_pct


def wacc(equity_value: float, debt_value: float, cost_equity_pct: float,
         cost_debt_pct: float, tax_pct: float) -> dict:
    """Weighted average cost of capital (the Capital Cost Model)."""
    v = (equity_value or 0) + (debt_value or 0)
    if v <= 0:
        return {"wacc": None, "we": None, "wd": None}
    we = equity_value / v
    wd = debt_value / v
    val = we * cost_equity_pct + wd * cost_debt_pct * (1 - tax_pct / 100.0)
    return {"wacc": val, "we": we * 100, "wd": wd * 100}


def _sane_ps(f: dict) -> float | None:
    """P/S with a sanity cross-check.

    yfinance's priceToSalesTrailing12Months is unreliable for some NSE names
    (e.g. INFY.NS reported 221 — apparently ratioed against a partial-period
    or unconsolidated revenue figure). When we can compute market_cap /
    trailing revenue ourselves, prefer the reported ratio only if it agrees
    within 3x; otherwise use the computed value."""
    reported = f.get("price_to_sales")
    mcap, rev = f.get("market_cap"), f.get("revenue")
    computed = (mcap / rev) if (mcap and rev) else None
    if computed is not None and computed > 0:
        if reported is None or reported <= 0 or not (1 / 3 <= reported / computed <= 3):
            return computed
    return reported


def _comps_row(t: str) -> dict | None:
    f = get_stock_fundamentals(t)
    if not f:
        return None
    ev_ebitda = None
    if f.get("market_cap") and f.get("ebitda"):
        ev = f["market_cap"]  # market cap as a simple EV proxy (no debt data layer)
        ev_ebitda = ev / f["ebitda"] if f["ebitda"] else None
    ps = _sane_ps(f)
    return {
        "Ticker": t.replace(".NS", ""),
        "Name": f.get("name", t),
        "P/E": round(f["trailing_pe"], 1) if f.get("trailing_pe") else None,
        "Fwd P/E": round(f["forward_pe"], 1) if f.get("forward_pe") else None,
        "P/B": round(f["price_to_book"], 2) if f.get("price_to_book") else None,
        "P/S": round(ps, 2) if ps else None,
        "EV/EBITDA*": round(ev_ebitda, 1) if ev_ebitda else None,
        "ROE%": round(f["roe"] * 100, 1) if f.get("roe") is not None else None,
    }


def comps_matrix(tickers: list[str]) -> pd.DataFrame:
    """Relative-valuation table across peers (the Comps Matrix).

    Peers are fetched in parallel with a per-peer timeout so one slow/blocked
    name can't hang the whole request (the old sequential loop did)."""
    from concurrent.futures import ThreadPoolExecutor

    if not tickers:
        return pd.DataFrame()
    with ThreadPoolExecutor(max_workers=min(8, len(tickers))) as pool:
        futures = [(t, pool.submit(_comps_row, t)) for t in tickers]
        rows = []
        for t, fut in futures:  # preserves input order
            try:
                r = fut.result(timeout=12)
            except Exception:
                r = None
            if r:
                rows.append(r)
    return pd.DataFrame(rows)
