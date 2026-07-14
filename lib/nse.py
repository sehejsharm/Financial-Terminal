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
    """Fundamentals snapshot built from /api/quote-equity (base + trade_info).

    Pulls: name, sector, industry, price/prev/change, 52-w range, P/E, market
    cap (issuedSize × lastPrice), face value, ISIN, listing date, VWAP,
    intraday range, delivery %, volume, value traded, securities lending.
    """
    sym = _clean_symbol(ticker)
    if not sym:
        return None
    data = _get("/api/quote-equity", {"symbol": sym})
    if not data:
        return None

    # Second call: trade_info section has volume, value, deliveryQuantity etc.
    trade = _get("/api/quote-equity", {"symbol": sym, "section": "trade_info"}) or {}

    info = data.get("info") or {}
    pi = data.get("priceInfo") or {}
    industry_info = data.get("industryInfo") or {}
    security_info = data.get("securityInfo") or {}
    metadata = data.get("metadata") or {}
    wadj = pi.get("weekHighLow") or {}
    intraday = pi.get("intraDayHighLow") or {}
    market_dept = trade.get("marketDeptOrderBook") or {}
    sec_wise = trade.get("securityWiseDP") or {}
    trade_meta = trade.get("tradeInfo") or {}

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
        "day_high": _safe_float(intraday.get("max")),
        "day_low": _safe_float(intraday.get("min")),
        "vwap": _safe_float(pi.get("vwap")),
        # Volumes / liquidity from trade_info section
        "volume": _safe_float(sec_wise.get("quantityTraded")),
        "value_traded": _safe_float(sec_wise.get("totalTradedValue")),
        "delivery_pct": _safe_float(sec_wise.get("deliveryToTradedQuantity")),
        "bid_qty": _safe_float((market_dept.get("totalBuyQuantity") or 0)),
        "ask_qty": _safe_float((market_dept.get("totalSellQuantity") or 0)),
        "bid": _safe_float((market_dept.get("bid") or [{}])[0].get("price") if market_dept.get("bid") else None),
        "ask": _safe_float((market_dept.get("ask") or [{}])[0].get("price") if market_dept.get("ask") else None),
        "lower_circuit": _safe_float(pi.get("lowerCP")),
        "upper_circuit": _safe_float(pi.get("upperCP")),
    }


def corporate_info(ticker: str) -> dict | None:
    """Promoter / public holding from /api/quote-equity?section=corp_info."""
    sym = _clean_symbol(ticker)
    if not sym:
        return None
    data = _get("/api/quote-equity", {"symbol": sym, "section": "corp_info"})
    if not data:
        return None
    # Shape: { corporate: { latest_announcements, board_meetings, ... },
    #          shareholdings_patterns: {data: [...], cols: [...]} }
    sp = (data.get("corporate") or {}).get("shareholdings_patterns") or {}
    out: dict = {"shareholding_pattern": []}
    rows = sp.get("data") or []
    for r in rows[:8]:  # last few quarters
        out["shareholding_pattern"].append({
            k: _safe_float(v) if isinstance(v, (int, float, str)) and str(v).replace(".", "").replace("-", "").isdigit() else v
            for k, v in r.items()
        })
    return out


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
    """NIFTY 50 gainers / losers from NSE itself (no yfinance scrape).

    Bugfix: this endpoint's `index` query param is the VARIATION TYPE
    ("gainers" / "loosers" — NSE's spelling), not an index name, and the
    response is keyed by universe (NIFTY / BANKNIFTY / allSec / FOSec).
    Passing index=NIFTY and reading data["gainers"] matched nothing, so the
    dashboard cached an empty movers list. Returns None (not []) when empty
    so callers fall through to the yfinance computation."""
    variation = "gainers" if kind == "gainers" else "loosers"
    data = _get("/api/live-analysis-variations", {"index": variation})
    if not data:
        return None
    bucket = data.get("NIFTY") or data.get("allSec") or data.get("FOSec") or {}
    rows = bucket.get("data") or []
    if not rows:
        # Tolerate the other observed shape: {"gainers": {"data": [...]}, ...}
        legacy = data.get("gainers" if kind == "gainers" else "loosers") \
            or data.get("losers") or {}
        rows = legacy.get("data") or [] if isinstance(legacy, dict) else []
    out = []
    for r in rows[:count]:
        out.append({
            "symbol": r.get("symbol"),
            "name": r.get("symbol"),  # NSE doesn't ship name here; use symbol
            "price": _safe_float(r.get("ltp") or r.get("lastPrice")),
            "change_pct": _safe_float(r.get("perChange") or r.get("pChange")
                                      or r.get("net_price")),
            "prev_close": _safe_float(r.get("previous_price")
                                      or r.get("prev_price")
                                      or r.get("previousClose")),
            "currency": "INR",
        })
    return out or None


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
    """Index quotes via /api/allIndices.

    Match logic is exact-then-substring + space-insensitive — NSE has used
    both "NIFTY MIDCAP 100" and "NIFTY MIDCAP100" historically, and adds/
    removes the leading "S&P" / "Nifty" qualifiers without notice.
    """
    if ticker not in _INDEX_NAMES:
        return None
    data = _get("/api/allIndices")
    if not data:
        return None
    target = _INDEX_NAMES[ticker].upper()
    target_squashed = target.replace(" ", "")

    def _row_to_quote(row):
        return {
            "symbol": ticker,
            "price": _safe_float(row.get("last")),
            "prev_close": _safe_float(row.get("previousClose")),
            "change_pct": _safe_float(row.get("percentChange")),
            "currency": "INR",
        }

    rows = data.get("data", [])
    # Pass 1: exact match (case-insensitive)
    for row in rows:
        if row.get("index", "").upper() == target:
            return _row_to_quote(row)
    # Pass 2: space-insensitive match (handles "NIFTY 500" vs "NIFTY500")
    for row in rows:
        if row.get("index", "").upper().replace(" ", "") == target_squashed:
            return _row_to_quote(row)
    # Pass 3: substring — last resort for renamed indices
    for row in rows:
        name = row.get("index", "").upper()
        if target in name or target_squashed in name.replace(" ", ""):
            return _row_to_quote(row)
    return None
