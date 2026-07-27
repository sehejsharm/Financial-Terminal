"""Value-chain mapper — returns structured JSON (suppliers/customers/competitors)."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend import auth
from lib import ai_analyst, value_chain as vc
from lib.auth import DATA_DIR
from lib.market_data import get_stock_fundamentals

router = APIRouter(prefix="/value-chain", tags=["value-chain"])

REPORTS_PATH = DATA_DIR / "vc_reports.jsonl"


# What's actually wrong with a flagged relationship. Kept as a closed set so
# the review queue can be sorted/counted; "other" carries the free text.
REPORT_CATEGORIES = ("wrong_entity", "wrong_weight", "outdated",
                     "duplicate", "other")


class ChainReport(BaseModel):
    """User flag: a generated relationship looks wrong. Feeds a review queue
    (Admin page) instead of silently trusting the LLM forever."""
    node_name: str = Field(..., max_length=120)
    role: str = Field(..., max_length=20)          # supplier|customer|competitor
    reason: str = Field("", max_length=500)
    # Older clients don't send this; those records read as "unspecified"
    # rather than breaking the existing queue.
    category: str = Field("unspecified", max_length=32)


OVERRIDES_PATH = DATA_DIR / "vc_overrides.json"
HISTORY_PATH = DATA_DIR / "vc_history.jsonl"


def _load_overrides() -> dict:
    try:
        return json.loads(OVERRIDES_PATH.read_text() or "{}") if OVERRIDES_PATH.exists() else {}
    except Exception:
        return {}


def _apply_overrides(ticker: str, data: dict) -> dict:
    """Merge admin-verified corrections into the AI output. Locked edges
    always win — a future AI regeneration cannot silently overwrite them.
    Every edge carries a confidence tier in the data model itself:
    'estimated' (AI) or 'verified' (admin-published correction)."""
    ov = _load_overrides().get(ticker.upper(), {})
    for role in ("suppliers", "customers", "competitors"):
        for node in data.get(role) or []:
            node.setdefault("confidence", "estimated")
            key = f"{role[:-1]}|{(node.get('name') or '').upper()}"
            o = ov.get(key)
            if o:
                if o.get("revenue_pct") is not None:
                    node["revenue_pct"] = o["revenue_pct"]
                if o.get("note"):
                    node["note"] = o["note"]
                node["confidence"] = "verified"
                node["verified_at"] = o.get("ts")
                node["locked"] = bool(o.get("locked", True))
    return data


_ROLE_SINGULAR = {"suppliers": "supplier", "customers": "customer",
                  "competitors": "competitor"}
_ROLE_ORDER = ["supplier", "customer", "competitor"]


def _norm_entity(name: str) -> str:
    """Identity key for cross-role matching — mirrors entityKey() in
    frontend/src/lib/valueChainGraph.ts (case/punctuation/corporate-suffix
    insensitive) so client and server agree on what 'the same company' means."""
    suffixes = {
        "inc", "incorporated", "ltd", "limited", "llc", "llp", "plc", "corp",
        "corporation", "co", "company", "sa", "ag", "nv", "spa", "gmbh", "ab",
        "as", "oyj", "pte", "pvt", "group", "holdings", "holding", "the",
    }
    cleaned = "".join(c if (c.isalnum() or c.isspace()) else " "
                      for c in (name or "").lower())
    words = [w for w in cleaned.split() if w not in suffixes]
    return " ".join(words) or (name or "").strip().lower()


def _alias_key(key: str, existing) -> str | None:
    """Whole-word prefix match, mirroring findAliasKey() on the client, so
    'Samsung' and 'Samsung Electronics' aggregate together while 'Tata Motors'
    and 'Tata Steel' never do."""
    if len(key) < 4:
        return None
    for k in existing:
        if k == key:
            return k
        if len(k) >= 4 and (k.startswith(key + " ") or key.startswith(k + " ")):
            return k
    return None


def _annotate_roles(data: dict) -> dict:
    """Stamp every node with `roles: [...]` — the full set of roles that
    entity plays in this map.

    The wire format keeps the three positional arrays (history snapshots,
    admin overrides and CSV exports are all keyed by role, and old pinned
    maps must keep working), so `roles` is ADDITIVE: it tells the client
    which occurrences are the same company, letting it render one node with
    several badges instead of duplicates."""
    by_key: dict[str, list[str]] = {}
    for arr, role in _ROLE_SINGULAR.items():
        for node in data.get(arr) or []:
            key = _norm_entity(node.get("name") or "")
            if not key:
                continue
            if role not in by_key.setdefault(key, []):
                by_key[key].append(role)
    for arr, role in _ROLE_SINGULAR.items():
        for node in data.get(arr) or []:
            roles = by_key.get(_norm_entity(node.get("name") or ""), [role])
            node["roles"] = sorted(roles, key=_ROLE_ORDER.index)
    return data


def _append_history(ticker: str, data: dict) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(HISTORY_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ticker": ticker.upper(),
                                 "generated_at": data.get("generated_at"),
                                 "data": data}, ensure_ascii=False) + "\n")
    except Exception:
        pass


@router.get("/{ticker}")
def chain(ticker: str, refresh: bool = False,
          _user: dict = Depends(auth.current_user)):
    """Generate (or serve cached) value-chain map — GROUNDED.

    The raw ticker is canonicalized first, then the company's identity
    (name + sector/industry) must be verifiable from our own market data
    before the AI is allowed to generate. Without verified identity we
    refuse with a clear error instead of letting the model hallucinate a
    chain for whatever company the ticker letters suggest."""
    if not ai_analyst.is_available():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "No AI provider configured (GROQ_API_KEY or "
                            "GEMINI_API_KEY)")

    from lib.resolve import resolve
    r = resolve(ticker)
    if r["status"] == "none":
        raise HTTPException(422, f"'{ticker}' is not a recognized ticker — "
                                 "no value-chain map can be generated.")
    if r["status"] == "ambiguous":
        opts = ", ".join(c["symbol"] for c in r["candidates"][:4])
        raise HTTPException(422, f"'{ticker}' is ambiguous ({opts}) — open the "
                                 "specific listing first.")
    canonical = r["match"]["symbol"]

    # Identity grounding from OUR data, not the model's memory.
    from backend import providers
    snap = {}
    try:
        snap = providers.snapshot(canonical, quota_safe=True) or {}
    except Exception:
        pass
    company_name = snap.get("name") or r["match"].get("name")
    sector = snap.get("sector")
    industry = snap.get("industry")
    if not company_name or company_name == canonical:
        f = get_stock_fundamentals(canonical) or {}
        company_name = f.get("name") or company_name
        sector = sector or f.get("sector")
        industry = industry or f.get("industry")
    if not company_name or company_name == canonical:
        raise HTTPException(422, f"Cannot verify the identity of '{canonical}' "
                                 "from market data — refusing to generate an "
                                 "unattributable AI map.")

    nonce = int(datetime.now(timezone.utc).timestamp()) if refresh else 0
    try:
        data = vc.get_chain_data(canonical, company_name, sector=sector,
                                 industry=industry, nonce=nonce)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    if not data:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            "The AI did not return a valid structured map "
                            "after a retry — use Regenerate to try again.")
    data = _apply_overrides(canonical, dict(data))
    data = _annotate_roles(data)
    out = {"ticker": canonical, "name": company_name, "sector": sector, **data}
    if nonce or refresh:
        _append_history(canonical, out)
    elif not _history_has(canonical, data.get("generated_at")):
        _append_history(canonical, out)
    return out


def _history_has(ticker: str, generated_at) -> bool:
    if not HISTORY_PATH.exists() or not generated_at:
        return False
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as fh:
            for ln in fh:
                try:
                    rec = json.loads(ln)
                except Exception:
                    continue
                if rec.get("ticker") == ticker.upper() and \
                        rec.get("generated_at") == generated_at:
                    return True
    except Exception:
        pass
    return False


@router.get("/{ticker}/history")
def history(ticker: str, _user: dict = Depends(auth.current_user)):
    """Prior generated snapshots (timestamps), newest first."""
    if not HISTORY_PATH.exists():
        return []
    out = []
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as fh:
            for ln in fh:
                try:
                    rec = json.loads(ln)
                except Exception:
                    continue
                if rec.get("ticker") == ticker.upper():
                    out.append(rec)
    except Exception:
        return []
    return list(reversed(out))[:20]


class OverrideBody(BaseModel):
    role: str = Field(..., max_length=20)          # supplier|customer|competitor
    node_name: str = Field(..., max_length=120)
    revenue_pct: float | None = None
    note: str = Field("", max_length=300)
    locked: bool = True


@router.put("/{ticker}/override")
def put_override(ticker: str, body: OverrideBody,
                 user: dict = Depends(auth.require_master_admin)):
    """Admin-published correction for one relationship. Merged into every
    future serve of this map as a 'verified' edge; locked entries survive
    AI regeneration by design (merge happens at serve time)."""
    ov = _load_overrides()
    key = f"{body.role}|{body.node_name.upper()}"
    ov.setdefault(ticker.upper(), {})[key] = {
        "revenue_pct": body.revenue_pct,
        "note": body.note,
        "locked": body.locked,
        "verified_by": user["username"],
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OVERRIDES_PATH.write_text(json.dumps(ov, indent=2, ensure_ascii=False))
    except Exception:
        raise HTTPException(500, "Could not save the override.")
    return {"ok": True}


@router.post("/{ticker}/report")
def report(ticker: str, body: ChainReport,
           user: dict = Depends(auth.current_user)):
    """Append a wrong-relationship flag to the review queue (JSONL on the
    persistent data volume; listed on the Admin page)."""
    category = body.category if body.category in REPORT_CATEGORIES else "unspecified"
    rec = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "user": (user or {}).get("username"),
        "ticker": ticker.upper(),
        "node_name": body.node_name,
        "role": body.role,
        "category": category,
        "reason": body.reason,
    }
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(REPORTS_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        raise HTTPException(500, "Could not record the report.")
    return {"ok": True}


@router.get("/{ticker}/report-counts")
def report_counts(ticker: str, _user: dict = Depends(auth.current_user)):
    """How many times each relationship in THIS map has been flagged, plus a
    per-category breakdown. Drives the 'disputed' badge on nodes — a single
    flag is one person's opinion, repeated flags are a signal."""
    if not REPORTS_PATH.exists():
        return {"ticker": ticker.upper(), "counts": {}}
    counts: dict[str, dict] = {}
    try:
        with open(REPORTS_PATH, "r", encoding="utf-8") as fh:
            for ln in fh:
                try:
                    rec = json.loads(ln)
                except Exception:
                    continue
                if rec.get("ticker") != ticker.upper():
                    continue
                # Key on the normalised entity so flags against 'Samsung' and
                # 'Samsung Electronics' aggregate onto the same merged node.
                key = _norm_entity(rec.get("node_name") or "")
                if not key:
                    continue
                # Fold name variants onto one key, exactly as the client folds
                # them onto one node — otherwise a node that merged two
                # spellings would show an undercounted badge.
                key = _alias_key(key, counts.keys()) or key
                slot = counts.setdefault(key, {"count": 0, "categories": {},
                                               "roles": []})
                slot["count"] += 1
                cat = rec.get("category") or "unspecified"
                slot["categories"][cat] = slot["categories"].get(cat, 0) + 1
                role = rec.get("role")
                if role and role not in slot["roles"]:
                    slot["roles"].append(role)
    except Exception:
        return {"ticker": ticker.upper(), "counts": {}}
    return {"ticker": ticker.upper(), "counts": counts}


@router.get("/reports/all")
def list_reports(limit: int = 200,
                 _user: dict = Depends(auth.require_master_admin)):
    """Review queue for the Admin page — most recent first."""
    if not REPORTS_PATH.exists():
        return []
    try:
        with open(REPORTS_PATH, "r", encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
        out = []
        for ln in lines:
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
        return list(reversed(out))
    except Exception:
        return []
