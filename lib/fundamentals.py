"""Financial-statement and analyst-estimate helpers (yfinance)."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from lib.market_data import make_ticker

# Key line items to surface per statement (shown if present).
INCOME_ROWS = [
    "Total Revenue", "Cost Of Revenue", "Gross Profit", "Operating Expense",
    "Operating Income", "Pretax Income", "Tax Provision", "Net Income",
    "Basic EPS", "Diluted EPS", "EBITDA",
]
BALANCE_ROWS = [
    "Total Assets", "Current Assets", "Cash And Cash Equivalents",
    "Total Liabilities Net Minority Interest", "Current Liabilities",
    "Total Debt", "Long Term Debt", "Stockholders Equity",
    "Retained Earnings", "Working Capital",
]
CASHFLOW_ROWS = [
    "Operating Cash Flow", "Investing Cash Flow", "Financing Cash Flow",
    "Free Cash Flow", "Capital Expenditure", "Repurchase Of Capital Stock",
    "Cash Dividends Paid",
]


@st.cache_data(ttl=3600, show_spinner=False)
def get_statement(ticker: str, kind: str, quarterly: bool = False) -> pd.DataFrame:
    """Return a financial statement frame (rows=line items, cols=periods)."""
    t = make_ticker(ticker)
    try:
        if kind == "income":
            df = t.quarterly_income_stmt if quarterly else t.income_stmt
        elif kind == "balance":
            df = t.quarterly_balance_sheet if quarterly else t.balance_sheet
        else:
            df = t.quarterly_cashflow if quarterly else t.cashflow
    except Exception:
        return pd.DataFrame()
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.copy()
    df.columns = [pd.Timestamp(c).date().isoformat() for c in df.columns]
    return df


def select_rows(df: pd.DataFrame, wanted: list[str]) -> pd.DataFrame:
    """Keep the wanted rows (in order) that exist in the frame."""
    if df is None or df.empty:
        return pd.DataFrame()
    present = [r for r in wanted if r in df.index]
    return df.loc[present] if present else df


@st.cache_data(ttl=3600, show_spinner=False)
def get_estimates(ticker: str) -> dict:
    """Return analyst estimates/targets where yfinance exposes them."""
    t = make_ticker(ticker)
    out: dict = {}
    try:
        pt = t.analyst_price_targets
        if isinstance(pt, dict):
            out["price_targets"] = pt
    except Exception:
        pass
    for attr, key in (("earnings_estimate", "earnings_estimate"),
                      ("revenue_estimate", "revenue_estimate"),
                      ("growth_estimates", "growth_estimates")):
        try:
            df = getattr(t, attr)
            if isinstance(df, pd.DataFrame) and not df.empty:
                out[key] = df
        except Exception:
            continue
    return out


@st.cache_data(ttl=3600, show_spinner=False)
def capital_structure(ticker: str) -> dict:
    """Return total debt, cash, equity and market cap for the capital stack."""
    try:
        info = make_ticker(ticker).info
    except Exception:
        info = {}
    return {
        "total_debt": info.get("totalDebt"),
        "cash": info.get("totalCash"),
        "market_cap": info.get("marketCap"),
        "shares": info.get("sharesOutstanding"),
        "currency": info.get("currency") or "USD",
    }
