"""Macro: FRED indicators + Treasury yield curve."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from backend.serialize import records
from lib.config import get_fred_key
from lib.macro import get_dashboard
from lib.rates import get_yield_curve

router = APIRouter(prefix="/macro", tags=["macro"])


@router.get("/indicators")
@cached(ttl=3600)
def indicators(_user: dict = Depends(auth.current_user)):
    if not get_fred_key():
        raise HTTPException(503, "No FRED_API_KEY configured on the backend.")
    return get_dashboard()


@router.get("/yield-curve")
@cached(ttl=3600)
def yield_curve(_user: dict = Depends(auth.current_user)):
    if not get_fred_key():
        raise HTTPException(503, "No FRED_API_KEY configured on the backend.")
    return records(get_yield_curve())
