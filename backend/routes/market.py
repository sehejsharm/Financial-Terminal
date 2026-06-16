"""Market data: quote, history, snapshot, search."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend import auth
from backend import providers
from backend.cache import cached
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

@router.get("/quote-bulk")
@cached(ttl=15)
def quote_bulk(symbols: str = Query(..., description="Comma-separated tickers"),
                              _user: dict = Depends(auth.current_user)):
                                             """Parallel batch quote — single round-trip from the client's view."""
                                             syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
                                             if not syms:
                                                                raise HTTPException(400, "No symbols provided")
                                                            return providers.quotes_bulk(syms)

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

@router.get("/movers")
@cached(ttl=300)
def movers(kind: str = "gainers", count: int = 8,
                      _user: dict = Depends(auth.current_user)):
                                     from lib import market_data as md
    return md.get_movers(kind=kind, count=count)
