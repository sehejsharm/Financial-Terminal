"""Server-side session records, so a login can actually be revoked.

A JWT cannot be withdrawn. Until now a token was valid for its full 12-hour
life no matter what happened in between: deactivating an account, changing a
password, or discovering a stolen token did nothing until it expired. "Sign out
everywhere" was not implementable, and neither was showing someone where they
are signed in, because nothing on the server knew.

So the long-lived credential moves here and becomes an opaque random string
with a row behind it. The JWT stays, but only as a SHORT-LIVED access token
(minutes), which is what makes revocation effective: the worst case is now one
access-token lifetime, not twelve hours.

Three choices worth stating:

  * Tokens are stored HASHED (SHA-256). A refresh token is a bearer
    credential, so a leaked store would otherwise hand over every live
    session. SHA-256 rather than PBKDF2 because this is a 256-bit random
    string, not a password — there is no dictionary to attack, and refresh sits
    on a request path where deliberate slowness is a cost, not a defence.

  * ONE ROW PER SESSION, holding the current token hash and the immediately
    previous one. The obvious alternative — a row per token, retired on
    rotation — grows by one row per refresh forever (~96 per device per day at
    a 15-minute access token) and forces a choice between unbounded growth and
    pruning away the very evidence reuse detection depends on. Keeping exactly
    one predecessor is bounded AND sufficient, because the attack this detects
    always presents the predecessor; see below.

  * Rotation on every use, with REUSE DETECTION. Each refresh issues a new
    token and remembers the old one. Presenting the old one again means two
    parties hold the same credential and there is no way to tell which is the
    real user, so the whole session is revoked and both are signed out.

    This is not theoretical neatness. The case it catches: a thief copies the
    CURRENT token and refreshes successfully. The legitimate client's next
    refresh then presents what is now the predecessor. Without detection that
    reads as a stale token, the real user is quietly signed out, and the thief
    — holding the live chain — continues indefinitely. With detection, the
    session dies and the user has to log in again, which is a visible event
    rather than a silent handover.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

from lib.atomic import read_json_resilient, write_json_atomic

# Opaque, 256 bits of entropy. Not a JWT: there is nothing to read in it, which
# means nothing to get wrong about trusting its contents.
_TOKEN_BYTES = 32

# How long a refresh token is good for, and therefore how long "stay signed in"
# lasts. Thirty days is the usual retail-app bargain; the short access token is
# what keeps that from meaning "thirty days of unrevocable access".
REFRESH_TTL_SECONDS = 30 * 24 * 3600

# The predecessor stays *acceptable* for a few seconds after rotation. Without
# this, two tabs refreshing at the same moment — or a client retrying after a
# response it never received — is indistinguishable from theft, and the user
# gets signed out for using the app normally in two tabs. Inside the window the
# predecessor is answered with the successor that already exists; outside it,
# the same request is treated as reuse.
ROTATION_GRACE_SECONDS = 30

# The most concurrent sessions one account may hold. Beyond this, creating a
# new one signs out the least recently used.
#
# This is not a tidiness limit, it is a missing bound that showed up as a
# measurement: the end-to-end suite signs in once per test and left 335 live
# sessions on one account, which made the account screen render 335 rows and
# put a 335-entry linear scan on every token refresh. A real user is the same
# shape, more slowly — logging in daily from three devices for thirty days is
# ninety live refresh tokens, every one of them a usable credential long after
# the device was last touched.
#
# Ten is comfortably more devices than anyone uses at once, and the eviction is
# least-recently-used, so the session being dropped is always the one nobody
# has touched.
MAX_SESSIONS_PER_USER = int(os.getenv("MAX_SESSIONS_PER_USER") or 10)

_lock = threading.Lock()
_path: Path | None = None
_cache: dict[str, Any] | None = None


def configure(data_dir: Path) -> None:
    """Point the store at a directory. Tests use this to redirect to a scratch
    path; the app calls it once at startup."""
    global _path, _cache
    with _lock:
        _path = Path(data_dir) / "sessions.json"
        _cache = None


def _load() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    if _path is None:
        raise RuntimeError("sessions.configure() was never called")
    # Same resilience as the user table: a half-written file must not read as
    # "nobody has any sessions", which would sign out every user at once.
    data = read_json_resilient(_path, {"sessions": {}})
    if not isinstance(data, dict) or "sessions" not in data:
        data = {"sessions": {}}
    _cache = data
    return data


def _save(data: dict[str, Any]) -> None:
    assert _path is not None
    _path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(_path, data)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> float:
    return time.time()


def _find_locked(data: dict[str, Any], token_hash: str) -> tuple[str, dict, bool] | None:
    """(session_id, record, is_predecessor) for a token hash, or None.

    A linear scan. Sessions are bounded by users × devices, so this is a few
    hundred dict lookups on a path that already does a disk write — an index
    would be a second thing to keep consistent for no measurable gain.
    """
    for sid, rec in data["sessions"].items():
        if rec.get("hash") == token_hash:
            return sid, rec, False
        if rec.get("prev_hash") == token_hash:
            return sid, rec, True
    return None


def create(username: str, *, user_agent: str = "", ip: str = "") -> str:
    """Start a new session and return its refresh token.

    The plaintext token is returned once and never stored. If it is lost the
    session cannot be recovered, only replaced by logging in again.
    """
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    sid = secrets.token_urlsafe(16)
    with _lock:
        data = _load()
        data["sessions"][sid] = {
            "username": username,
            "hash": _hash(token),
            "prev_hash": None,
            "prev_rotated_at": None,
            "successor_token": None,
            "created": _now(),
            "last_used": _now(),
            "expires": _now() + REFRESH_TTL_SECONDS,
            # Shown in the sessions list so someone can recognise — or fail to
            # recognise — a device. Truncated: it is display text, and the full
            # UA string is long and says nothing extra.
            "user_agent": (user_agent or "")[:200],
            "ip": ip,
        }
        _prune_locked(data)
        _evict_surplus_locked(data, username)
        _save(data)
    return token


class ReuseDetected(Exception):
    """A superseded refresh token was presented outside the grace window.

    Two parties hold the same credential and there is no way to tell which is
    the real user, so the session is revoked. Carries the session id.
    """


def rotate(token: str, *, user_agent: str = "", ip: str = "") -> tuple[str, dict] | None:
    """Exchange a refresh token for a fresh one.

    Returns (new_token, session) on success, None if the token is unknown or
    the session has expired, and raises ReuseDetected if the token has already
    been superseded.
    """
    with _lock:
        data = _load()
        found = _find_locked(data, _hash(token))
        if found is None:
            return None
        sid, rec, is_predecessor = found

        if rec["expires"] <= _now():
            del data["sessions"][sid]
            _save(data)
            return None

        if is_predecessor:
            rotated = rec.get("prev_rotated_at") or 0
            if _now() - rotated <= ROTATION_GRACE_SECONDS and rec.get("successor_token"):
                # A double submit. Hand back the token the first call already
                # issued rather than minting a second one, so the two tabs end
                # up sharing one chain instead of silently forking it.
                return rec["successor_token"], dict(rec)
            raise ReuseDetected(sid)

        new_token = secrets.token_urlsafe(_TOKEN_BYTES)
        rec["prev_hash"] = rec["hash"]
        rec["prev_rotated_at"] = _now()
        rec["successor_token"] = new_token
        rec["hash"] = _hash(new_token)
        rec["last_used"] = _now()
        if user_agent:
            rec["user_agent"] = user_agent[:200]
        if ip:
            rec["ip"] = ip
        _prune_locked(data)
        _save(data)
        return new_token, dict(rec)


def get(token: str) -> dict | None:
    """The live session for this token, or None. Does not rotate.

    Only the current token resolves — a predecessor is for detecting reuse,
    not for authenticating.
    """
    with _lock:
        data = _load()
        found = _find_locked(data, _hash(token))
        if found is None:
            return None
        sid, rec, is_predecessor = found
        if is_predecessor or rec["expires"] <= _now():
            return None
        return {**rec, "id": sid}


def revoke(token: str) -> bool:
    """End the session this token belongs to (a single sign-out)."""
    with _lock:
        data = _load()
        found = _find_locked(data, _hash(token))
        if found is None:
            return False
        del data["sessions"][found[0]]
        _save(data)
        return True


def revoke_session(username: str, session_id: str) -> bool:
    """End one named session — "sign out this other device".

    Scoped to the username on purpose: the id travels to the browser, so
    without this check one user could end another's session by guessing it.
    """
    with _lock:
        data = _load()
        rec = data["sessions"].get(session_id)
        if rec is None or rec.get("username", "").lower() != (username or "").lower():
            return False
        del data["sessions"][session_id]
        _save(data)
        return True


def revoke_all(username: str) -> int:
    """Sign out everywhere. Returns how many sessions were ended."""
    return _revoke_where(
        lambda r: r.get("username", "").lower() == (username or "").lower())


def _revoke_where(pred: Callable[[dict], bool]) -> int:
    with _lock:
        data = _load()
        doomed = [k for k, r in data["sessions"].items() if pred(r)]
        for k in doomed:
            del data["sessions"][k]
        if doomed:
            _save(data)
        return len(doomed)


def list_for(username: str, *, current_token: str | None = None) -> list[dict]:
    """The user's active sessions, most recently used first."""
    want = (username or "").lower()
    current = _hash(current_token) if current_token else None
    out = []
    with _lock:
        data = _load()
        for sid, rec in data["sessions"].items():
            if rec.get("username", "").lower() != want:
                continue
            if rec["expires"] <= _now():
                continue
            out.append({
                # The session id, never a token hash: this is handed to a
                # browser so a user can end one device, and it must not be
                # usable to reconstruct a credential.
                "id": sid,
                "created": rec["created"],
                "last_used": rec["last_used"],
                "user_agent": rec.get("user_agent", ""),
                "ip": rec.get("ip", ""),
                "current": current is not None and rec.get("hash") == current,
            })
    out.sort(key=lambda r: r["last_used"], reverse=True)
    return out


def _evict_surplus_locked(data: dict[str, Any], username: str) -> None:
    """Keep a user within MAX_SESSIONS_PER_USER, dropping the least recently
    used. Caller holds _lock.

    Least-recently-used rather than oldest-created: a session created months
    ago and used this morning is someone's main machine, while one created
    yesterday and never used again is a browser they tried once.
    """
    want = (username or "").lower()
    mine = [(k, r) for k, r in data["sessions"].items()
            if r.get("username", "").lower() == want]
    if len(mine) <= MAX_SESSIONS_PER_USER:
        return
    mine.sort(key=lambda kv: kv[1].get("last_used", 0))
    for key, _ in mine[:len(mine) - MAX_SESSIONS_PER_USER]:
        del data["sessions"][key]


def _prune_locked(data: dict[str, Any]) -> None:
    """Drop expired sessions and let go of spent rotation state.

    Clearing `successor_token` past the grace window matters beyond tidiness:
    it is a live refresh token sitting in the store in plaintext, and it only
    needs to exist for as long as a double submit could legitimately arrive.
    The predecessor HASH is kept for the life of the session, because that is
    what reuse detection reads.
    """
    now = _now()
    expired = [k for k, r in data["sessions"].items() if r["expires"] <= now]
    for key in expired:
        del data["sessions"][key]
    for rec in data["sessions"].values():
        rotated = rec.get("prev_rotated_at")
        if rotated and now - rotated > ROTATION_GRACE_SECONDS:
            rec["successor_token"] = None
