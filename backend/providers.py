"""Pluggable market-data providers.

Default = the existing yfinance-based `lib.market_data`. If `TWELVE_DATA_API_KEY`
is set, the Twelve Data REST provider is preferred for quotes (much faster
than yfinance: single REST call vs. browser-impersonating scrape). yfinance
remains the fallback for symbols Twelve Data doesn't cover (e.g. some Indian
indices) and for endpoints Twelve Data's free tier doesn't expose.

Free tier reference (Twelve Data): 800 calls/day, 8/min. Sign up at
https://twelvedata.com — set TWELVE_DATA_API_KEY in your env.
"""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

import requests

from lib import market_data as yf_md
from lib import nse

_TD_KEY = (os.getenv("TWELVE_DATA_API_KEY") or "").strip() or None
_TD_BASE = "https://api.twelvedata.com"
_TD_SESSION = requests.Session()


def has_twelvedata() -> bool:
    return _TD_KEY is not None


def _td_quote(symbol: str) -> dict | None:
    """Twelve Data quote — fast REST call. Returns None on failure."""
    if not _TD_KEY:
        return None
    try:
        r = _TD_SESSION.get(
            f"{_TD_BASE}/quote",
            params={"symbol": symbol, "apikey": _TD_KEY},
            timeout=6,
        )
        if r.status_code != 200:
            return None
        body = r.json()
        if "code" in body and body.get("status") == "error":
            return None
        return {
            "symbol": symbol,
            "price": float(body["close"]) if body.get("close") else None,
            "prev_close": float(body["previous_close"])
                          if body.get("previous_close") else None,
            "change_pct": float(body["percent_change"])
                          if body.get("percent_change") else None,
            "currency": body.get("currency"),
        }
    except Exception:
        return None


def _td_statistics(symbol: str) -> dict | None:
    """Twelve Data statistics endpoint for fundamentals. None on failure."""
    if not _TD_KEY:
        return None
    try:
        r = _TD_SESSION.get(
            f"{_TD_BASE}/statistics",
            params={"symbol": symbol, "apikey": _TD_KEY},
            timeout=8,
        )
        if r.status_code != 200:
            return None
        body = r.json()
        if body.get("status") == "error" or "statistics" not in body:
            return None
        stats = body.get("statistics", {})
        valuations = stats.get("valuations_metrics", {})
        financials = stats.get("financials", {})
        stock_stats = stats.get("stock_statistics", {})
        highlights = stats.get("highlights", {})

        def _f(d, *keys):
            for k in keys:
                v = d.get(k)
                if v is not None:
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        pass
            return None

        return {
            "market_cap": _f(highlights, "market_capitalization"),
            "trailing_pe": _f(valuations, "trailing_pe"),
            "forward_pe": _f(valuations, "forward_pe"),
            "price_to_book": _f(valuations, "price_to_book_mrq"),
            "beta": _f(stock_stats, "beta"),
            "fifty_two_high": _f(stock_stats, "52_week_high"),
            "fifty_two_low": _f(stock_stats, "52_week_low"),
            "dividend_yield": _f(highlights, "dividend_yield"),
            "eps_trailing": _f(highlights, "diluted_eps_ttm"),
            "profit_margin": _f(highlights, "profit_margin"),
            "revenue": _f(financials.get("income_statement", {}), "total_revenue"),
        }
    except Exception:
        return None


def _td_time_series(symbol: str, period: str = "1Y") -> list[dict] | None:
    """Twelve Data time series for chart data. List of candle dicts or None."""
    if not _TD_KEY:
        return None
    period_map = {
        "1D": ("1min", "1day"),
        "5D": ("5min", "5day"),
        "1M": ("1day", "1month"),
        "3M": ("1day", "3month"),
        "6M": ("1day", "6month"),
        "1Y": ("1day", "1year"),
        "3Y": ("1week", "3year"),
        "5Y": ("1week", "5year"),
    }
    interval, _outputsize_period = period_map.get(period, ("1day", "1year"))
    try:
        r = _TD_SESSION.get(
            f"{_TD_BASE}/time_series",
            params={
                "symbol": symbol,
                "interval": interval,
                "outputsize": 365,
                "apikey": _TD_KEY,
            },
            timeout=10,
        )
        if r.status_code != 200:
            return None
        body = r.json()
        if body.get("status") == "error" or "values" not in body:
            return None
        candles = []
        for row in reversed(body["values"]):
            try:
                candles.append({
                    "Date": row.get("datetime"),
                    "Open": float(row["open"]),
                    "High": float(row["high"]),
                    "Low": float(row["low"]),
                    "Close": float(row["close"]),
                    "Volume": float(row.get("volume") or 0),
                })
            except (KeyError, ValueError, TypeError):
                continue
        return candles if candles else None
    except Exception:
        return None


def quote(ticker: str) -> dict | None:
    """Fast path: NSE direct (for .NS / .BO / Indian indices) → Twelve Data → yfinance."""
    # Indian equities: hit NSE directly. They publish the data; Yahoo blocks
    # our cloud IP. NSE doesn't.
    if nse.is_indian(ticker):
        q = nse.index_quote(ticker) if ticker.startswith("^") else nse.quote(ticker)
        if q and q.get("price") is not None:
            return q
    if has_twelvedata():
        q = _td_quote(ticker)
        if q and q.get("price") is not None:
            return q
    return yf_md.get_quote(ticker)


def quotes_bulk(tickers: list[str], max_workers: int = 8) -> dict[str, dict | None]:
    """Parallel quote fetch across the configured provider."""
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(quote, tickers))
    return dict(zip(tickers, results))


def snapshot(ticker: str) -> dict | None:
    """Fundamentals snapshot. Provider preference (Indian first):

        1. NSE direct  — for .NS / .BO; gives name, sector, P/E, mcap, 52-w.
        2. yfinance    — for everything else, and overlay for non-NSE fields.
        3. Twelve Data — overlay for cloud-IP-resilient stats + live price.

    We layer rather than choose: each provider fills the fields it has, so
    we get the union. Returns None only if we have literally nothing.
    """
    base: dict = {}

    if nse.is_indian(ticker) and not ticker.startswith("^"):
        nse_data = nse.snapshot(ticker)
        if nse_data:
            for k, v in nse_data.items():
                if v is not None:
                    base[k] = v

    yf_data = yf_md.get_stock_fundamentals(ticker) or {}
    for k, v in yf_data.items():
        if v is not None and base.get(k) in (None, "", 0):
            base[k] = v

    td_q = None
    if has_twelvedata():
        td_stats = _td_statistics(ticker)
        if td_stats:
            for k, v in td_stats.items():
                if v is not None and base.get(k) in (None, "", 0):
                    base[k] = v
        td_q = _td_quote(ticker)
        if td_q and td_q.get("price") is not None:
            # Don't override an NSE price for an Indian stock — INR vs USD.
            if not nse.is_indian(ticker):
                base["price"] = td_q["price"]
                base["prev_close"] = td_q.get("prev_close")
                base["change_pct"] = td_q.get("change_pct")
                if td_q.get("currency"):
                    base["currency"] = td_q["currency"]

    # Last-ditch: synthesise from any quote we can get.
    if not base or not any(base.values()):
        fallback_q = quote(ticker)
        if fallback_q and fallback_q.get("price") is not None:
            base = {
                "symbol": ticker,
                "name": ticker,
                "price": fallback_q.get("price"),
                "prev_close": fallback_q.get("prev_close"),
                "change_pct": fallback_q.get("change_pct"),
                "currency": fallback_q.get("currency") or "USD",
            }
        else:
            return None

    base.setdefault("symbol", ticker)
    base.setdefault("name", ticker)
    base.setdefault("currency", "INR" if nse.is_indian(ticker) else "USD")
    return base


def history(ticker: str, period: str = "1Y") -> list[dict]:
    """Price history: NSE direct (Indian) → Twelve Data → yfinance."""
    if nse.is_indian(ticker) and not ticker.startswith("^"):
        candles = nse.history(ticker, period)
        if candles:
            return candles

    if has_twelvedata():
        candles = _td_time_series(ticker, period)
        if candles:
            return candles

    df = yf_md.get_history(ticker, period)
    if df is None or df.empty:
        return []
    df = df.reset_index()
    df.columns = [str(c) for c in df.columns]
    candles = df.to_dict(orient="records")
    for row in candles:
        for k, v in list(row.items()):
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    return candles
