"""Market data: quote, history, snapshot, search."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend import auth
from backend.cache import cached
from lib import market_data as md
from lib import search as sx

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/search")
def search(q: str = Query(..., min_length=2),
           _user: dict = Depends(auth.current_user)):
    return sx.search_securities(q)


@router.get("/quote/{ticker}")
@cached(ttl=15)
def quote(ticker: str, _user: dict = Depends(auth.current_user)):
    q = md.get_quote(ticker)
    if not q or q.get("price") is None:
        raise HTTPException(404, f"No quote for '{ticker}'")
    return q


@router.get("/history/{ticker}")
@cached(ttl=900)
def history(ticker: str, period: str = "1Y",
            _user: dict = Depends(auth.current_user)):
    df = md.get_history(ticker, period)
    if df is None or df.empty:
        return {"ticker": ticker, "period": period, "candles": []}
    df = df.reset_index()
    df.columns = [str(c) for c in df.columns]
    candles = df.to_dict(orient="records")
    # Coerce timestamp index to ISO for JSON.
    for row in candles:
        for k, v in list(row.items()):
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    return {"ticker": ticker, "period": period, "candles": candles}


@router.get("/snapshot/{ticker}")
@cached(ttl=120)
def snapshot(ticker: str, _user: dict = Depends(auth.current_user)):
    f = md.get_stock_fundamentals(ticker)
    if not f:
        raise HTTPException(404, f"No snapshot for '{ticker}'")
    return f


@router.get("/movers")
@cached(ttl=300)
def movers(kind: str = "gainers", count: int = 8,
           _user: dict = Depends(auth.current_user)):
    return md.get_movers(kind=kind, count=count)
