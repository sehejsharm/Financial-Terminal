"""Big Sharks: NSE bulk + block deals (end-of-day)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from backend import auth
from backend.cache import cached
from backend.serialize import records
from lib.deals import get_block_deals, get_bulk_deals

router = APIRouter(prefix="/deals", tags=["deals"])


@router.get("/bulk")
@cached(ttl=900)
def bulk(_user: dict = Depends(auth.current_user)):
    return records(get_bulk_deals())


@router.get("/block")
@cached(ttl=900)
def block(_user: dict = Depends(auth.current_user)):
    return records(get_block_deals())
