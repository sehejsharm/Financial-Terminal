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


def quote(ticker: str) -> dict | None:
    """Fast path: Twelve Data → yfinance fallback."""
    if has_twelvedata():
        q = _td_quote(ticker)
        if q and q.get("price") is not None:
            return q
    return yf_md.get_quote(ticker)


def quotes_bulk(tickers: list[str], max_workers: int = 8) -> dict[str, dict | None]:
    """Parallel quote fetch across the configured provider.

    Threaded because the underlying calls (yfinance / Twelve Data) are
    network-bound. Big speed-up for the dashboard snapshot.
    """
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(quote, tickers))
    return dict(zip(tickers, results))
