"""Macro: FRED indicators + Treasury yield curve."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from backend.serialize import records
from lib.config import get_fred_key
from lib.macro import COUNTRIES, get_dashboard
from lib.rates import get_yield_curve

router = APIRouter(prefix="/macro", tags=["macro"])


def _with_deadline(fn, seconds: float = 25.0):
    """Run fn with a hard wall-clock deadline.

    Even with per-call timeouts in lib/macro.py, this is the route-level
    backstop: a macro request can never occupy a worker thread indefinitely.
    On timeout the orphaned thread finishes on its own (all inner calls are
    themselves bounded) — we just stop waiting and 504."""
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(fn).result(timeout=seconds)
    except FuturesTimeout:
        raise HTTPException(504, "Macro data source timed out — try again shortly.")
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


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
    return _with_deadline(lambda: get_dashboard(country))


@router.get("/yield-curve")
@cached(ttl=3600)
def yield_curve(_user: dict = Depends(auth.current_user)):
    if not get_fred_key():
        raise HTTPException(503, "No FRED_API_KEY configured on the backend.")
    return records(_with_deadline(get_yield_curve))
