"""Saved multi-pane workspace layouts, per user."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from backend import auth
from backend.storage import get_storage

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class Pane(BaseModel):
    widget: str = Field(..., max_length=30)     # chart|news|valuechain|snapshot|movers
    ticker: str | None = Field(None, max_length=24)


class Layout(BaseModel):
    id: str = Field(..., max_length=60)
    name: str = Field(..., max_length=60)
    panes: list[Pane] = Field(..., max_length=4)
    split: list[float] = Field(default_factory=list)   # pane width fractions


class LayoutsBody(BaseModel):
    layouts: list[Layout] = Field(..., max_length=12)


@router.get("")
def get_layouts(user: dict = Depends(auth.current_user)):
    return get_storage().user_doc("workspaces", user["username"],
                                  {"layouts": []}) or {"layouts": []}


@router.put("")
def put_layouts(body: LayoutsBody, user: dict = Depends(auth.current_user)):
    get_storage().save_user_doc("workspaces", user["username"],
                                body.model_dump())
    return {"ok": True, "count": len(body.layouts)}
