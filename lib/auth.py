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

import os as _os

# MB_DATA_DIR override matches backend/config.py (used by test harnesses).
from lib.atomic import read_json_resilient, write_json_atomic

DATA_DIR = Path(_os.getenv("MB_DATA_DIR")
                or (Path(__file__).resolve().parent.parent / "data"))
USERS_PATH = DATA_DIR / "users.json"
INITIAL_PW_PATH = DATA_DIR / "INITIAL_ADMIN_PASSWORD.txt"

ROLE_MASTER = "master_admin"

# The plan a NEW account starts on. Duplicated from backend.plans.FREE rather
# than imported, because lib/ sits below backend/ and must not depend upward.
# tests/test_entitlements.py asserts the two agree, so they cannot drift.
#
# It matters that create_user sets this explicitly: an account written with no
# `plan` key at all looks, to backfill_plans, like a record that predates plans
# existing — and would be grandfathered onto the PAID tier at the next restart.
DEFAULT_PLAN = "free"
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
    # Falls back to the .bak copy and quarantines an unreadable primary,
    # instead of silently returning an empty user table — that turned one bad
    # write into "every account vanished", and the next save made it permanent.
    data = read_json_resilient(USERS_PATH, {"users": {}})
    if not isinstance(data, dict) or "users" not in data:
        return {"users": {}}
    return data


def _save(data: dict) -> None:
    """Persist the user table atomically.

    Never truncate-then-write: a failure part-way (a full disk is the
    realistic case) would leave users.json empty and lock everyone out, and
    freeing the disk afterwards would not bring the accounts back.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_json_atomic(USERS_PATH, data)


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


def ensure_env_admin() -> None:
    """Sync the master-admin account with MOTHERBOARD_ADMIN_USER/PASSWORD on
    every backend boot.

    Previously the admin was seeded ONLY when users.json didn't exist, so any
    later .env password change silently did nothing — the login kept using
    whatever password happened to be set at first boot ("invalid credentials"
    with no way to recover except editing the JSON by hand). Now deploy/.env
    is the source of truth: change the password there, restart the backend,
    log in with the new one. No-op when either env var is unset."""
    user = os.getenv("MOTHERBOARD_ADMIN_USER", "").strip()
    pw = os.getenv("MOTHERBOARD_ADMIN_PASSWORD", "").strip()
    if not user or not pw:
        return
    data = _load()
    key = user.lower()
    salt = secrets.token_hex(16)
    rec = data["users"].get(key)
    if rec is None:
        data["users"][key] = {
            "display": user, "salt": salt, "hash": _hash(pw, salt),
            "role": ROLE_MASTER, "active": True, "created": _now(),
        }
    else:
        # Skip the write when the password already matches — avoids churning
        # the salt/hash (and file mtime) on every boot.
        if _hash(pw, rec["salt"]) == rec["hash"] and rec.get("active", True) \
                and rec.get("role") == ROLE_MASTER:
            return
        rec["salt"] = salt
        rec["hash"] = _hash(pw, salt)
        rec["active"] = True
        rec["role"] = ROLE_MASTER
    _save(data)


def verify_credentials(username: str, password: str) -> dict | None:
    """Return a sanitized user dict on success (and if active), else None."""
    data = _load()
    rec = data["users"].get((username or "").strip().lower())
    if not rec or not rec.get("active", True):
        return None
    if _hash(password, rec["salt"]) != rec["hash"]:
        return None
    return {"username": rec["display"], "role": rec["role"],
            "plan": rec.get("plan", "")}


def set_plan(username: str, plan: str) -> tuple[bool, str]:
    """Move an account to a plan. The only way a plan changes."""
    data = _load()
    rec = data["users"].get((username or "").strip().lower())
    if not rec:
        return False, "User not found."
    rec["plan"] = plan
    rec["plan_since"] = _now()
    _save(data)
    return True, f"{rec['display']} moved to {plan}."


def backfill_plans(default_plan: str) -> int:
    """Stamp a plan on accounts that predate plans existing. Returns how many.

    GRANDFATHERED DELIBERATELY, and `default_plan` is expected to be the PAID
    tier, not the free one. These accounts were created when the limits were
    whatever the routers hardcoded — 40 alerts, 10 portfolios — and nobody
    agreed to less. Defaulting them to free would retroactively cut a working
    account below what it already holds, which is the one thing a limit change
    must never do. New accounts get the free tier; existing ones keep working.

    Runs once at startup and is a no-op afterwards, since it only touches
    records with no `plan` key at all.
    """
    data = _load()
    touched = 0
    for rec in data["users"].values():
        if "plan" not in rec:
            rec["plan"] = default_plan
            rec["plan_since"] = rec.get("created") or _now()
            touched += 1
    if touched:
        _save(data)
    return touched


def find_by_email(email: str) -> dict | None:
    """The account for an email address, or None.

    Used by the password-reset request, where people type the address rather
    than the username. Returns the sanitized dict, and honours `active` so a
    deactivated account cannot be reset back into use.
    """
    want = (email or "").strip().lower()
    if not want:
        return None
    for rec in _load()["users"].values():
        if (rec.get("email") or "").strip().lower() == want:
            if not rec.get("active", True):
                return None
            return {"username": rec["display"], "role": rec["role"],
                    "email": rec.get("email", ""),
                    "plan": rec.get("plan", "")}
    return None


def email_for(username: str) -> str:
    rec = _load()["users"].get((username or "").strip().lower())
    return (rec or {}).get("email", "") or ""


def get_user(username: str) -> dict | None:
    """The sanitized user dict, without checking a password.

    Passkey login proves who someone is with a signature rather than a
    secret, so it needs the record but must never go through
    `verify_credentials`. Still honours `active`, so deactivating an account
    closes the passkey door at the same moment it closes the password one.
    """
    rec = _load()["users"].get((username or "").strip().lower())
    if not rec or not rec.get("active", True):
        return None
    return {"username": rec["display"], "role": rec["role"],
            "plan": rec.get("plan", "")}


def create_user(username: str, password: str | None = None,
                role: str = ROLE_USER, email: str = "") -> tuple[bool, str]:
    """Create an account.

    `password=None` creates a PENDING account: the stored hash is of a random
    value nobody has ever seen, so password login is impossible until the user
    sets one through an invite link. That is deliberately not the same as
    "no hash" — an empty or absent hash is the kind of thing a later code path
    treats as "any password matches", and this way there is nothing special to
    remember about the record.
    """
    username = (username or "").strip()
    if not username:
        return False, "A username is required."
    pending = password is None
    if pending:
        # Unguessable and never surfaced. The invite token is the only way in.
        password = secrets.token_urlsafe(48)
    elif not password:
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
        "plan": DEFAULT_PLAN,
        "email": (email or "").strip(),
        # Shown in the admin list so an account waiting on its invite is
        # distinguishable from one whose owner simply has not logged in.
        "pending": pending,
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
    # Setting a password is what completes an invite.
    rec["pending"] = False
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
         "created_at": r.get("created") or None,
         "email": r.get("email", ""),
         "pending": bool(r.get("pending")),
         "plan": r.get("plan", ""),}
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
