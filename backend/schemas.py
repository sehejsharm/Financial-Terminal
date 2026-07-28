"""Pydantic request/response models for /api/v1.

Kept intentionally small — most endpoints take query/path params and return
dicts/lists from lib/* unchanged. We model only the bodies that need shape.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


# ── auth ─────────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: str
    role: str


class MeResponse(BaseModel):
    username: str
    role: str


# ── screens ──────────────────────────────────────────────────────────────────
class FilterClause(BaseModel):
    key: str = Field(..., max_length=32)
    op: str = Field(">", max_length=8)
    value: float | None = None
    # Second bound, used only by the "between" operator.
    value2: float | None = None


class CustomScreenRequest(BaseModel):
    filters: list[FilterClause] = Field(default_factory=list, max_length=12)
    # "all" = every clause must pass (AND); "any" = at least one (OR).
    match: str = Field("all", max_length=4)
    sectors: list[str] = Field(default_factory=list, max_length=30)


class GrahamScreenRequest(BaseModel):
    growth_default: float = 8.0
    bond_yield: float = 7.0
    min_mos: float = 20.0


class BuffettScreenRequest(BaseModel):
    min_score: int = 70


class ETFScreenRequest(BaseModel):
    sort_by: str = "ytd_return"
    sector: str | None = None


# ── AI ───────────────────────────────────────────────────────────────────────
class AIRequest(BaseModel):
    ticker: str


# ── watchlists ───────────────────────────────────────────────────────────────
class Watchlist(BaseModel):
    id: str
    name: str
    tickers: list[str]


class WatchlistCreate(BaseModel):
    name: str
    tickers: list[str] = []


# ── admin ────────────────────────────────────────────────────────────────────
class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"
