"""DAPI — read-only data API with an Excel/Sheets bridge.

Two endpoints modelled on the spreadsheet functions people actually use:

    BDP  /api/v1/data/bdp?tickers=A,B&fields=price,pe_ratio   — one row per
         ticker, current values.
    BDH  /api/v1/data/bdh?ticker=A&period=1Y                  — historical
         time series.

Both emit CSV by default so `=IMPORTDATA(...)` in Google Sheets or Excel's
Get Data → From Web ingest them directly, with `&format=json` for code.

AUTH. A browser JWT expires in minutes, which is useless to a spreadsheet
that refreshes on its own. So this accepts a long-lived personal API token
instead — and because a long-lived credential is a real exposure, it is
deliberately constrained:

  * read-only: these endpoints are the ONLY ones that accept it. Every other
    route still requires the JWT, so a leaked token cannot place an alert,
    touch a portfolio, or reach the admin surface.
  * hashed at rest (SHA-256). The plaintext is shown exactly once, at
    creation, and cannot be recovered afterwards.
  * revocable individually, with last-used timestamps so an unused token is
    visibly safe to delete.
  * a visible prefix (mb_live_XXXXXXXX…) so a token found in a spreadsheet or
    a log can be identified and revoked without guessing which one it is.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from backend import auth
from backend.cache import cached
from backend.storage import get_storage

router = APIRouter(prefix="/data", tags=["data-api"])

_TOKEN_PREFIX = "mb_live_"
MAX_TOKENS = 10
MAX_TICKERS = 25
MAX_FIELDS = 20


# ── token store ────────────────────────────────────────────────────────────

def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _doc(username: str) -> dict:
    return get_storage().user_doc("api_tokens", username, {"tokens": []}) \
        or {"tokens": []}


def _save(username: str, doc: dict) -> None:
    get_storage().save_user_doc("api_tokens", username, doc)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class TokenCreate(BaseModel):
    label: str = Field("", max_length=60)


@router.get("/tokens")
def list_tokens(user: dict = Depends(auth.current_user)):
    """Token metadata only — the secrets themselves are unrecoverable."""
    doc = _doc(user["username"])
    return [{"id": t["id"], "label": t.get("label", ""),
             "prefix": t.get("prefix", ""), "created_at": t.get("created_at"),
             "last_used_at": t.get("last_used_at")}
            for t in doc.get("tokens", [])]


@router.post("/tokens", status_code=201)
def create_token(body: TokenCreate, user: dict = Depends(auth.current_user)):
    """Mint a token. The plaintext in this response is the ONLY copy."""
    doc = _doc(user["username"])
    tokens = doc.setdefault("tokens", [])
    if len(tokens) >= MAX_TOKENS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Token limit reached ({MAX_TOKENS}). Revoke one first.")
    raw = _TOKEN_PREFIX + secrets.token_urlsafe(32)
    rec = {
        "id": secrets.token_hex(8),
        "label": body.label.strip(),
        # Enough to identify it in a spreadsheet, far too little to use.
        "prefix": raw[:len(_TOKEN_PREFIX) + 6],
        "hash": _hash_token(raw),
        "created_at": _now(),
        "last_used_at": None,
    }
    tokens.append(rec)
    _save(user["username"], doc)
    return {"id": rec["id"], "label": rec["label"], "prefix": rec["prefix"],
            "created_at": rec["created_at"], "token": raw,
            "note": "Copy this now — it is hashed at rest and cannot be shown again."}


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_token(token_id: str, user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    before = len(doc.get("tokens", []))
    doc["tokens"] = [t for t in doc.get("tokens", []) if t["id"] != token_id]
    if len(doc["tokens"]) == before:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Token not found")
    _save(user["username"], doc)


def _find_token(raw: str) -> tuple[str, dict] | None:
    """Locate (username, record) for a plaintext token.

    Linear over users because the store is a small JSON document; the hash
    comparison itself is constant-time-ish via compare_digest so a timing
    signal can't be used to guess a token.
    """
    from lib import auth as user_store
    want = _hash_token(raw)
    for username in user_store._load().get("users", {}):
        doc = _doc(username)
        for rec in doc.get("tokens", []):
            if secrets.compare_digest(rec.get("hash", ""), want):
                return username, rec
    return None


def api_token_user(request: Request) -> dict:
    """Auth dependency for the data endpoints: personal API token OR the
    normal browser JWT, so the same URLs work from a spreadsheet and from a
    logged-in session."""
    header = request.headers.get("authorization") or ""
    raw = ""
    if header.lower().startswith("bearer "):
        raw = header[7:].strip()
    # Spreadsheet tools often can't set headers at all, so a query parameter
    # is supported too. It's the weaker path (URLs land in logs and browser
    # history), which is why tokens are revocable and read-only.
    raw = raw or (request.query_params.get("token") or "").strip()
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Missing API token or bearer credential")

    if raw.startswith(_TOKEN_PREFIX):
        hit = _find_token(raw)
        if not hit:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API token")
        username, rec = hit
        rec["last_used_at"] = _now()
        doc = _doc(username)
        for t in doc.get("tokens", []):
            if t["id"] == rec["id"]:
                t["last_used_at"] = rec["last_used_at"]
        _save(username, doc)
        return {"username": username, "role": "user", "via": "api_token"}

    claims = auth.decode_token(raw)
    if not claims:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    return {**claims, "via": "jwt"}


# ── CSV helpers ────────────────────────────────────────────────────────────

def csv_escape(v) -> str:
    """RFC4180 quoting. A company name containing a comma must not shift
    every subsequent column one to the left in the user's spreadsheet."""
    if v is None:
        return ""
    s = str(v)
    if any(c in s for c in (',', '"', "\n", "\r")):
        return '"' + s.replace('"', '""') + '"'
    return s


def to_csv(headers: list[str], rows: list[list]) -> str:
    out = [",".join(csv_escape(h) for h in headers)]
    out.extend(",".join(csv_escape(c) for c in r) for r in rows)
    return "\n".join(out)


# ── BDP: current values ────────────────────────────────────────────────────

# Whitelisted so a typo returns an empty column rather than leaking whatever
# key happens to exist in a provider payload.
BDP_FIELDS = {
    "name", "sector", "industry", "currency", "price", "previous_close",
    "change_pct", "market_cap", "enterprise_value", "pe_ratio", "forward_pe",
    "pb_ratio", "ps_ratio", "ev_ebitda", "dividend_yield", "beta",
    "profit_margin", "operating_margin", "gross_margin", "roe", "roa", "roce",
    "revenue", "revenue_growth", "earnings_growth", "ebitda", "free_cashflow",
    "total_debt", "total_cash", "debt_to_equity", "current_ratio",
    "shares_outstanding", "volume", "avg_volume",
    "fifty_two_week_high", "fifty_two_week_low", "target_mean_price",
}
DEFAULT_BDP_FIELDS = ["name", "price", "currency", "change_pct", "market_cap",
                      "pe_ratio", "dividend_yield"]


@cached(ttl=60)
def _bdp_row(ticker: str) -> dict:
    from lib.market_data import get_stock_fundamentals
    try:
        return get_stock_fundamentals(ticker) or {}
    except Exception:
        return {}


@router.get("/bdp")
def bdp(tickers: str = Query(..., description="Comma-separated tickers"),
        fields: str = Query("", description="Comma-separated field names"),
        format: str = Query("csv", pattern="^(csv|json)$"),
        user: dict = Depends(api_token_user)):
    """Current values, one row per ticker — the BDP() equivalent."""
    syms = [t.strip().upper() for t in tickers.split(",") if t.strip()][:MAX_TICKERS]
    if not syms:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No tickers given")
    want = [f.strip().lower() for f in fields.split(",") if f.strip()][:MAX_FIELDS] \
        or DEFAULT_BDP_FIELDS
    unknown = [f for f in want if f not in BDP_FIELDS]
    cols = [f for f in want if f in BDP_FIELDS]
    if not cols:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"No known fields requested. Unknown: {', '.join(unknown)}. "
            f"See /api/v1/data/fields for the list.")

    rows = []
    for s in syms:
        f = _bdp_row(s)
        rows.append([s] + [f.get(c) for c in cols])

    if format == "json":
        return {
            "tickers": syms,
            "fields": cols,
            # Named so a caller notices a typo instead of silently getting
            # fewer columns than they asked for.
            "unknown_fields": unknown,
            "rows": [dict(zip(["ticker"] + cols, r)) for r in rows],
        }
    return PlainTextResponse(to_csv(["ticker"] + cols, rows), media_type="text/csv")


# ── BDH: history ───────────────────────────────────────────────────────────

@router.get("/bdh")
def bdh(ticker: str = Query(..., min_length=1),
        period: str = Query("1Y"),
        format: str = Query("csv", pattern="^(csv|json)$"),
        user: dict = Depends(api_token_user)):
    """Historical bars for one ticker — the BDH() equivalent."""
    from backend import providers
    try:
        candles = providers.history(ticker.strip().upper(), period) or []
    except Exception:
        candles = []

    def g(c: dict, *keys):
        for k in keys:
            if c.get(k) is not None:
                return c[k]
        return None

    headers = ["date", "open", "high", "low", "close", "volume"]
    rows = []
    for c in candles:
        d = g(c, "time", "Date", "Datetime", "date", "datetime")
        rows.append([
            str(d)[:19] if d is not None else None,
            g(c, "open", "Open"), g(c, "high", "High"),
            g(c, "low", "Low"), g(c, "close", "Close"),
            g(c, "volume", "Volume"),
        ])

    if format == "json":
        return {"ticker": ticker.upper(), "period": period,
                "rows": [dict(zip(headers, r)) for r in rows]}
    return PlainTextResponse(to_csv(headers, rows), media_type="text/csv")


@router.get("/fields")
def fields(_user: dict = Depends(auth.current_user)):
    """Discoverable field list, so nobody has to guess at spellings."""
    return {"bdp_fields": sorted(BDP_FIELDS),
            "bdp_defaults": DEFAULT_BDP_FIELDS,
            "bdh_periods": ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "2Y",
                            "3Y", "5Y", "10Y"],
            "note": "3Y/5Y/10Y are served as WEEKLY bars, not daily."}
