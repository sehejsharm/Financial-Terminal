"""Authentication and role-based access control.

Credentials live in data/users.json (gitignored). Passwords are stored as
salted PBKDF2-HMAC-SHA256 hashes - never in plaintext. The first run seeds a
Master Admin account (overridable via env vars). Only the Master Admin can
create, deactivate, or delete other users.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import streamlit as st

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
USERS_PATH = DATA_DIR / "users.json"
INITIAL_PW_PATH = DATA_DIR / "INITIAL_ADMIN_PASSWORD.txt"

ROLE_MASTER = "master_admin"
ROLE_USER = "user"
_ITERATIONS = 200_000

# Brute-force throttle (in-process; resets on restart). A full solution uses a
# shared store like Redis — see docs/enterprise-migration-plan.md (Phase 4).
_MAX_ATTEMPTS = 5
_LOCKOUT_SECONDS = 300
_failures: dict[str, dict] = {}  # key -> {"count": int, "until": float}


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), _ITERATIONS
    ).hex()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _surface_generated_password(user: str, pw: str) -> None:
    """Make an auto-generated admin password retrievable by the operator.

    Logged to stderr (visible in Streamlit Cloud → Manage app → logs) and
    written to a gitignored file. Never shown in the public UI.
    """
    msg = (
        f"[Motherboard] No MOTHERBOARD_ADMIN_PASSWORD set — generated a "
        f"temporary admin password for user '{user}': {pw}\n"
        f"[Motherboard] Set MOTHERBOARD_ADMIN_PASSWORD in your environment / "
        f"Streamlit secrets to a fixed value (this random one changes on every "
        f"restart)."
    )
    print(msg, file=sys.stderr)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(INITIAL_PW_PATH, "w", encoding="utf-8") as fh:
            fh.write(pw + "\n")
    except Exception:
        pass


def _seed() -> dict:
    """Seed the first master-admin account.

    Credentials come from the environment. If no password is configured we
    generate a strong random one rather than ever falling back to a known
    default — see docs/enterprise-migration-plan.md (Phase 0).
    """
    user = os.getenv("MOTHERBOARD_ADMIN_USER", "admin").strip() or "admin"
    pw = os.getenv("MOTHERBOARD_ADMIN_PASSWORD", "").strip()
    auto_generated = False
    if not pw:
        pw = secrets.token_urlsafe(12)
        auto_generated = True
    salt = secrets.token_hex(16)
    data = {
        "users": {
            user.lower(): {
                "display": user,
                "salt": salt,
                "hash": _hash(pw, salt),
                "role": ROLE_MASTER,
                "active": True,
                "created": _now(),
            }
        }
    }
    if auto_generated:
        _surface_generated_password(user, pw)
    return data


def _load() -> dict:
    if not USERS_PATH.exists():
        data = _seed()
        _save(data)
        return data
    try:
        with open(USERS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if "users" not in data:
            data = {"users": {}}
        return data
    except Exception:
        return {"users": {}}


def _save(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(USERS_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def _lock_remaining(key: str) -> int:
    """Seconds remaining on a lockout for `key`, or 0 if not locked."""
    rec = _failures.get(key)
    if not rec:
        return 0
    remaining = rec.get("until", 0) - time.time()
    return int(remaining) if remaining > 0 else 0


def _note_failure(key: str) -> None:
    rec = _failures.setdefault(key, {"count": 0, "until": 0.0})
    rec["count"] += 1
    if rec["count"] >= _MAX_ATTEMPTS:
        rec["until"] = time.time() + _LOCKOUT_SECONDS
        rec["count"] = 0  # reset the counter; the lockout clock now governs


def _reset_failures(key: str) -> None:
    _failures.pop(key, None)


def verify_credentials(username: str, password: str) -> dict | None:
    """Return a sanitized user dict on success (and if active), else None."""
    data = _load()
    rec = data["users"].get((username or "").strip().lower())
    if not rec or not rec.get("active", True):
        return None
    if _hash(password, rec["salt"]) != rec["hash"]:
        return None
    return {"username": rec["display"], "role": rec["role"]}


def create_user(username: str, password: str, role: str = ROLE_USER) -> tuple[bool, str]:
    username = (username or "").strip()
    if not username or not password:
        return False, "Username and password are required."
    if len(password) < 6:
        return False, "Password must be at least 6 characters."
    data = _load()
    if username.lower() in data["users"]:
        return False, f"User '{username}' already exists."
    salt = secrets.token_hex(16)
    data["users"][username.lower()] = {
        "display": username, "salt": salt, "hash": _hash(password, salt),
        "role": role if role in (ROLE_USER, ROLE_MASTER) else ROLE_USER,
        "active": True, "created": _now(),
    }
    _save(data)
    return True, f"User '{username}' created."


def set_active(username: str, active: bool) -> None:
    data = _load()
    rec = data["users"].get(username.lower())
    if rec and rec["role"] != ROLE_MASTER:
        rec["active"] = active
        _save(data)


def delete_user(username: str) -> None:
    data = _load()
    rec = data["users"].get(username.lower())
    if rec and rec["role"] != ROLE_MASTER:
        del data["users"][username.lower()]
        _save(data)


def reset_password(username: str, password: str) -> tuple[bool, str]:
    if len(password) < 6:
        return False, "Password must be at least 6 characters."
    data = _load()
    rec = data["users"].get(username.lower())
    if not rec:
        return False, "User not found."
    rec["salt"] = secrets.token_hex(16)
    rec["hash"] = _hash(password, rec["salt"])
    _save(data)
    return True, f"Password updated for '{rec['display']}'."


def list_users() -> list[dict]:
    data = _load()
    # Emit both keys: the API/frontend expects `created_at`; `created` kept
    # for the Streamlit admin page. Empty string -> genuinely unknown (old
    # user files seeded before the timestamp existed) — the UI shows "—".
    return [
        {"username": r["display"], "role": r["role"],
         "active": r.get("active", True),
         "created": r.get("created", ""),
         "created_at": r.get("created") or None}
        for r in data["users"].values()
    ]


def current_user() -> dict | None:
    return st.session_state.get("auth_user")


def is_authenticated() -> bool:
    return current_user() is not None


def is_master_admin() -> bool:
    u = current_user()
    return bool(u and u.get("role") == ROLE_MASTER)


def logout() -> None:
    st.session_state.pop("auth_user", None)


def _render_login() -> None:
    from lib.config import APP_NAME
    st.markdown(f"<h1 style='text-align:center'>{APP_NAME}</h1>",
                unsafe_allow_html=True)
    st.markdown("<p style='text-align:center;color:#767c88;letter-spacing:0.1em;"
                "text-transform:uppercase;font-size:12px'>Secure terminal access"
                "</p>", unsafe_allow_html=True)
    _, mid, _ = st.columns([1, 1.4, 1])
    with mid:
        with st.form("login"):
            username = st.text_input("Username")
            password = st.text_input("Password", type="password")
            submitted = st.form_submit_button("Sign in", use_container_width=True)
        if submitted:
            key = (username or "").strip().lower() or "__blank__"
            locked = _lock_remaining(key)
            if locked:
                mins = (locked + 59) // 60
                st.error(
                    f"Too many failed attempts. Try again in ~{mins} "
                    f"minute(s)."
                )
            else:
                user = verify_credentials(username, password)
                if user:
                    _reset_failures(key)
                    st.session_state.auth_user = user
                    st.rerun()
                else:
                    _note_failure(key)
                    remaining = _lock_remaining(key)
                    if remaining:
                        st.error("Too many failed attempts — account locked "
                                 "for 5 minutes.")
                    else:
                        st.error("Invalid credentials or inactive account.")


def login_gate() -> None:
    """Show the login screen and halt the page if not authenticated."""
    if is_authenticated():
        return
    # Hide the multipage nav until the user is signed in.
    st.markdown("<style>[data-testid='stSidebarNav']{display:none;}</style>",
                unsafe_allow_html=True)
    _render_login()
    st.stop()
