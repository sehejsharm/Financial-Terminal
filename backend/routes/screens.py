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
from pydantic import BaseModel, Field

from backend.schemas import (
    BuffettScreenRequest,
    CustomScreenRequest,
    ETFScreenRequest,
    FilterClause,
    GrahamScreenRequest,
)
from backend.storage import get_storage
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
    import os
    # Low default parallelism: the deploy target is a 1-vCPU/1-GB VM, and 12
    # workers x (NSE + yfinance-with-pandas) per name caused CPU/memory thrash.
    workers = int(os.getenv("SCAN_WORKERS", "4") or 4)
    rows = screens.scan_universe(
        max_workers=workers,
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
                f"metrics have limited coverage on this data plan, so screens "
                f"using them can come up empty — try the 'Large Cap' presets "
                f"(price + market-cap only), or loosen the filter values.")
    return _envelope(matched, scanned=_UNIVERSE_SIZE, evaluable=len(rows),
                     note=note, as_of=scan["as_of"])


@router.post("/custom")
def custom(body: CustomScreenRequest,
           _user: dict = Depends(auth.current_user)):
    bad = [f.key for f in body.filters if f.key not in screens.FIELD_KEYS]
    if bad:
        raise HTTPException(400, f"Unknown field(s): {', '.join(sorted(set(bad)))}")
    bad_ops = [f.op for f in body.filters if f.op not in screens.OPS]
    if bad_ops:
        raise HTTPException(400, f"Unknown operator(s): {', '.join(sorted(set(bad_ops)))}")

    scan = _scan_cached()
    rows = scan["rows"]
    matched = screens.apply_filters(
        rows, [f.model_dump() for f in body.filters],
        match=body.match, sectors=body.sectors)

    # Coverage travels WITH the result. The most confusing screener outcome
    # is a filter on a field the free providers barely populate: it returns
    # nothing, and without this it reads as "no company qualifies" rather
    # than "we don't have that number for most of them".
    used = [f.key for f in body.filters]
    cov = screens.coverage(rows)
    thin = [k for k in used if cov.get(k, 0) < max(1, len(rows) * 0.4)]
    note = None
    if not matched and thin:
        labels = {f["key"]: f["label"] for f in screens.FIELDS}
        note = ("No matches — but " + ", ".join(
            f"{labels.get(k, k)} is only populated for {cov.get(k, 0)} of "
            f"{len(rows)} scanned names" for k in thin)
            + ". A filter on a thinly-covered field excludes everything it "
              "can't evaluate, so try removing it before loosening the others.")

    return _envelope(matched, scanned=_UNIVERSE_SIZE,
                     evaluable=len(rows), note=note, as_of=scan["as_of"])


@router.get("/fields")
def fields(_user: dict = Depends(auth.current_user)):
    """Filterable fields, operators, sectors, and per-field coverage."""
    scan = _scan_cached()
    rows = scan["rows"]
    return {
        "fields": screens.FIELDS,
        "ops": sorted(screens.OPS),
        "sectors": screens.sectors_in(rows),
        "coverage": screens.coverage(rows),
        "evaluable": len(rows),
        "scanned": _UNIVERSE_SIZE,
        "as_of": scan["as_of"],
    }


# ── saved screens ─────────────────────────────────────────────────────────

class SavedScreen(BaseModel):
    id: str = Field(..., max_length=60)
    name: str = Field(..., max_length=60)
    filters: list[FilterClause] = Field(default_factory=list, max_length=12)
    match: str = Field("all", max_length=4)
    sectors: list[str] = Field(default_factory=list, max_length=30)


class SavedScreensBody(BaseModel):
    screens: list[SavedScreen] = Field(..., max_length=25)


@router.get("/saved")
def get_saved(user: dict = Depends(auth.current_user)):
    return get_storage().user_doc("screens", user["username"],
                                  {"screens": []}) or {"screens": []}


@router.put("/saved")
def put_saved(body: SavedScreensBody, user: dict = Depends(auth.current_user)):
    get_storage().save_user_doc("screens", user["username"], body.model_dump())
    return {"ok": True, "count": len(body.screens)}


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
