"""Screens: presets, Buffett, Graham, ETF universe, custom."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
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


@router.get("/preset/{name}")
@cached(ttl=900)
def preset(name: str, _user: dict = Depends(auth.current_user)):
    if name not in _PRESETS:
        raise HTTPException(404, f"Unknown preset '{name}'. "
                                 f"Available: {sorted(_PRESETS)}")
    rows = screens.scan_universe()
    return screens.run_preset(name, rows)


@router.post("/custom")
def custom(body: CustomScreenRequest,
           _user: dict = Depends(auth.current_user)):
    rows = screens.scan_universe()
    return screens.apply_filters(rows, [f.model_dump() for f in body.filters])


@router.post("/buffett")
def buffett(body: BuffettScreenRequest,
            _user: dict = Depends(auth.current_user)):
    return screens.buffett_screen(body.min_score)


@router.post("/graham")
def graham(body: GrahamScreenRequest,
           _user: dict = Depends(auth.current_user)):
    return screens.graham_screen(body.growth_default, body.bond_yield,
                                 body.min_mos)


@router.post("/etfs")
def etfs(body: ETFScreenRequest,
         _user: dict = Depends(auth.current_user)):
    return screens.etf_screen(body.sort_by, body.sector)
