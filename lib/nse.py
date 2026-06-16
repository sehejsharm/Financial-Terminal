"""Direct NSE provider — bypasses yfinance for `.NS` symbols.

Why this exists: Yahoo Finance actively blocks Render / Vercel / Streamlit
Cloud IPs, which is why a hosted Motherboard sees empty snapshots, ratings,
and ownership for Indian equities. NSE's own public APIs return the same
data (and more, e.g. promoter holding), but they're cookie-gated and
bot-detected — you have to look like a real browser.

We solve that with the same curl_cffi Chrome impersonation we already use
for yfinance, plus a warmed session cookie pulled from the NSE homepage.
The session is module-global, re-warmed after `_WARM_TTL` seconds or on
any 401/403 response.

Only quote / snapshot / history / movers are implemented here — the things
that materially blank-out on cloud IPs today. Options and corporate actions
can be added later against the same session.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from threading import Lock

BASE = "https://www.nseindia.com"
_LOCK = Lock()
_SESSION = None
_LAST_WARM = 0.0
_WARM_TTL = 600  # 10 min — NSE rotates session cookies aggressively.

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
    "X-Requested-With": "XMLHttpRequest",
}


def _session():
    """Return a warm browser-impersonating session, refreshing cookies as needed."""
    global _SESSION, _LAST_WARM
    with _LOCK:
        now = time.time()
        if _SESSION is not None and now - _LAST_WARM < _WARM_TTL:
            return _SESSION
        try:
            from curl_cffi import requests as cc
            s = cc.Session(impersonate="chrome120")
            # NSE sets the all-important cookies on the homepage.
            s.get(BASE, headers=_HEADERS, timeout=8)
            # marketStatus is a cheap second warm — confirms the cookie works.
            s.get(f"{BASE}/api/marketStatus", headers=_HEADERS, timeout=8)
            _SESSION = s
            _LAST_WARM = now
            return _SESSION
        except Exception:
            _SESSION = None
            return None


def _get(path: str, params: dict | None = None, retries: int = 1):
    """GET wrapper. One retry with forced session refresh on 401/403."""
    global _SESSION
    for attempt in range(retries + 1):
        s = _session()
        if s is None:
            return None
        try:
            r = s.get(f"{BASE}{path}", params=params, headers=_HEADERS, timeout=10)
            if r.status_code == 200:
                try:
                    return r.json()
                except Exception:
                    return None
            if r.status_code in (401, 403) and attempt < retries:
                with _LOCK:
                    _SESSION = None
                continue
            return None
        except Exception:
            if attempt < retries:
                with _LOCK:
                    _SESSION = None
                time.sleep(0.4)
                continue
            return None
    return None


def _clean_symbol(ticker: str) -> str | None:
    """Strip suffix; NSE API uses bare symbols. Indices not supported here."""
    if not ticker or ticker.startswith("^"):
        return None
    t = ticker.upper()
    for suf in (".NS", ".BO", ".NSE", ".BSE"):
        if t.endswith(suf):
            t = t[: -len(suf)]
            break
    return t or None


def is_indian(ticker: str) -> bool:
    """Is this ticker likely on NSE/BSE? Used by providers.py for routing."""
    if not ticker:
        return False
    t = ticker.upper()
    return (t.endswith(".NS") or t.endswith(".BO")
            or t in {"^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX"})


# ── quote ────────────────────────────────────────────────────────────────
def quote(ticker: str) -> dict | None:
    sym = _clean_symbol(ticker)
    if not sym:
        return None
    data = _get("/api/quote-equity", {"symbol": sym})
    if not data:
        return None
    pi = data.get("priceInfo") or {}
    last = pi.get("lastPrice")
    if last is None:
        return None
    return {
        "symbol": ticker,
        "price": float(last),
        "prev_close": float(pi["previousClose"]) if pi.get("previousClose") is not None else None,
        "change_pct": float(pi["pChange"]) if pi.get("pChange") is not None else None,
        "currency": "INR",
    }


# ── snapshot (fundamentals) ──────────────────────────────────────────────
def _safe_float(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def snapshot(ticker: str) -> dict | None:
    """Fundamentals snapshot built from /api/quote-equity + /api/quote-equity?section=trade_info.

    Pulls: name, sector, industry, price/prev/change, 52-w range, P/E, market
    cap (issuedSize × lastPrice), face value, ISIN, listing date.
    Promoter holding requires a second call to /api/quote-equity?section=corp_info.
    """
    sym = _clean_symbol(ticker)
    if not sym:
        return None
    data = _get("/api/quote-equity", {"symbol": sym})
    if not data:
        return None

    info = data.get("info") or {}
    pi = data.get("priceInfo") or {}
    industry_info = data.get("industryInfo") or {}
    security_info = data.get("securityInfo") or {}
    metadata = data.get("metadata") or {}
    wadj = pi.get("weekHighLow") or {}

    last = _safe_float(pi.get("lastPrice"))
    issued = _safe_float(security_info.get("issuedSize"))
    mcap = (last * issued) if last and issued else None

    return {
        "symbol": ticker,
        "name": info.get("companyName") or sym,
        "sector": industry_info.get("macro") or industry_info.get("sector"),
        "industry": industry_info.get("industry") or industry_info.get("basicIndustry"),
        "currency": "INR",
        "price": last,
        "prev_close": _safe_float(pi.get("previousClose")),
        "change_pct": _safe_float(pi.get("pChange")),
        "fifty_two_high": _safe_float(wadj.get("max")),
        "fifty_two_low": _safe_float(wadj.get("min")),
        "trailing_pe": _safe_float(metadata.get("pdSymbolPe")),
        "market_cap": mcap,
        "shares_outstanding": issued,
        "face_value": _safe_float(security_info.get("faceValue")),
        "isin": info.get("isin"),
        "listing_date": metadata.get("listingDate"),
        "listing_status": metadata.get("status"),
        "open": _safe_float(pi.get("open")),
        "day_high": _safe_float((pi.get("intraDayHighLow") or {}).get("max")),
        "day_low": _safe_float((pi.get("intraDayHighLow") or {}).get("min")),
        "vwap": _safe_float(pi.get("vwap")),
    }


# ── history ──────────────────────────────────────────────────────────────
_PERIOD_DAYS = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365,
                "2Y": 365 * 2, "3Y": 365 * 3, "5Y": 365 * 5, "10Y": 365 * 10}


def history(ticker: str, period: str = "1Y") -> list[dict] | None:
    """Daily OHLCV from NSE historicals. Returns capitalised-key candles."""
    sym = _clean_symbol(ticker)
    if not sym:
        return None
    days = _PERIOD_DAYS.get(period, 365)
    to = datetime.now()
    frm = to - timedelta(days=days)
    params = {
        "symbol": sym,
        "from": frm.strftime("%d-%m-%Y"),
        "to": to.strftime("%d-%m-%Y"),
        "series": '["EQ"]',
    }
    data = _get("/api/historical/cm/equity", params)
    if not data:
        return None
    rows = data.get("data") or []
    candles = []
    for r in rows:
        try:
            ts = r.get("CH_TIMESTAMP")  # YYYY-MM-DD
            if not ts:
                continue
            candles.append({
                "Date": ts,
                "Open": _safe_float(r.get("CH_OPENING_PRICE")) or 0.0,
                "High": _safe_float(r.get("CH_TRADE_HIGH_PRICE")) or 0.0,
                "Low": _safe_float(r.get("CH_TRADE_LOW_PRICE")) or 0.0,
                "Close": _safe_float(r.get("CH_CLOSING_PRICE")) or 0.0,
                "Volume": _safe_float(r.get("CH_TOT_TRADED_QTY")) or 0.0,
            })
        except (KeyError, TypeError, ValueError):
            continue
    # NSE returns newest-first; reverse for chart sanity.
    candles.reverse()
    return candles if candles else None


# ── movers ───────────────────────────────────────────────────────────────
def movers(kind: str = "gainers", count: int = 10) -> list[dict] | None:
    """NIFTY 50 gainers / losers from NSE itself (no yfinance scrape)."""
    idx = "NIFTY" if kind in ("gainers", "losers") else "NIFTY"
    data = _get("/api/live-analysis-variations", {"index": idx})
    if not data:
        return None
    bucket = (data.get("gainers") if kind == "gainers" else data.get("losers")) or {}
    rows = bucket.get("data") or []
    out = []
    for r in rows[:count]:
        out.append({
            "symbol": r.get("symbol"),
            "name": r.get("symbol"),  # NSE doesn't ship name here; use symbol
            "price": _safe_float(r.get("ltp")),
            "change_pct": _safe_float(r.get("perChange")),
            "prev_close": _safe_float(r.get("previous_price")),
            "currency": "INR",
        })
    return out


# ── index snapshot (NIFTY etc.) ──────────────────────────────────────────
# Map the Yahoo-style symbols Streamlit uses to NSE's "index" display names
# returned by /api/allIndices. Expanded so the Dashboard can fill more tiles
# without touching slow Yahoo-only US futures.
_INDEX_NAMES = {
    "^NSEI": "NIFTY 50",
    "^BSESN": "S&P BSE SENSEX",
    "^NSEBANK": "NIFTY BANK",
    "^INDIAVIX": "INDIA VIX",
    "^CNXIT": "NIFTY IT",
    "^CNXFMCG": "NIFTY FMCG",
    "^CNXAUTO": "NIFTY AUTO",
    "^CNXPHARMA": "NIFTY PHARMA",
    "^CNXMETAL": "NIFTY METAL",
    "^CNXREALTY": "NIFTY REALTY",
    "^CNXENERGY": "NIFTY ENERGY",
    "^CNXMIDCAP": "NIFTY MIDCAP 100",
    "^CNXSMALLCAP": "NIFTY SMALLCAP 100",
    "^CNX500": "NIFTY 500",
}


def index_quote(ticker: str) -> dict | None:
    """Index quotes via /api/allIndices."""
    if ticker not in _INDEX_NAMES:
        return None
    data = _get("/api/allIndices")
    if not data:
        return None
    target = _INDEX_NAMES[ticker]
    for row in data.get("data", []):
        # NSE returns 'index' as the display name (e.g. "NIFTY 50").
        if row.get("index", "").upper() == target.upper():
            return {
                "symbol": ticker,
                "price": _safe_float(row.get("last")),
                "prev_close": _safe_float(row.get("previousClose")),
                "change_pct": _safe_float(row.get("percentChange")),
                "currency": "INR",
            }
    return None
