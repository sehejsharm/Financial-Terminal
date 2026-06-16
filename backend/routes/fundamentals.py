"""Financial statements, estimates, capital structure, comps, ownership, ratings."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend import auth
from backend.cache import cached
from backend.serialize import clean_dict, frame_payload, records
from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
    capital_structure,
    get_estimates,
    get_statement,
    select_rows,
)
from lib.institutional import (
    comps_matrix,
    get_earnings_history,
    get_officers,
    get_ownership,
    get_ratings,
)

router = APIRouter(prefix="/fundamentals", tags=["fundamentals"])

_KINDS = {"income": INCOME_ROWS, "balance": BALANCE_ROWS, "cashflow": CASHFLOW_ROWS}


@router.get("/{ticker}/statement/{kind}")
@cached(ttl=3600)
def statement(ticker: str, kind: str, quarterly: bool = False,
              _user: dict = Depends(auth.current_user)):
    if kind not in _KINDS:
        raise HTTPException(400, "kind must be one of income|balance|cashflow")
    df = select_rows(get_statement(ticker, kind, quarterly), _KINDS[kind])
    if df.empty:
        return {"ticker": ticker, "kind": kind, "rows": [], "columns": []}
    return {
        "ticker": ticker, "kind": kind, "quarterly": quarterly,
        "columns": [str(c) for c in df.columns],
        "rows": [{"line": idx, **{str(c): (None if v is None else float(v))
                                   for c, v in row.items()}}
                 for idx, row in df.iterrows()],
    }


@router.get("/{ticker}/estimates")
@cached(ttl=3600)
def estimates(ticker: str, _user: dict = Depends(auth.current_user)):
    return get_estimates(ticker)


@router.get("/{ticker}/capital-structure")
@cached(ttl=3600)
def cap_structure(ticker: str, _user: dict = Depends(auth.current_user)):
    return capital_structure(ticker)


@router.get("/comps")
@cached(ttl=900)
def comps(tickers: str = Query(..., description="Comma-separated peer tickers"),
          _user: dict = Depends(auth.current_user)):
    ts = [t.strip().upper() for t in tickers.split(",") if t.strip()][:10]
    if not ts:
        raise HTTPException(400, "No tickers provided")
    return records(comps_matrix(ts))


@router.get("/{ticker}/ownership")
@cached(ttl=3600)
def ownership(ticker: str, _user: dict = Depends(auth.current_user)):
    own = get_ownership(ticker)
    return {
        "major_holders": frame_payload(own.get("major_holders")),
        "institutional_holders": frame_payload(own.get("institutional_holders")),
        "mutualfund_holders": frame_payload(own.get("mutualfund_holders")),
        "officers": [
            {"name": o.get("name"), "title": o.get("title"),
             "pay": o.get("pay"), "age": o.get("age")}
            for o in get_officers(ticker)
        ],
    }


@router.get("/{ticker}/earnings-history")
@cached(ttl=3600)
def earnings_history(ticker: str, _user: dict = Depends(auth.current_user)):
    return frame_payload(get_earnings_history(ticker))


@router.get("/{ticker}/ratings")
@cached(ttl=3600)
def ratings(ticker: str, _user: dict = Depends(auth.current_user)):
    r = get_ratings(ticker)
    return {
        "targets": clean_dict(r.get("targets") if isinstance(r.get("targets"), dict) else {}),
        "recommendations": frame_payload(r.get("recommendations")),
    }
