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
    return sx.search_securities(q)


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


@router.get("/snapshot/{ticker}")
@cached(ttl=120)
def snapshot(ticker: str, _user: dict = Depends(auth.current_user)):
    f = providers.snapshot(ticker)
    if not f:
        raise HTTPException(404, f"No snapshot for '{ticker}'")
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
