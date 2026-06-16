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


@router.post("/users", status_code=201)
def create_user(body: CreateUserRequest,
                _user: dict = Depends(auth.require_master_admin)):
    role = body.role if body.role in (user_store.ROLE_USER,
                                      user_store.ROLE_MASTER) else user_store.ROLE_USER
    ok, msg = user_store.create_user(body.username, body.password, role)
    if not ok:
        raise HTTPException(400, msg)
    return {"ok": True, "message": msg}


@router.delete("/users/{username}", status_code=204)
def deactivate(username: str, _user: dict = Depends(auth.require_master_admin)):
    user_store.set_active(username, False)


@router.get("/audit")
def audit(limit: int = 200,
          _user: dict = Depends(auth.require_master_admin)):
    return get_storage().recent_audit(limit=limit)
