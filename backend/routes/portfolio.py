"""Portfolio tracking — positions CRUD + live P&L / allocation summary.

A lightweight open take on Bloomberg's PORT: log real positions (ticker,
quantity, cost basis) and get live P&L, sector/concentration breakdown, and
weighted factor exposure (beta, dividend yield) from the existing provider
layer. Positions live in the per-user JSON doc store on the data volume.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend import auth, providers
from backend.cache import cached
from backend.storage import get_storage

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


class PositionCreate(BaseModel):
    ticker: str = Field(..., max_length=24)
    qty: float = Field(..., gt=0)
    cost: float = Field(..., ge=0, description="Cost basis per share")


def _doc(username: str) -> dict:
    return get_storage().user_doc("portfolios", username, {"positions": []}) \
        or {"positions": []}


@router.get("")
def get_portfolio(user: dict = Depends(auth.current_user)):
    return _doc(user["username"])


@router.post("/positions", status_code=201)
def add_position(body: PositionCreate, user: dict = Depends(auth.current_user)):
    from lib.resolve import canonicalize
    raw = body.ticker.strip().upper()
    doc = _doc(user["username"])
    pos = {"id": str(uuid.uuid4()), "ticker": canonicalize(raw) or raw,
           "qty": body.qty, "cost": body.cost}
    doc["positions"].append(pos)
    get_storage().save_user_doc("portfolios", user["username"], doc)
    return pos


@router.delete("/positions/{pos_id}", status_code=204)
def delete_position(pos_id: str, user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    before = len(doc["positions"])
    doc["positions"] = [p for p in doc["positions"] if p.get("id") != pos_id]
    if len(doc["positions"]) == before:
        raise HTTPException(404, "Position not found")
    get_storage().save_user_doc("portfolios", user["username"], doc)


@cached(ttl=600)
def _pos_meta(ticker: str) -> dict:
    """Sector/beta/yield for a position — quota_safe (no FMP/TD burn), cached
    10 min so summary refreshes stay cheap."""
    s = providers.snapshot(ticker, quota_safe=True) or {}
    return {"name": s.get("name") or ticker, "sector": s.get("sector"),
            "beta": s.get("beta"), "dividend_yield": s.get("dividend_yield")}


@router.get("/summary")
def summary(user: dict = Depends(auth.current_user)):
    """Live P&L + allocation. Quotes come from the shared cached bulk path."""
    doc = _doc(user["username"])
    positions = doc["positions"]
    if not positions:
        return {"positions": [], "totals": None, "sectors": [], "factors": None}

    tickers = sorted({p["ticker"] for p in positions})
    quotes = providers.quotes_bulk(tickers)

    rows, total_value, total_cost, total_day = [], 0.0, 0.0, 0.0
    for p in positions:
        q = quotes.get(p["ticker"]) or {}
        price = q.get("price")
        prev = q.get("prev_close")
        meta = _pos_meta(p["ticker"])
        value = price * p["qty"] if price is not None else None
        cost_total = p["cost"] * p["qty"]
        pnl = (value - cost_total) if value is not None else None
        day = ((price - prev) * p["qty"]) if (price is not None and prev is not None) else None
        rows.append({
            **p, "name": meta["name"], "sector": meta["sector"],
            "beta": meta["beta"], "dividend_yield": meta["dividend_yield"],
            "price": price, "value": value, "pnl": pnl,
            "pnl_pct": (pnl / cost_total * 100) if (pnl is not None and cost_total) else None,
            "day_pnl": day, "currency": q.get("currency"),
        })
        if value is not None:
            total_value += value
            total_cost += cost_total
        if day is not None:
            total_day += day

    for r in rows:
        r["weight"] = (r["value"] / total_value * 100) if (r["value"] and total_value) else None

    # Sector allocation + weighted factor exposure over priced positions.
    sectors: dict[str, float] = {}
    wbeta = wyield = wsum = 0.0
    for r in rows:
        if not r["value"]:
            continue
        sectors[r["sector"] or "Unknown"] = sectors.get(r["sector"] or "Unknown", 0) + r["value"]
        if r["beta"] is not None:
            wbeta += r["beta"] * r["value"]
        if r["dividend_yield"] is not None:
            wyield += r["dividend_yield"] * r["value"]
        wsum += r["value"]

    return {
        "positions": rows,
        "totals": {
            "value": total_value, "cost": total_cost,
            "pnl": total_value - total_cost,
            "pnl_pct": ((total_value - total_cost) / total_cost * 100) if total_cost else None,
            "day_pnl": total_day,
        },
        "sectors": sorted(
            [{"sector": s, "value": v, "weight": v / total_value * 100}
             for s, v in sectors.items()],
            key=lambda x: -x["value"]),
        "factors": {
            "beta": (wbeta / wsum) if wsum else None,
            "dividend_yield": (wyield / wsum) if wsum else None,
            "top_weight": max((r["weight"] or 0) for r in rows) if rows else None,
        },
    }
