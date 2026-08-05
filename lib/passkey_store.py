"""Where passkeys and their one-time challenges live.

Split from `lib.webauthn` on purpose: that module is pure verification and can
be reasoned about without knowing anything about this app, while replay
protection is inherently stateful and belongs next to the storage it needs.

TWO THINGS HERE ARE SECURITY-CRITICAL.

A challenge must be used at most once. `take_challenge` deletes as it reads,
so a captured ceremony cannot be replayed even a second later — checking
"is it expired" without consuming would leave the whole TTL as a replay
window.

A credential id must map to exactly one account. Login is usernameless: the
browser picks the account and sends only the credential id, so the lookup
happens across every user. `find_credential` therefore scans all accounts, and
registration refuses an id already claimed elsewhere — without that, one user
could register another's credential id and turn their own passkey into a login
for that account.

The challenge store is in-process. That is correct for the single-uvicorn
deployment this runs on, and would need to move to Redis before running
multiple workers, since a challenge issued by one worker would not be found by
another — the failure is a confusing login loop rather than a vulnerability,
but it would be a real outage. `_CHALLENGES` is deliberately the only piece of
state that would have to change.
"""
from __future__ import annotations

import secrets
import threading
import time
from datetime import datetime, timezone

from backend.storage import get_storage

_KIND = "passkeys"

# How long a browser has to complete a biometric prompt. Long enough for a
# user who has to find their fingerprint reader, short enough that a captured
# challenge is worthless by the time it is replayed.
CHALLENGE_TTL_SECONDS = 300

# One account cannot hoard credentials; mostly this bounds the cost of the
# usernameless scan below.
MAX_CREDENTIALS_PER_USER = 10

# Minting a challenge is unauthenticated by necessity — login has to work
# before anyone is logged in — so the map needs a ceiling or an attacker can
# grow it for the whole TTL just by asking. Oldest-first eviction means the
# worst outcome is a legitimate user having to press the button again.
MAX_PENDING_CHALLENGES = 2_000

_CHALLENGES: dict[str, tuple[float, bytes, str | None]] = {}
_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── challenges ───────────────────────────────────────────────────────────

def new_challenge(username: str | None = None) -> tuple[str, bytes]:
    """Mint a single-use challenge, returning (handle, raw bytes).

    The handle goes to the client and comes back with the ceremony; the raw
    bytes never leave the server. 32 bytes from `secrets` — a guessable
    challenge would let an attacker pre-compute a signature.
    """
    handle = secrets.token_urlsafe(24)
    raw = secrets.token_bytes(32)
    with _LOCK:
        _sweep_locked()
        _CHALLENGES[handle] = (time.time() + CHALLENGE_TTL_SECONDS, raw, username)
    return handle, raw


def take_challenge(handle: str) -> tuple[bytes, str | None] | None:
    """Consume a challenge. Returns None if unknown, expired or already used.

    Deletes on read: that single fact is what makes a captured ceremony
    worthless on replay.
    """
    if not handle:
        return None
    with _LOCK:
        _sweep_locked()
        entry = _CHALLENGES.pop(handle, None)
    if entry is None:
        return None
    expires, raw, username = entry
    if time.time() > expires:
        return None
    return raw, username


def _sweep_locked() -> None:
    """Drop expired challenges, then enforce the ceiling.

    Called under the lock on every access, so an abandoned login cannot
    accumulate into a slow memory leak, and a flood cannot grow the map past
    a bounded size before the TTL would have cleared it.
    """
    now = time.time()
    for handle in [h for h, (exp, _r, _u) in _CHALLENGES.items() if now > exp]:
        _CHALLENGES.pop(handle, None)
    if len(_CHALLENGES) > MAX_PENDING_CHALLENGES:
        # Insertion-ordered, so this evicts the oldest first.
        for handle in list(_CHALLENGES)[:len(_CHALLENGES) - MAX_PENDING_CHALLENGES]:
            _CHALLENGES.pop(handle, None)


def user_handle(username: str) -> str:
    """The opaque per-account id WebAuthn stores on the device.

    Random and persisted rather than derived from the username: the handle is
    written into the authenticator and shown in some account pickers, and the
    spec is explicit that it must not contain personally identifying
    information. A username would.
    """
    doc = get_storage().user_doc(_KIND, username, {}) or {}
    handle = doc.get("user_handle")
    if not handle:
        handle = secrets.token_urlsafe(24)
        doc = {**doc, "user_handle": handle,
               "credentials": doc.get("credentials") or []}
        get_storage().save_user_doc(_KIND, username, doc)
    return handle


def _reset_challenges_for_test() -> None:
    with _LOCK:
        _CHALLENGES.clear()


# ── credentials ──────────────────────────────────────────────────────────

def credentials_for(username: str) -> list[dict]:
    doc = get_storage().user_doc(_KIND, username, {}) or {}
    return list(doc.get("credentials") or [])


def _save(username: str, creds: list[dict]) -> None:
    get_storage().save_user_doc(_KIND, username, {"credentials": creds})


def find_credential(credential_id: str) -> tuple[str, dict] | None:
    """Locate a credential across every account, for usernameless login.

    Login sends only the credential id — the browser has already picked the
    account — so this is the lookup that turns that id into a user. Linear in
    the number of accounts, which is fine at this scale and is the reason
    registration enforces global uniqueness rather than letting an index drift
    out of sync with the records it points at.
    """
    if not credential_id:
        return None
    for username, doc in (get_storage().all_user_docs(_KIND) or {}).items():
        for cred in (doc or {}).get("credentials") or []:
            if secrets.compare_digest(str(cred.get("id") or ""), credential_id):
                return username, cred
    return None


def add_credential(username: str, *, credential_id: str, public_key: str,
                   sign_count: int, algorithm: int, label: str,
                   aaguid: str | None = None) -> tuple[bool, str]:
    """Register a passkey for `username`.

    Refuses an id already registered anywhere. Re-registering the SAME id on
    the same account is an update rather than a duplicate — a browser that
    re-runs enrolment for a credential it already holds is a normal thing to
    do, and erroring there would look like a broken button.
    """
    owner = find_credential(credential_id)
    if owner and owner[0].lower() != username.lower():
        return False, "That passkey is already registered to another account."

    creds = credentials_for(username)
    creds = [c for c in creds if c.get("id") != credential_id]
    if len(creds) >= MAX_CREDENTIALS_PER_USER:
        return False, (f"Limit of {MAX_CREDENTIALS_PER_USER} passkeys reached — "
                       "remove one before adding another.")
    creds.append({
        "id": credential_id,
        "public_key": public_key,
        "sign_count": int(sign_count),
        "algorithm": int(algorithm),
        "label": (label or "Passkey")[:60],
        "aaguid": aaguid,
        "created": _now_iso(),
        "last_used": None,
    })
    _save(username, creds)
    return True, "Passkey registered."


def record_use(username: str, credential_id: str, sign_count: int) -> None:
    """Persist the advanced signature counter.

    Not bookkeeping: the clone check in `verify_assertion` compares against
    the stored value, so failing to write it back would disable that check
    entirely after the first login.
    """
    creds = credentials_for(username)
    for cred in creds:
        if cred.get("id") == credential_id:
            cred["sign_count"] = int(sign_count)
            cred["last_used"] = _now_iso()
            break
    _save(username, creds)


def remove_credential(username: str, credential_id: str) -> bool:
    creds = credentials_for(username)
    kept = [c for c in creds if c.get("id") != credential_id]
    if len(kept) == len(creds):
        return False
    _save(username, kept)
    return True


def public_list(username: str) -> list[dict]:
    """What the settings screen may show. Never includes the public key —
    it is not a secret, but it is not the user's business either and keeping
    it out of responses keeps the surface small."""
    return [{"id": c["id"], "label": c.get("label") or "Passkey",
             "created": c.get("created"), "last_used": c.get("last_used")}
            for c in credentials_for(username)]
