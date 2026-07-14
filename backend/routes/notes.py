"""Per-user, per-ticker research notes (feed the tear-sheet export)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from backend import auth
from backend.storage import get_storage

router = APIRouter(prefix="/notes", tags=["notes"])


class NoteBody(BaseModel):
    text: str = Field("", max_length=20000)


def _doc(username: str) -> dict:
    return get_storage().user_doc("notes", username, {}) or {}


@router.get("/{ticker}")
def get_note(ticker: str, user: dict = Depends(auth.current_user)):
    n = _doc(user["username"]).get(ticker.upper()) or {}
    return {"ticker": ticker.upper(), "text": n.get("text", ""),
            "updated_at": n.get("updated_at")}


@router.put("/{ticker}")
def put_note(ticker: str, body: NoteBody,
             user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    doc[ticker.upper()] = {
        "text": body.text,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    get_storage().save_user_doc("notes", user["username"], doc)
    return {"ok": True, "ticker": ticker.upper()}
