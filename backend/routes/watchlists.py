"""Per-user named watchlists (CRUD)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.schemas import Watchlist, WatchlistCreate
from backend.storage import get_storage

router = APIRouter(prefix="/watchlists", tags=["watchlists"])


@router.get("", response_model=list[Watchlist])
def list_all(user: dict = Depends(auth.current_user)):
    return get_storage().watchlists_for(user["username"])


@router.post("", response_model=Watchlist, status_code=201)
def create(body: WatchlistCreate, user: dict = Depends(auth.current_user)):
    wl = {"id": str(uuid.uuid4()),
          "name": body.name.strip() or "Untitled",
          "tickers": [t.strip().upper() for t in body.tickers if t.strip()]}
    return get_storage().upsert_watchlist(user["username"], wl)


@router.put("/{wl_id}", response_model=Watchlist)
def update(wl_id: str, body: WatchlistCreate,
           user: dict = Depends(auth.current_user)):
    existing = next((w for w in get_storage().watchlists_for(user["username"])
                     if w.get("id") == wl_id), None)
    if not existing:
        raise HTTPException(404, "Watchlist not found")
    wl = {"id": wl_id, "name": body.name.strip() or existing["name"],
          "tickers": [t.strip().upper() for t in body.tickers if t.strip()]}
    return get_storage().upsert_watchlist(user["username"], wl)


@router.delete("/{wl_id}", status_code=204)
def delete(wl_id: str, user: dict = Depends(auth.current_user)):
    if not get_storage().delete_watchlist(user["username"], wl_id):
        raise HTTPException(404, "Watchlist not found")
