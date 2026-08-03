"""Market data: quote, history, snapshot, search, movers, news."""
from __future__ import annotations

import time

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


#: A tick this old is still worth serving directly. Above it we go to the
#: provider. 20s is under the fastest market cadence, so a symbol the stream
#: is actively polling always answers from memory.
_LIVE_TICK_MAX_AGE_MS = 20_000


@router.get("/quote-bulk")
def quote_bulk(symbols: str = Query(..., description="Comma-separated tickers"),
               _user: dict = Depends(auth.current_user)):
    """Parallel batch quote, served from the live tick store where possible.

    This endpoint was taking 5–9 seconds, because a cache miss meant a live
    fan-out over up to 30 symbols against providers that answer in
    hundreds of milliseconds each. Meanwhile the streaming ingest loop was
    already polling most of those exact symbols on a timer and holding the
    results in memory — the slow path was re-fetching data the process
    already had.

    So: memory first, provider only for what's missing or stale. Each entry
    carries `as_of` and `age_ms` so the UI can say how old a number is
    rather than implying everything is live.
    """
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    if not syms:
        raise HTTPException(400, "No symbols provided")

    from backend.stream import hub

    now_ms = time.time() * 1000
    out: dict[str, dict | None] = {}
    missing: list[str] = []
    for s in sorted(set(syms)):
        tick = hub.last_tick(s)
        ts = (tick or {}).get("ts")
        age = now_ms - ts if isinstance(ts, (int, float)) else None
        if tick and age is not None and age <= _LIVE_TICK_MAX_AGE_MS:
            ltp, chg = tick.get("ltp"), tick.get("chg")
            out[s] = {
                "symbol": s,
                "price": ltp,
                # The stream carries the change, not the previous close;
                # deriving it here keeps the response shape identical to the
                # provider path so clients need no special case.
                "prev_close": (ltp - chg) if (ltp is not None and chg is not None)
                              else None,
                "change_pct": tick.get("chgPct"),
                "currency": tick.get("ccy"),
                "as_of": ts, "age_ms": round(age), "source": "stream",
            }
        else:
            missing.append(s)

    if missing:
        fetched = _bulk_quotes(tuple(missing))
        for s in missing:
            q = fetched.get(s)
            out[s] = None if not q else {
                **q, "as_of": now_ms, "age_ms": 0, "source": "provider",
            }
    return out


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


@cached(ttl=21600)
def _computed_roe(ticker: str) -> float | None:
    """ROE from our own statements when no provider supplies it.

    Same gap as ROCE, and the same fix: Indian listings are the ones the
    free snapshot APIs most often leave blank, and both ratios are simple
    arithmetic over statements we already fetch. Returns None rather than a
    guess when either side is missing — a blank cell is honest, a made-up
    return on equity is not.
    """
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

        ni = latest(inc, ["Net Income", "NetIncome",
                          "Net Income Common Stockholders"])
        eq = latest(bal, ["Stockholders Equity", "StockholdersEquity",
                          "Total Stockholder Equity",
                          "Common Stock Equity", "Total Equity Gross Minority Interest"])
        # Negative equity makes the ratio meaningless rather than merely
        # negative — a company with a deficit has no "return on equity".
        if ni is not None and eq and eq > 0:
            return ni / eq
    except Exception:
        pass
    return None


@cached(ttl=3600)
def _liquidity(syms: tuple[str, ...], notional: float, participation: float) -> dict:
    from lib import liquidity as lq
    return lq.book(providers.history, list(syms), notional_each=notional,
                   participation=participation, period="3M")


@router.get("/liquidity")
def liquidity(symbols: str = Query(..., description="Comma-separated tickers"),
              notional: float = Query(1e9, gt=0,
                                      description="Position size per name, in the "
                                                  "listing's own currency"),
              participation: float = Query(0.15, gt=0, le=1.0),
              _user: dict = Depends(auth.current_user)):
    """How many sessions it takes to build or exit a position in each name.

    The question a supply-chain screen has to answer before anyone trades on
    it: this analysis says buy the assembler and short the display maker —
    how long does each leg take, and which of these cannot absorb the size
    at all? Derived from the same daily bars the charts use.
    """
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    if not syms:
        raise HTTPException(400, "No symbols provided")
    return _liquidity(tuple(sorted(set(syms))), notional, participation)


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
    if f.get("roe") is None:
        r = _computed_roe(ticker)
        if r is not None:
            f["roe"] = r
            f["roe_source"] = "computed: net income / shareholders' equity"
    return f


@cached(ttl=300)
def _movers(kind: str, count: int, market: str = "IN"):
    """Movers within one market's index constituents.

    "Gainers and losers" is only meaningful relative to a market, and this
    served NIFTY to everyone — so a reader in New York opening the dashboard
    at 9am local was shown an Indian session that closed hours earlier.

    India keeps its NSE fast path (works on cloud IPs where Yahoo blocks us);
    every other market is computed from constituent quotes.

    nse.movers returns None both on error AND on an empty result, so an
    after-hours/empty NSE response falls through to the computation instead of
    caching a blank panel for 5 minutes.
    """
    market = (market or "IN").upper()
    if market == "IN":
        nse_rows = nse.movers(kind=kind, count=count)
        if nse_rows:
            return nse_rows
    try:
        return md.get_movers(kind=kind, count=count,
                             universe=md.movers_universe(market)) or []
    except Exception:
        return []


@router.get("/movers")
def movers(kind: str = "gainers", count: int = 8, market: str = "IN",
           _user: dict = Depends(auth.current_user)):
    rows = _movers(kind, count, market)
    return {
        "market": (market or "IN").upper(),
        "kind": kind,
        "rows": rows,
        # The reader needs to know which names this was ranked WITHIN: a
        # "top gainer" out of thirty constituents is a different claim from
        # one out of the whole exchange.
        "universe": len(md.movers_universe(market)),
    }


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
            # How this item was matched to the requested company: "exact"
            # (qualified symbol or ISIN) or "name" (full company name).
            # Absent on the market-wide wire, which isn't entity-filtered.
            "match": it.get("match"),
        }
        for it in items
    ]


@router.get("/news/{ticker}")
@cached(ttl=300)
def news(ticker: str, limit: int = 15, strict: bool = True,
         _user: dict = Depends(auth.current_user)):
    """Headlines for one listing, filtered to that actual company.

    Returns the filter outcome alongside the items so the UI can say "9
    stories about other companies called Reliance were dropped" rather than
    just showing a short list. `strict=false` returns the unfiltered feed,
    which is the escape hatch when a company's name isn't in the directory.
    """
    items = news_mod.ticker_news(ticker, limit=limit, strict=strict)
    info = news_mod.last_filter(ticker) if strict else {}
    return {
        "ticker": ticker.upper(),
        "items": _news_payload(items),
        "entity": info.get("entity") or None,
        "matched": info.get("kept"),
        "dropped": info.get("dropped"),
        "strict": strict,
    }


@router.get("/news")
@cached(ttl=300)
def market_news(limit: int = 30, _user: dict = Depends(auth.current_user)):
    """Aggregated market headlines (across indices + a few large caps)."""
    return _news_payload(news_mod.market_news(limit=limit))
