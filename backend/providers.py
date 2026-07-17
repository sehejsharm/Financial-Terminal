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
import time
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
    # (interval, outputsize) per period label. Outputsize is the number of
    # bars at that interval covering the window (TD free tier caps at 5000).
    period_map = {
        "1D": ("1min", 390),
        "5D": ("5min", 500),
        "1M": ("1day", 25),
        "3M": ("1day", 70),
        "6M": ("1day", 135),
        "YTD": ("1day", 260),
        "1Y": ("1day", 260),
        "2Y": ("1day", 520),
        "3Y": ("1week", 160),
        "5Y": ("1week", 265),
        "10Y": ("1week", 525),
    }
    interval, outputsize = period_map.get(period, ("1day", 260))
    if period == "YTD":
        # Trading days since Jan 1 (≈5/7 of calendar days), not a fixed year.
        from datetime import datetime
        elapsed = (datetime.now() - datetime(datetime.now().year, 1, 1)).days
        outputsize = max(5, int(elapsed * 5 / 7) + 3)
    try:
        r = _TD_SESSION.get(
            f"{_TD_BASE}/time_series",
            params={
                "symbol": symbol,
                "interval": interval,
                "outputsize": outputsize,
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


# Yahoo uses different symbols than our internal ^CNX* codes for a few NSE
# indices — without this remap the yfinance fallback 404s and the tile stays
# "—" whenever NSE itself misses.
_YF_INDEX_ALIASES = {
    "^CNXMIDCAP": "NIFTY_MIDCAP_100.NS",
    "^CNXSMALLCAP": "NIFTY_SMLCAP_100.NS",
    "^CNX500": "^CRSLDX",
}


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
    q = yf_md.get_quote(_YF_INDEX_ALIASES.get(ticker, ticker))
    if q and ticker in _YF_INDEX_ALIASES:
        q["symbol"] = ticker  # report under the symbol the caller asked for
    return q


def quotes_bulk(tickers: list[str], max_workers: int = 8) -> dict[str, dict | None]:
    """Parallel quote fetch across the configured provider."""
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(quote, tickers))
    return dict(zip(tickers, results))


def snapshot(ticker: str, quota_safe: bool = False) -> dict | None:
    """Fundamentals snapshot. Provider preference (Indian first):

        1. NSE direct  — for .NS / .BO; gives name, sector, P/E, mcap, 52-w.
        2. yfinance    — for everything else, and overlay for non-NSE fields.
        3. Twelve Data — overlay for cloud-IP-resilient stats + live price.

    We layer rather than choose: each provider fills the fields it has, so
    we get the union. Returns None only if we have literally nothing.

    quota_safe=True skips the daily/minute-quota providers (FMP: 3 HTTP calls
    per name against a 250/day budget; Twelve Data: 8 req/min) — required for
    universe scans, where a single 70-name pass through FMP would exhaust the
    whole day's allowance.
    """
    base: dict = {}

    # Fetch all providers concurrently — these are independent network calls and
    # were the dominant cost when run serially (NSE + yfinance + Twelve Data ~5s).
    is_in = nse.is_indian(ticker) and not ticker.startswith("^")
    use_fmp = has_fmp() and not quota_safe
    use_td = has_twelvedata() and not quota_safe
    with ThreadPoolExecutor(max_workers=5) as pool:
        f_nse = pool.submit(nse.snapshot, ticker) if is_in else None
        f_fmp = pool.submit(fmp_snapshot, ticker) if use_fmp else None
        f_yf = pool.submit(yf_md.get_stock_fundamentals, ticker)
        f_td_stats = pool.submit(_td_statistics, ticker) if use_td else None
        f_td_q = pool.submit(_td_quote, ticker) if use_td else None

        def _result(fut):
            if fut is None:
                return None
            try:
                return fut.result(timeout=12)
            except Exception:
                return None

        nse_data = _result(f_nse)
        fmp_data = _result(f_fmp)
        yf_data = _result(f_yf) or {}
        td_stats = _result(f_td_stats)
        td_q = _result(f_td_q)

    if nse_data:
        for k, v in nse_data.items():
            if v is not None:
                base[k] = v

    # FMP is reliable on cloud (covers US + NSE) — fill before flaky yfinance.
    if fmp_data:
        for k, v in fmp_data.items():
            if v is not None and base.get(k) in (None, "", 0):
                base[k] = v

    for k, v in yf_data.items():
        if v is not None and base.get(k) in (None, "", 0):
            base[k] = v

    if has_twelvedata():
        if td_stats:
            for k, v in td_stats.items():
                if v is not None and base.get(k) in (None, "", 0):
                    base[k] = v
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
    """Price history: NSE direct (Indian) → Twelve Data → yfinance.

    Intraday periods (1D/5D) skip NSE's daily-bars API up front and try the
    intraday-capable providers first; NSE dailies remain the last resort so
    Indian names still render something rather than an empty chart."""
    intraday = period in ("1D", "5D")
    is_in = nse.is_indian(ticker) and not ticker.startswith("^")
    if is_in and not intraday:
        candles = nse.history(ticker, period)
        if candles:
            return candles

    if has_twelvedata():
        candles = _td_time_series(ticker, period)
        if candles:
            return candles

    df = yf_md.get_history(ticker, period)
    if (df is None or df.empty) and is_in and intraday:
        daily = nse.history(ticker, period)
        if daily:
            return daily
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


# ── Financial Modeling Prep (FMP) — free statements provider ─────────────────
# yfinance's statement endpoints (.financials/.balance_sheet/.cashflow) are
# blocked from datacenter IPs, and Twelve Data's free tier excludes
# fundamentals. FMP's free tier covers US income/balance/cashflow statements
# (~250 req/day). Set FMP_API_KEY. Indian (.NS) names aren't on FMP free, so
# those fall through to the "unavailable" note (best-effort free).
_FMP_KEY = (os.getenv("FMP_API_KEY") or "").strip() or None
_FMP_BASE = "https://financialmodelingprep.com/stable"

_FMP_PATHS = {
    "income": "income-statement",
    "balance": "balance-sheet-statement",
    "cashflow": "cash-flow-statement",
}

# (display label, [candidate FMP keys in priority order])
_FMP_FIELDS = {
    "income": [
        ("Revenue", ["revenue"]),
        ("Cost of Revenue", ["costOfRevenue"]),
        ("Gross Profit", ["grossProfit"]),
        ("Operating Expenses", ["operatingExpenses"]),
        ("Operating Income", ["operatingIncome"]),
        ("EBITDA", ["ebitda"]),
        ("Pre-Tax Income", ["incomeBeforeTax"]),
        ("Net Income", ["netIncome"]),
        ("EPS (diluted)", ["epsdiluted", "epsDiluted", "eps"]),
    ],
    "balance": [
        ("Cash & Equivalents", ["cashAndCashEquivalents"]),
        ("Total Current Assets", ["totalCurrentAssets"]),
        ("Total Assets", ["totalAssets"]),
        ("Total Current Liabilities", ["totalCurrentLiabilities"]),
        ("Total Debt", ["totalDebt"]),
        ("Total Liabilities", ["totalLiabilities"]),
        ("Shareholders' Equity", ["totalStockholdersEquity"]),
        ("Retained Earnings", ["retainedEarnings"]),
    ],
    "cashflow": [
        ("Net Income", ["netIncome"]),
        ("Operating Cash Flow", ["operatingCashFlow",
                                 "netCashProvidedByOperatingActivities"]),
        ("Capital Expenditure", ["capitalExpenditure"]),
        ("Free Cash Flow", ["freeCashFlow"]),
        ("Dividends Paid", ["dividendsPaid"]),
        ("Net Change in Cash", ["netChangeInCash"]),
    ],
}


def has_fmp() -> bool:
    return _FMP_KEY is not None


def _fmp_get(path: str, params: dict, attempts: int = 3):
    """FMP GET with short backoff on transient failures (5xx / network).

    4xx (bad symbol, quota) is NOT retried — retrying those only burns the
    250/day budget faster. Twelve Data deliberately has no retry layer: its
    free tier is 8 req/min, so retrying a 429 just wastes credits."""
    if not _FMP_KEY:
        return None
    p = dict(params)
    p["apikey"] = _FMP_KEY
    for attempt in range(attempts):
        try:
            r = _TD_SESSION.get(f"{_FMP_BASE}/{path}", params=p, timeout=10)
            if r.status_code >= 500:
                raise RuntimeError(f"FMP {r.status_code}")
            if r.status_code != 200:
                return None
            body = r.json()
            if isinstance(body, dict) and (body.get("Error Message") or body.get("error")):
                return None
            return body
        except Exception:
            if attempt < attempts - 1:
                time.sleep(0.4 * (attempt + 1))
    return None


def _pick(d: dict, keys: list[str]):
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def fmp_statement(symbol: str, kind: str, limit: int = 5,
                  quarterly: bool = False) -> dict | None:
    """FMP statement -> {columns, rows} matching the frontend shape, or None.

    Returns None on any failure (no key, non-US symbol, quota) so the caller
    can fall back to the honest 'unavailable' note without a regression.
    """
    path = _FMP_PATHS.get(kind)
    if not path:
        return None
    period = "quarter" if quarterly else "annual"
    data = _fmp_get(path, {"symbol": symbol, "limit": limit, "period": period})
    if not isinstance(data, list) or not data:
        return None
    periods = [str(d.get("date") or d.get("calendarYear") or i)
               for i, d in enumerate(data)]
    rows = []
    for label, keys in _FMP_FIELDS[kind]:
        vals = [_pick(d, keys) for d in data]
        if all(v is None for v in vals):
            continue
        row = {"line": label}
        for per, v in zip(periods, vals):
            row[per] = float(v) if isinstance(v, (int, float)) else None
        rows.append(row)
    if not rows:
        return None
    return {"columns": periods, "rows": rows}


def fmp_price_target(symbol: str) -> dict | None:
    """FMP analyst price-target consensus -> {low, mean, median, high} or None.
    Often premium even on FMP free; returns None gracefully when unavailable."""
    data = _fmp_get("price-target-consensus", {"symbol": symbol})
    rec = None
    if isinstance(data, list) and data:
        rec = data[0]
    elif isinstance(data, dict):
        rec = data
    if not rec:
        return None
    out = {
        "low": rec.get("targetLow"),
        "mean": rec.get("targetConsensus") or rec.get("targetMedian"),
        "median": rec.get("targetMedian"),
        "high": rec.get("targetHigh"),
    }
    return out if any(v is not None for v in out.values()) else None


def fmp_snapshot(symbol: str) -> dict | None:
    """Reliable fundamentals snapshot from FMP (profile + ratios-ttm).

    FMP's free tier covers US *and* many international names incl. NSE (.NS),
    so this replaces the flaky yfinance `.info` scrape that Yahoo blocks from
    cloud IPs. Returns a yfinance-compatible dict (matching the units the
    frontend expects) or None.
    """
    prof = _fmp_get("profile", {"symbol": symbol})
    if isinstance(prof, list) and prof:
        prof = prof[0]
    if not isinstance(prof, dict):
        return None
    out: dict = {}
    out["name"] = prof.get("companyName") or symbol
    out["sector"] = prof.get("sector") or None
    out["industry"] = prof.get("industry") or None
    out["market_cap"] = prof.get("marketCap")
    out["beta"] = prof.get("beta")
    out["price"] = prof.get("price")
    out["currency"] = prof.get("currency")
    ch = prof.get("change")
    if isinstance(prof.get("price"), (int, float)) and isinstance(ch, (int, float)):
        out["prev_close"] = prof["price"] - ch
    rng = prof.get("range")
    if isinstance(rng, str) and "-" in rng:
        try:
            lo, hi = rng.split("-", 1)
            out["fifty_two_low"] = float(lo)
            out["fifty_two_high"] = float(hi)
        except Exception:
            pass

    r = _fmp_get("ratios-ttm", {"symbol": symbol})
    if isinstance(r, list) and r:
        r = r[0]
    if isinstance(r, dict):
        pe = _pick(r, ["priceToEarningsRatioTTM", "peRatioTTM"])
        if pe is not None:
            out["trailing_pe"] = pe
        cr = _pick(r, ["currentRatioTTM"])
        if cr is not None:
            out["current_ratio"] = cr
        qr = _pick(r, ["quickRatioTTM"])
        if qr is not None:
            out["quick_ratio"] = qr
        pm = _pick(r, ["netProfitMarginTTM"])
        if pm is not None:
            out["profit_margin"] = pm             # fraction; frontend x100
        de = _pick(r, ["debtToEquityRatioTTM", "debtToEquityTTM"])
        if de is not None:
            out["debt_to_equity"] = de * 100      # match yfinance %-scale
        dy = _pick(r, ["dividendYieldTTM"])
        if dy is not None:
            out["dividend_yield"] = dy * 100      # percent

    # ROE/ROCE are exposed via key-metrics-ttm (not ratios-ttm) on FMP's
    # stable API. ROCE here is FMP's real Return on Capital Employed — never
    # alias ROE into it (they differ materially, esp. banks vs manufacturers).
    km = _fmp_get("key-metrics-ttm", {"symbol": symbol})
    if isinstance(km, list) and km:
        km = km[0]
    if isinstance(km, dict):
        roe = _pick(km, ["returnOnEquityTTM"])
        if roe is not None:
            out["roe"] = roe                      # fraction; frontend x100
        roce = _pick(km, ["returnOnCapitalEmployedTTM"])
        if roce is not None:
            out["roce"] = roce                    # fraction; consumers x100

    clean = {k: v for k, v in out.items() if v is not None}
    return clean or None


def fmp_capital(symbol: str) -> dict | None:
    """Capital structure from FMP (balance sheet + profile). US coverage on the
    free tier; returns None for names FMP doesn't cover (e.g. .NS) so the caller
    falls back gracefully."""
    bs = _fmp_get("balance-sheet-statement", {"symbol": symbol, "limit": 1})
    if isinstance(bs, list) and bs:
        bs = bs[0]
    if not isinstance(bs, dict):
        return None
    prof = _fmp_get("profile", {"symbol": symbol})
    if isinstance(prof, list) and prof:
        prof = prof[0]
    prof = prof if isinstance(prof, dict) else {}
    out = {
        "total_debt": bs.get("totalDebt"),
        "cash": _pick(bs, ["cashAndCashEquivalents", "cashAndShortTermInvestments"]),
        "market_cap": prof.get("marketCap"),
        "shares": _pick(bs, ["weightedAverageShsOut", "commonStock"]),
        "currency": prof.get("currency") or bs.get("reportedCurrency") or "USD",
    }
    if out["total_debt"] is None and out["market_cap"] is None:
        return None
    return out
