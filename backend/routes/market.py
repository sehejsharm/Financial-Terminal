"""Market data: quote, history, snapshot, search, movers, news."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend import auth
from backend import providers
from backend.cache import cached
from lib import market_data as md
from lib import news as news_mod
from lib import nse
from lib import search as sx

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/search")
def search(q: str = Query(..., min_length=2),
           _user: dict = Depends(auth.current_user)):
    """Ticker/name search: NSE directory matches (name-aware, exchange-
    tagged) merged ahead of the global provider search."""
    from lib.resolve import directory_search
    out = directory_search(q, limit=6)
    seen = {r["symbol"] for r in out}
    for h in sx.search_securities(q):
        if h["symbol"] not in seen:
            out.append(h)
            seen.add(h["symbol"])
    return out[:10]


@router.get("/resolve")
@cached(ttl=600)
def resolve_symbol(q: str = Query(..., min_length=1),
                   _user: dict = Depends(auth.current_user)):
    """Canonical identity resolution (see lib/resolve.py). Every raw ticker
    input funnels through this before any data call."""
    from lib.resolve import resolve
    return resolve(q)


@router.get("/quote/{ticker}")
@cached(ttl=15)
def quote(ticker: str, _user: dict = Depends(auth.current_user)):
    q = providers.quote(ticker)
    if not q or q.get("price") is None:
        raise HTTPException(404, f"No quote for '{ticker}'")
    return q


@cached(ttl=30)
def _bulk_quotes(syms: tuple[str, ...]) -> dict:
    """Cached on the normalized (sorted, deduped) symbol tuple so key order,
    whitespace, and duplicates don't fragment cache entries. The background
    prewarmer refreshes the dashboard set through this same function."""
    return providers.quotes_bulk(list(syms))


@router.get("/quote-bulk")
def quote_bulk(symbols: str = Query(..., description="Comma-separated tickers"),
               _user: dict = Depends(auth.current_user)):
    """Parallel batch quote — single round-trip from the client's view."""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    if not syms:
        raise HTTPException(400, "No symbols provided")
    return _bulk_quotes(tuple(sorted(set(syms))))


@router.get("/history/{ticker}")
@cached(ttl=900)
def history(ticker: str, period: str = "1Y",
            _user: dict = Depends(auth.current_user)):
    candles = providers.history(ticker, period)
    return {"ticker": ticker, "period": period, "candles": candles}


@cached(ttl=21600)
def _computed_roce(ticker: str) -> float | None:
    """ROCE computed from our own statements data (EBIT / capital employed)
    when no provider supplies it — closes the screener/snapshot ROCE gap for
    names whose statements ARE available (mostly yfinance-covered)."""
    try:
        from lib.fundamentals import get_statement
        inc = get_statement(ticker, "income", False)
        bal = get_statement(ticker, "balance", False)
        if inc is None or bal is None or inc.empty or bal.empty:
            return None

        def latest(df, names):
            for n in names:
                if n in df.index:
                    v = df.loc[n].iloc[0]
                    try:
                        v = float(v)
                    except (TypeError, ValueError):
                        continue
                    if v == v:  # not NaN
                        return v
            return None

        ebit = latest(inc, ["EBIT", "Operating Income", "OperatingIncome"])
        ta = latest(bal, ["Total Assets", "TotalAssets"])
        cl = latest(bal, ["Current Liabilities", "Total Current Liabilities",
                          "CurrentLiabilities"])
        if ebit is not None and ta and cl is not None and (ta - cl) > 0:
            return ebit / (ta - cl)
    except Exception:
        pass
    return None


@router.get("/snapshot/{ticker}")
@cached(ttl=120)
def snapshot(ticker: str, _user: dict = Depends(auth.current_user)):
    f = providers.snapshot(ticker)
    if not f:
        raise HTTPException(404, f"No snapshot for '{ticker}'")
    if f.get("roce") is None:
        r = _computed_roce(ticker)
        if r is not None:
            f["roce"] = r
            f["roce_source"] = "computed: EBIT / (total assets − current liabilities)"
    return f


@cached(ttl=300)
def _movers(kind: str, count: int):
    """NIFTY 50 movers — NSE direct (works on cloud IPs) → yfinance fallback.

    nse.movers returns None both on error AND on an empty result, so an
    after-hours/empty NSE response falls through to the yfinance computation
    instead of caching a blank panel for 5 minutes."""
    nse_rows = nse.movers(kind=kind, count=count)
    if nse_rows:
        return nse_rows
    try:
        return md.get_movers(kind=kind, count=count) or []
    except Exception:
        return []


@router.get("/movers")
def movers(kind: str = "gainers", count: int = 8,
           _user: dict = Depends(auth.current_user)):
    return _movers(kind, count)


_TAG_RE = None


def _strip_html(s):
    """Some feeds ship summaries as raw HTML documents
    ("<body><p>STORY: ...</p></body>") — strip tags, unescape entities, and
    collapse whitespace before anything reaches the UI."""
    global _TAG_RE
    if not s or not isinstance(s, str):
        return s
    import html as _html
    import re as _re
    if _TAG_RE is None:
        _TAG_RE = _re.compile(r"<[^>]+>")
    out = _TAG_RE.sub(" ", s)
    out = _html.unescape(out)
    return _re.sub(r"\s+", " ", out).strip()


def _news_payload(items):
    return [
        {
            "title": _strip_html(it.get("title")),
            "publisher": _strip_html(it.get("publisher")),
            "link": it.get("link"),
            "summary": _strip_html(it.get("summary")),
            "published": it["published"].isoformat()
                         if it.get("published") else None,
            # Which feed it came from, as distinct from the outlet named in
            # the item. Google News reports the originating publisher, so
            # without this the UI can't offer a working source filter.
            "source": _strip_html(it.get("source")) or None,
        }
        for it in items
    ]


@router.get("/news/{ticker}")
@cached(ttl=300)
def news(ticker: str, limit: int = 15,
         _user: dict = Depends(auth.current_user)):
    return _news_payload(news_mod.ticker_news(ticker, limit=limit))


@router.get("/news")
@cached(ttl=300)
def market_news(limit: int = 30, _user: dict = Depends(auth.current_user)):
    """Aggregated market headlines (across indices + a few large caps)."""
    return _news_payload(news_mod.market_news(limit=limit))
