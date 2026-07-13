"""Screens: presets, Buffett, Graham, ETF universe, custom.

Responses are wrapped in a small envelope so the UI can explain *why* a screen
returned nothing (data coverage) instead of a silent blank:

    {"rows": [...], "scanned": 70, "evaluable": 41, "note": "..."}

The scan uses the resilient provider layer (NSE + Twelve Data + yfinance) so
fundamentals populate on cloud IPs where Yahoo blocks us.
"""
from __future__ import annotations

from datetime import datetime, timezone

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


def _envelope(rows, scanned, evaluable, note=None, as_of=None):
    return {"rows": rows, "scanned": scanned, "evaluable": evaluable,
            "note": note, "as_of": as_of}


@cached(ttl=600)
def _scan_cached() -> dict:
    """One shared universe scan for all presets + custom screens.

    Previously each preset cached its own copy AND custom screens were
    uncached, so every cache miss re-fetched the whole ~70-name universe
    (~13 s). Now the expensive part is computed once, refreshed by the
    background prewarmer, and preset/custom filtering is pure Python over
    the cached rows (<10 ms).

    quota_safe: the scan skips FMP/Twelve Data — one pass through FMP is
    3 HTTP calls x 70 names against a 250/day free budget. NSE covers the
    market-cap/P-E presets on cloud hosts; growth metrics fill in where
    yfinance is reachable.
    """
    rows = screens.scan_universe(
        fundamentals_fn=lambda t: providers.snapshot(t, quota_safe=True))
    return {"rows": rows,
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds")}


@router.get("/preset/{name}")
def preset(name: str, _user: dict = Depends(auth.current_user)):
    if name not in _PRESETS:
        raise HTTPException(404, f"Unknown preset '{name}'. "
                                 f"Available: {sorted(_PRESETS)}")
    scan = _scan_cached()
    rows = scan["rows"]
    matched = screens.run_preset(name, rows)
    note = None
    if not matched:
        note = (f"0 of {len(rows)} scanned names matched. Growth / ROCE / PEG "
                f"metrics are often unavailable from free data on cloud hosts — "
                f"set TWELVE_DATA_API_KEY for full fundamentals, or try the "
                f"'Large Cap' presets (price + market-cap only).")
    return _envelope(matched, scanned=_UNIVERSE_SIZE, evaluable=len(rows),
                     note=note, as_of=scan["as_of"])


@router.post("/custom")
def custom(body: CustomScreenRequest,
           _user: dict = Depends(auth.current_user)):
    scan = _scan_cached()
    matched = screens.apply_filters(scan["rows"],
                                    [f.model_dump() for f in body.filters])
    return _envelope(matched, scanned=_UNIVERSE_SIZE,
                     evaluable=len(scan["rows"]), as_of=scan["as_of"])


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
