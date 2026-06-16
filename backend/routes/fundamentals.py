"""Financial statements, estimates, capital structure."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
    capital_structure,
    get_estimates,
    get_statement,
    select_rows,
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
