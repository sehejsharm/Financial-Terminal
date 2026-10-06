"""Single-use, expiring tokens for invites and password resets.

Replaces the previous way accounts were made: an admin typed a password into a
form, the server stored it, and the admin then had to get that password to the
person somehow — over chat, or email, in plaintext. Three problems with that,
all of which this removes:

  * The admin knows the user's password. There is no point at which the user
    has a secret only they know, so "it must have been you, your account did
    it" is never true.
  * The password travels through whatever channel was convenient, and stays
    there, in scrollback, indefinitely.
  * The password was in a request body that the audit log records the shape of,
    and nothing forced the user to change it afterwards. Most never would.

Now the admin creates an account with NO password and the user sets one via a
link only they receive.

Design notes:

  * Tokens are stored HASHED, like refresh tokens, for the same reason: the
    store is not the place to keep a credential that grants account access.
  * SINGLE USE, consumed atomically. A reset link that still works after use is
    a live credential sitting in a mailbox — and mailboxes get breached, and
    mail gets forwarded.
  * Invites last 7 days, resets 1 hour. A reset is something the user just
    asked for and will act on immediately; an invite may wait for someone to
    come back from leave. Long-lived reset links are the ones that get found
    later.
  * One store for both purposes, with `purpose` checked on consume, so an
    invite token cannot be redeemed at the reset endpoint or vice versa. They
    look identical and would otherwise be interchangeable.
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from lib.atomic import read_json_resilient, write_json_atomic

_TOKEN_BYTES = 32

PURPOSE_INVITE = "invite"
PURPOSE_RESET = "reset"

TTL_SECONDS = {
    PURPOSE_INVITE: 7 * 24 * 3600,
    PURPOSE_RESET: 3600,
}

_lock = threading.Lock()
_path: Path | None = None
_cache: dict[str, Any] | None = None


def configure(data_dir: Path) -> None:
    global _path, _cache
    with _lock:
        _path = Path(data_dir) / "invites.json"
        _cache = None


def _load() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    if _path is None:
        raise RuntimeError("invites.configure() was never called")
    data = read_json_resilient(_path, {"tokens": {}})
    if not isinstance(data, dict) or "tokens" not in data:
        data = {"tokens": {}}
    _cache = data
    return data


def _save(data: dict[str, Any]) -> None:
    assert _path is not None
    _path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(_path, data)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue(username: str, email: str, purpose: str, *,
          role: str | None = None, invited_by: str = "") -> str:
    """Mint a token and return the plaintext once. Never stored in the clear.

    Issuing a second token for the same user and purpose invalidates the
    first. Otherwise every "resend the invite" would leave another working
    link behind, and the oldest email in the mailbox would stay a valid way in.
    """
    if purpose not in TTL_SECONDS:
        raise ValueError(f"unknown purpose {purpose!r}")
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    now = time.time()
    with _lock:
        data = _load()
        want = (username or "").lower()
        for key in [k for k, r in data["tokens"].items()
                    if r.get("username", "").lower() == want
                    and r.get("purpose") == purpose]:
            del data["tokens"][key]
        data["tokens"][_hash(token)] = {
            "username": username,
            "email": email,
            "purpose": purpose,
            "role": role,
            "invited_by": invited_by,
            "created": now,
            "expires": now + TTL_SECONDS[purpose],
        }
        _prune_locked(data)
        _save(data)
    return token


def peek(token: str, purpose: str) -> dict | None:
    """Look at a token without spending it.

    Used to render the set-password page: it has to show whose account this is
    before the form is submitted. Deliberately read-only — validating on page
    load must not consume the one use the user needs for the submit.
    """
    with _lock:
        rec = _load()["tokens"].get(_hash(token))
        if rec is None or rec.get("purpose") != purpose:
            return None
        if rec["expires"] <= time.time():
            return None
        return dict(rec)


def consume(token: str, purpose: str) -> dict | None:
    """Spend a token, returning its record, or None if it is not usable.

    The delete and the read happen under one lock, so two simultaneous
    submissions cannot both succeed.
    """
    with _lock:
        data = _load()
        key = _hash(token)
        rec = data["tokens"].get(key)
        if rec is None or rec.get("purpose") != purpose:
            return None
        if rec["expires"] <= time.time():
            del data["tokens"][key]
            _save(data)
            return None
        del data["tokens"][key]
        _save(data)
        return rec


def revoke_for(username: str, purpose: str | None = None) -> int:
    """Drop a user's outstanding tokens.

    Called when an account is deactivated: a pending invite or reset link must
    stop working at that moment, not keep sitting in a mailbox as a way back
    into a disabled account.
    """
    want = (username or "").lower()
    with _lock:
        data = _load()
        doomed = [k for k, r in data["tokens"].items()
                  if r.get("username", "").lower() == want
                  and (purpose is None or r.get("purpose") == purpose)]
        for k in doomed:
            del data["tokens"][k]
        if doomed:
            _save(data)
        return len(doomed)


def pending_for(username: str) -> dict | None:
    """The outstanding invite for a user, for the admin screen."""
    want = (username or "").lower()
    now = time.time()
    with _lock:
        for rec in _load()["tokens"].values():
            if (rec.get("username", "").lower() == want
                    and rec.get("purpose") == PURPOSE_INVITE
                    and rec["expires"] > now):
                return {"email": rec.get("email", ""),
                        "created": rec["created"],
                        "expires": rec["expires"]}
    return None


def _prune_locked(data: dict[str, Any]) -> None:
    now = time.time()
    for key in [k for k, r in data["tokens"].items() if r["expires"] <= now]:
        del data["tokens"][key]
