"""Admin endpoints — list users, create users, view audit log.

All guarded by require_master_admin.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.schemas import CreateUserRequest
from backend.storage import get_storage
from lib import auth as user_store

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users")
def list_users(_user: dict = Depends(auth.require_master_admin)):
    return user_store.list_users()


def _audit_action(actor: dict, action: str, target: str, detail: str = "") -> None:
    """Explicit audit event for sensitive admin actions — the request-level
    middleware only records method+path, which loses the affected user for
    body-carried operations like user creation."""
    from datetime import datetime, timezone
    try:
        get_storage().append_audit({
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "user": actor.get("username"), "method": "ACTION",
            "path": f"admin:{action}:{target}", "query": detail or None,
            "status": 200, "latency_ms": 0,
        })
    except Exception:
        pass  # auditing must never break the action itself


@router.post("/users", status_code=201)
def create_user(body: CreateUserRequest,
                user: dict = Depends(auth.require_master_admin)):
    # Role is server-validated: anything but the two known roles demotes to
    # plain user — the client's claim is never trusted.
    role = body.role if body.role in (user_store.ROLE_USER,
                                      user_store.ROLE_MASTER) else user_store.ROLE_USER
    ok, msg = user_store.create_user(body.username, body.password, role)
    if not ok:
        raise HTTPException(400, msg)
    _audit_action(user, "user_created", body.username, f"role={role}")
    return {"ok": True, "message": msg}


@router.delete("/users/{username}", status_code=204)
def deactivate(username: str, user: dict = Depends(auth.require_master_admin)):
    user_store.set_active(username, False)
    _audit_action(user, "user_deactivated", username)


@router.get("/audit")
def audit(limit: int = 200,
          _user: dict = Depends(auth.require_master_admin)):
    return get_storage().recent_audit(limit=limit)


@router.get("/performance")
def performance(limit: int = 40,
                _user: dict = Depends(auth.require_master_admin)):
    """Slow-request and timeout telemetry.

    Exists because the Macro → Sectors tab could hang forever and the only
    way anyone found out was a user watching a spinner. Requests past the
    slow threshold and every request that hit the deadline are counted here,
    so a hang shows up as a number on this page.
    """
    from backend.reliability import slow_report
    return slow_report(limit=limit)


@router.delete("/performance", status_code=204)
def reset_performance(user: dict = Depends(auth.require_master_admin)):
    from backend.reliability import reset_report
    reset_report()
    _audit_action(user, "performance_stats_reset", "")


@router.get("/nse-probe/{ticker}")
def nse_probe(ticker: str, quarterly: bool = True, max_docs: int = 2,
             _user: dict = Depends(auth.require_master_admin)):
    """A results filing's raw XBRL next to how it got parsed.

    The first run of this endpoint is what showed that
    /api/corporates-financial-results is an announcement index carrying no
    line items at all — every field it returns is metadata, which is why all
    twelve statement lines came back unmapped. The numbers are in the XBRL
    document that index links to, and this now reports on that document.

    Read the response in this order:

      documents[].consistency  — the filing's own identities. Revenue plus
        other income IS total income in any real filing, whatever the tags
        are called, and net income over EPS has to give a believable share
        count. All `ok` means the mapping is right; a `MISMATCH` names which
        identity broke, which is a mismapped line or a scale error.
      documents[].unmapped_lines — lines with no tag found. Some are genuine
        (a bank files no `Depreciation`); the rest are wrong guesses.
      documents[].all_numeric_facts — every tag present in that period,
        largest first. This is the definitive answer for anything unmapped:
        the real element name is in this list.
    """
    from lib import nse_financials
    return nse_financials.probe(ticker, quarterly=quarterly, max_docs=max_docs)
