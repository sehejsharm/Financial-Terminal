"""Screens: presets, Buffett, Graham, ETF universe, custom.

Responses are wrapped in a small envelope so the UI can explain *why* a screen
returned nothing (data coverage) instead of a silent blank:

    {"rows": [...], "scanned": 70, "evaluable": 41, "note": "..."}

The scan uses the resilient provider layer (NSE + Twelve Data + yfinance) so
fundamentals populate on cloud IPs where Yahoo blocks us.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth, providers
from backend.cache import cached
from backend.schemas import (
    BuffettScreenRequest,
    CustomScreenRequest,
    ETFScreenRequest,
    GrahamScreenRequest,
)
from lib import screens

router = APIRouter(prefix="/screens", tags=["screens"])

_PRESETS = set(screens.PRESETS.keys())
_UNIVERSE_SIZE = len(screens.SCREEN_UNIVERSE)


def _envelope(rows, scanned, evaluable, note=None):
    return {"rows": rows, "scanned": scanned, "evaluable": evaluable, "note": note}


def _scan():
    """Scan via the provider layer rather than yfinance alone."""
    return screens.scan_universe(fundamentals_fn=providers.snapshot)


@router.get("/preset/{name}")
@cached(ttl=900)
def preset(name: str, _user: dict = Depends(auth.current_user)):
    if name not in _PRESETS:
        raise HTTPException(404, f"Unknown preset '{name}'. "
                                 f"Available: {sorted(_PRESETS)}")
    rows = _scan()
    matched = screens.run_preset(name, rows)
    note = None
    if not matched:
        note = (f"0 of {len(rows)} scanned names matched. Growth / ROCE / PEG "
                f"metrics are often unavailable from free data on cloud hosts — "
                f"set TWELVE_DATA_API_KEY for full fundamentals, or try the "
                f"'Large Cap' presets (price + market-cap only).")
    return _envelope(matched, scanned=_UNIVERSE_SIZE, evaluable=len(rows), note=note)


@router.post("/custom")
def custom(body: CustomScreenRequest,
           _user: dict = Depends(auth.current_user)):
    rows = _scan()
    matched = screens.apply_filters(rows, [f.model_dump() for f in body.filters])
    return _envelope(matched, scanned=_UNIVERSE_SIZE, evaluable=len(rows))


@router.post("/buffett")
def buffett(body: BuffettScreenRequest,
            _user: dict = Depends(auth.current_user)):
    rows = screens.buffett_screen(body.min_score)
    return _envelope(rows, scanned=_UNIVERSE_SIZE, evaluable=None)


@router.post("/graham")
def graham(body: GrahamScreenRequest,
           _user: dict = Depends(auth.current_user)):
    rows = screens.graham_screen(body.growth_default, body.bond_yield,
                                 body.min_mos)
    return _envelope(rows, scanned=_UNIVERSE_SIZE, evaluable=None)


@router.post("/etfs")
def etfs(body: ETFScreenRequest,
         _user: dict = Depends(auth.current_user)):
    rows = screens.etf_screen(body.sort_by, body.sector)
    return _envelope(rows, scanned=len(screens.ETF_UNIVERSE), evaluable=None)
