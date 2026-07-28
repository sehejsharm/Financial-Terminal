"""Saved multi-pane workspace layouts, per user.

v2 introduced a tiling grid (rows of panes) and link groups. v1 layouts were
a single flat list of panes with width fractions. Both shapes are accepted:
the extra v2 fields are optional and the legacy `panes`/`split` fields are
still permitted, so a client that hasn't reloaded yet keeps working and an
old saved document still round-trips. The frontend's normalize() does the
actual migration on read.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from backend import auth
from backend.storage import get_storage

router = APIRouter(prefix="/workspaces", tags=["workspaces"])

# Mirrors the frontend caps (lib/workspace.ts). Kept in sync deliberately:
# the server is the last line of defence against a hand-crafted document
# that would render thousands of panes.
MAX_ROWS = 4
MAX_PANES_PER_ROW = 4
MAX_LAYOUTS = 12


class Pane(BaseModel):
    id: str | None = Field(None, max_length=60)
    widget: str = Field(..., max_length=30)
    ticker: str | None = Field(None, max_length=24)
    # "none" | "A" | "B" | "C" | "D". Not an enum so a future group can be
    # added client-side without a server deploy; the client validates it.
    link: str | None = Field(None, max_length=8)


class Row(BaseModel):
    id: str | None = Field(None, max_length=60)
    panes: list[Pane] = Field(..., max_length=MAX_PANES_PER_ROW)
    split: list[float] = Field(default_factory=list)
    height: float = 1.0


class Layout(BaseModel):
    id: str = Field(..., max_length=60)
    name: str = Field(..., max_length=60)
    version: int | None = None
    rows: list[Row] = Field(default_factory=list, max_length=MAX_ROWS)
    # Ticker per link group, e.g. {"A": "RELIANCE.NS"}.
    groups: dict[str, str] = Field(default_factory=dict)

    # ── legacy v1 fields, still accepted so old clients/documents survive ──
    panes: list[Pane] = Field(default_factory=list, max_length=8)
    split: list[float] = Field(default_factory=list)


class LayoutsBody(BaseModel):
    layouts: list[Layout] = Field(..., max_length=MAX_LAYOUTS)
    # Which layout to restore on next login. Optional so a v1 client that
    # omits it doesn't clear the user's choice.
    active_id: str | None = Field(None, max_length=60)


@router.get("")
def get_layouts(user: dict = Depends(auth.current_user)):
    return get_storage().user_doc("workspaces", user["username"],
                                  {"layouts": [], "active_id": None}) \
        or {"layouts": [], "active_id": None}


@router.put("")
def put_layouts(body: LayoutsBody, user: dict = Depends(auth.current_user)):
    doc = body.model_dump(exclude_none=False)
    # Drop empty legacy fields so v2 documents don't carry dead weight.
    for layout in doc.get("layouts", []):
        if not layout.get("panes"):
            layout.pop("panes", None)
            layout.pop("split", None)
    get_storage().save_user_doc("workspaces", user["username"], doc)
    return {"ok": True, "count": len(body.layouts)}
