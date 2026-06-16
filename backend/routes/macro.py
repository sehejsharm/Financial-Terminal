"""Macro: FRED indicators + Treasury yield curve."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from backend.serialize import records
from lib.config import get_fred_key
from lib.macro import COUNTRIES, get_dashboard
from lib.rates import get_yield_curve

router = APIRouter(prefix="/macro", tags=["macro"])


@router.get("/countries")
def countries(_user: dict = Depends(auth.current_user)):
    return COUNTRIES


@router.get("/indicators")
@cached(ttl=3600)
def indicators(country: str = "US",
               _user: dict = Depends(auth.current_user)):
    if not get_fred_key():
        raise HTTPException(503, "No FRED_API_KEY configured on the backend.")
    if country not in COUNTRIES:
        raise HTTPException(400, f"Unknown country '{country}'. Use one of: {COUNTRIES}")
    return get_dashboard(country)


@router.get("/yield-curve")
@cached(ttl=3600)
def yield_curve(_user: dict = Depends(auth.current_user)):
    if not get_fred_key():
        raise HTTPException(503, "No FRED_API_KEY configured on the backend.")
    return records(get_yield_curve())
