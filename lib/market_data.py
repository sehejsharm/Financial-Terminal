"""yfinance wrappers and market constants.

All network access is funneled through here so it can be cached and so the
rest of the app never imports yfinance directly.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pandas as pd
import streamlit as st
import yfinance as yf

# Real indices / asset tickers used across the dashboard. India-first, with
# commodities and a couple of global benchmarks for context. Order is the
# display order for the Market Pulse grid.
INDEX_TICKERS: dict[str, str] = {
    "^NSEI": "NIFTY 50",
    "^BSESN": "SENSEX",
    "^NSEBANK": "NIFTY Bank",
    "^CNXIT": "NIFTY IT",
    "^INDIAVIX": "India VIX",
    "INR=X": "USD / INR",
    "GC=F": "Gold",
    "SI=F": "Silver",
    "CL=F": "Crude Oil (WTI)",
    "BZ=F": "Brent Crude",
    "^GSPC": "S&P 500",
    "BTC-USD": "Bitcoin",
}

# The primary index whose big chart anchors Market Pulse and the landing page.
PRIMARY_INDEX = "^NSEI"

# NSE sector indices for the sector heatmap.
SECTORS: dict[str, str] = {
    "^CNXIT": "IT",
    "^NSEBANK": "Bank",
    "^CNXAUTO": "Auto",
    "^CNXPHARMA": "Pharma",
    "^CNXFMCG": "FMCG",
    "^CNXMETAL": "Metal",
    "^CNXREALTY": "Realty",
    "^CNXENERGY": "Energy",
    "^CNXMEDIA": "Media",
    "^CNXPSUBANK": "PSU Bank",
    "^CNXINFRA": "Infrastructure",
}

# NIFTY 50 constituents (Yahoo .NS symbols) used to derive market movers, since
# yfinance's predefined screeners only cover US markets.
NIFTY50 = [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS",
    "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
    "LT.NS", "BAJFINANCE.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS",
    "HCLTECH.NS", "SUNPHARMA.NS", "TITAN.NS", "ULTRACEMCO.NS", "WIPRO.NS",
    "NESTLEIND.NS", "ONGC.NS", "NTPC.NS", "POWERGRID.NS", "M&M.NS",
    "TATAMOTORS.NS", "TATASTEEL.NS", "JSWSTEEL.NS", "ADANIENT.NS", "ADANIPORTS.NS",
    "COALINDIA.NS", "BAJAJFINSV.NS", "GRASIM.NS", "HINDALCO.NS", "BRITANNIA.NS",
    "CIPLA.NS", "DRREDDY.NS", "EICHERMOT.NS", "HEROMOTOCO.NS", "BPCL.NS",
    "TATACONSUM.NS", "APOLLOHOSP.NS", "INDUSINDBK.NS", "BAJAJ-AUTO.NS",
    "SBILIFE.NS", "HDFCLIFE.NS", "TECHM.NS", "LTIM.NS", "SHRIRAMFIN.NS",
    "TRENT.NS",
]

# Period label -> yfinance fetch parameters.
# Either "period" (native yfinance period) or "days" (computed start date).
PERIOD_MAP: dict[str, dict] = {
    "1D": {"period": "1d", "interval": "5m", "intraday": True},
    "5D": {"period": "5d", "interval": "30m", "intraday": True},
    "1M": {"period": "1mo", "interval": "1d"},
    "3M": {"period": "3mo", "interval": "1d"},
    "6M": {"period": "6mo", "interval": "1d"},
    "YTD": {"period": "ytd", "interval": "1d"},
    "1Y": {"period": "1y", "interval": "1d"},
    "3Y": {"days": 365 * 3, "interval": "1wk"},
    "5Y": {"period": "5y", "interval": "1wk"},
    "10Y": {"period": "10y", "interval": "1wk"},
    "20Y": {"days": 365 * 20, "interval": "1mo"},
    "30Y": {"days": 365 * 30, "interval": "1mo"},
    "Max": {"period": "max", "interval": "1mo"},
}

PERIOD_LABELS = list(PERIOD_MAP.keys())


def _flatten_columns(df: pd.DataFrame) -> pd.DataFrame:
    """yfinance sometimes returns a MultiIndex column frame for a single
    ticker. Flatten to plain OHLCV columns."""
    if isinstance(df.columns, pd.MultiIndex):
        # Drop the ticker level, keep the OHLCV level.
        df.columns = df.columns.get_level_values(0)
    return df


@st.cache_data(ttl=300, show_spinner=False)
def get_history(ticker: str, period: str) -> pd.DataFrame:
    """Return an OHLCV DataFrame for one ticker over the given period label.

    Index is datetime; columns include Open/High/Low/Close/Volume.
    Returns an empty frame on failure.
    """
    cfg = PERIOD_MAP.get(period, PERIOD_MAP["1Y"])
    interval = cfg["interval"]
    try:
        if "period" in cfg:
            df = yf.Ticker(ticker).history(
                period=cfg["period"], interval=interval, auto_adjust=False
            )
        else:
            start = datetime.now() - timedelta(days=cfg["days"])
            df = yf.Ticker(ticker).history(
                start=start.strftime("%Y-%m-%d"), interval=interval, auto_adjust=False
            )
    except Exception:
        return pd.DataFrame()
    if df is None or df.empty:
        return pd.DataFrame()
    df = _flatten_columns(df)
    return df.dropna(how="all")


@st.cache_data(ttl=300, show_spinner=False)
def get_history_bulk(tickers: tuple[str, ...], period: str) -> dict[str, pd.DataFrame]:
    """Fetch history for many tickers. Returns {ticker: DataFrame}."""
    out: dict[str, pd.DataFrame] = {}
    cfg = PERIOD_MAP.get(period, PERIOD_MAP["1Y"])
    interval = cfg["interval"]
    kwargs = {"interval": interval, "auto_adjust": False, "group_by": "ticker",
              "threads": True, "progress": False}
    try:
        if "period" in cfg:
            kwargs["period"] = cfg["period"]
        else:
            start = datetime.now() - timedelta(days=cfg["days"])
            kwargs["start"] = start.strftime("%Y-%m-%d")
        data = yf.download(list(tickers), **kwargs)
    except Exception:
        return {t: get_history(t, period) for t in tickers}

    if data is None or data.empty:
        return {t: pd.DataFrame() for t in tickers}

    for t in tickers:
        try:
            if isinstance(data.columns, pd.MultiIndex):
                sub = data[t].dropna(how="all")
            else:
                sub = data.dropna(how="all")
            out[t] = sub
        except Exception:
            out[t] = pd.DataFrame()
    return out


@st.cache_data(ttl=60, show_spinner=False)
def get_quote(ticker: str) -> dict:
    """Return a normalized quote dict for one ticker.

    Keys: symbol, name, price, prev_close, change, change_pct, currency.
    """
    t = yf.Ticker(ticker)
    price = prev_close = None
    name = INDEX_TICKERS.get(ticker) or SECTORS.get(ticker) or ticker
    currency = "USD"
    try:
        fi = t.fast_info
        price = fi.get("last_price") if hasattr(fi, "get") else fi.last_price
        prev_close = (
            fi.get("previous_close") if hasattr(fi, "get") else fi.previous_close
        )
        currency = (fi.get("currency") if hasattr(fi, "get") else fi.currency) or "USD"
    except Exception:
        pass

    # Fall back to a short history if fast_info was unavailable.
    if price is None or prev_close is None:
        hist = get_history(ticker, "5D")
        if not hist.empty and "Close" in hist:
            closes = hist["Close"].dropna()
            if len(closes) >= 1:
                price = price or float(closes.iloc[-1])
            if len(closes) >= 2:
                prev_close = prev_close or float(closes.iloc[-2])

    name = _display_name(ticker, name)

    change = change_pct = None
    if price is not None and prev_close not in (None, 0):
        change = float(price) - float(prev_close)
        change_pct = change / float(prev_close) * 100.0

    return {
        "symbol": ticker,
        "name": name,
        "price": float(price) if price is not None else None,
        "prev_close": float(prev_close) if prev_close is not None else None,
        "change": change,
        "change_pct": change_pct,
        "currency": currency,
    }


def _display_name(ticker: str, fallback: str) -> str:
    """Best-effort human name without a slow .info call when avoidable."""
    if ticker in INDEX_TICKERS:
        return INDEX_TICKERS[ticker]
    if ticker in SECTORS:
        return SECTORS[ticker]
    try:
        info = yf.Ticker(ticker).info
        return info.get("shortName") or info.get("longName") or fallback
    except Exception:
        return fallback


@st.cache_data(ttl=60, show_spinner=False)
def get_quotes_bulk(tickers: tuple[str, ...]) -> dict[str, dict]:
    """Return {ticker: quote dict} for many tickers using a single bulk
    download for price/change, with light name resolution."""
    out: dict[str, dict] = {}
    try:
        data = yf.download(
            list(tickers), period="5d", interval="1d", group_by="ticker",
            auto_adjust=False, threads=True, progress=False,
        )
    except Exception:
        data = None

    for t in tickers:
        price = prev_close = None
        try:
            if data is not None and not data.empty:
                sub = data[t] if isinstance(data.columns, pd.MultiIndex) else data
                closes = sub["Close"].dropna()
                if len(closes) >= 1:
                    price = float(closes.iloc[-1])
                if len(closes) >= 2:
                    prev_close = float(closes.iloc[-2])
        except Exception:
            pass
        change = change_pct = None
        if price is not None and prev_close not in (None, 0):
            change = price - prev_close
            change_pct = change / prev_close * 100.0
        out[t] = {
            "symbol": t,
            "name": INDEX_TICKERS.get(t) or SECTORS.get(t) or t,
            "price": price,
            "prev_close": prev_close,
            "change": change,
            "change_pct": change_pct,
            "currency": "USD",
        }
    return out


@st.cache_data(ttl=600, show_spinner=False)
def is_etf(ticker: str) -> bool:
    """Heuristic check whether a ticker is an ETF."""
    if ticker in SECTORS:
        return True
    try:
        info = yf.Ticker(ticker).info
        qt = (info.get("quoteType") or "").upper()
        return qt in ("ETF", "MUTUALFUND")
    except Exception:
        return False


@st.cache_data(ttl=600, show_spinner=False)
def get_stock_fundamentals(ticker: str) -> dict:
    """Return a dict of fundamental fields for a single stock.

    Missing values come back as None rather than raising.
    """
    try:
        info = yf.Ticker(ticker).info
    except Exception:
        info = {}

    def g(*keys):
        for k in keys:
            v = info.get(k)
            if v is not None:
                return v
        return None

    return {
        "symbol": ticker,
        "name": g("longName", "shortName") or ticker,
        "sector": g("sector"),
        "industry": g("industry"),
        "price": g("currentPrice", "regularMarketPrice"),
        "prev_close": g("previousClose", "regularMarketPreviousClose"),
        "currency": g("currency") or "USD",
        "market_cap": g("marketCap"),
        "trailing_pe": g("trailingPE"),
        "forward_pe": g("forwardPE"),
        "peg": g("pegRatio", "trailingPegRatio"),
        "price_to_book": g("priceToBook"),
        "price_to_sales": g("priceToSalesTrailing12Months"),
        "beta": g("beta"),
        "dividend_yield": g("dividendYield"),
        "profit_margin": g("profitMargins"),
        "operating_margin": g("operatingMargins"),
        "roe": g("returnOnEquity"),
        "roa": g("returnOnAssets"),
        "revenue_growth": g("revenueGrowth"),
        "earnings_growth": g("earningsGrowth"),
        "debt_to_equity": g("debtToEquity"),
        "current_ratio": g("currentRatio"),
        "quick_ratio": g("quickRatio"),
        "free_cashflow": g("freeCashflow"),
        "revenue": g("totalRevenue"),
        "ebitda": g("ebitda"),
        "gross_margin": g("grossMargins"),
        "fifty_two_high": g("fiftyTwoWeekHigh"),
        "fifty_two_low": g("fiftyTwoWeekLow"),
        "fifty_day_avg": g("fiftyDayAverage"),
        "two_hundred_day_avg": g("twoHundredDayAverage"),
        "volume": g("volume", "regularMarketVolume"),
        "avg_volume": g("averageVolume"),
        "shares_outstanding": g("sharesOutstanding"),
        "eps_trailing": g("trailingEps"),
        "eps_forward": g("forwardEps"),
        "target_mean": g("targetMeanPrice"),
        "target_high": g("targetHighPrice"),
        "target_low": g("targetLowPrice"),
        "num_analysts": g("numberOfAnalystOpinions"),
        "summary": g("longBusinessSummary"),
        "website": g("website"),
        "quote_type": g("quoteType"),
    }


@st.cache_data(ttl=600, show_spinner=False)
def get_etf_details(ticker: str) -> dict:
    """Return ETF metadata: expense ratio, holdings, sector weights, returns."""
    t = yf.Ticker(ticker)
    try:
        info = t.info
    except Exception:
        info = {}

    holdings: list[dict] = []
    sector_weights: dict[str, float] = {}
    try:
        funds = t.funds_data
        if funds is not None:
            try:
                th = funds.top_holdings
                if th is not None and not th.empty:
                    for sym, row in th.iterrows():
                        weight = row.get("Holding Percent")
                        name = row.get("Name", sym)
                        holdings.append(
                            {"symbol": str(sym), "name": str(name),
                             "weight": float(weight) if weight is not None else None}
                        )
            except Exception:
                pass
            try:
                sw = funds.sector_weightings
                if sw:
                    sector_weights = {
                        str(k).replace("_", " ").title(): float(v)
                        for k, v in sw.items()
                    }
            except Exception:
                pass
    except Exception:
        pass

    return {
        "symbol": ticker,
        "name": info.get("longName") or info.get("shortName") or ticker,
        "category": info.get("category"),
        "expense_ratio": info.get("netExpenseRatio") or info.get("annualReportExpenseRatio"),
        "total_assets": info.get("totalAssets"),
        "yield": info.get("yield"),
        "beta_3y": info.get("beta3Year") or info.get("beta"),
        "ytd_return": info.get("ytdReturn"),
        "three_year_return": info.get("threeYearAverageReturn"),
        "five_year_return": info.get("fiveYearAverageReturn"),
        "nav": info.get("navPrice"),
        "summary": info.get("longBusinessSummary"),
        "holdings": holdings,
        "sector_weights": sector_weights,
    }


@st.cache_data(ttl=120, show_spinner=False)
def _universe_quotes(universe: tuple[str, ...]) -> list[dict]:
    """Bulk daily quotes for a universe, with price/change and volume."""
    rows: list[dict] = []
    try:
        data = yf.download(
            list(universe), period="5d", interval="1d", group_by="ticker",
            auto_adjust=False, threads=True, progress=False,
        )
    except Exception:
        data = None
    if data is None or data.empty:
        return rows

    for t in universe:
        try:
            sub = data[t] if isinstance(data.columns, pd.MultiIndex) else data
            closes = sub["Close"].dropna()
            vols = sub["Volume"].dropna() if "Volume" in sub else None
            if len(closes) < 2:
                continue
            price = float(closes.iloc[-1])
            prev = float(closes.iloc[-2])
            volume = float(vols.iloc[-1]) if vols is not None and len(vols) else None
            rows.append({
                "symbol": t,
                "name": t.replace(".NS", "").replace("-", " ").title(),
                "price": price,
                "change": price - prev,
                "change_pct": (price - prev) / prev * 100 if prev else None,
                "volume": volume,
                "turnover": (volume or 0) * price,
            })
        except Exception:
            continue
    return rows


def get_movers(kind: str = "gainers", count: int = 8,
               universe: tuple[str, ...] | None = None) -> list[dict]:
    """Return market movers computed from a ticker universe (default NIFTY 50).

    kind: 'gainers' | 'losers' | 'actives' (actives ranked by traded turnover).
    """
    rows = _universe_quotes(universe or tuple(NIFTY50))
    rows = [r for r in rows if r.get("change_pct") is not None]
    if not rows:
        return []
    if kind == "gainers":
        rows.sort(key=lambda r: r["change_pct"], reverse=True)
    elif kind == "losers":
        rows.sort(key=lambda r: r["change_pct"])
    else:  # actives
        rows.sort(key=lambda r: r.get("turnover") or 0, reverse=True)
    return rows[:count]
