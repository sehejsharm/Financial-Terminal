"""Per-account daily counters, for the entitlements that cost money per call.

Only two things are metered: screener runs and AI calls. Both spend real money
at a provider on every request, so an unmetered free tier is a bill rather than
a growth strategy. Everything else is a ceiling on stored objects (watchlists,
alerts), which needs no counter — the count is just how many exist.

The day boundary is IST, not UTC. This is an Indian markets product: a user's
"today" is a trading day that starts at 09:15 IST, and a quota that resets at
05:30 IST — midnight UTC — would reset in the middle of pre-market, which is
exactly when someone is using their screens. Getting this wrong is the kind of
bug that only ever reproduces for the user and never for us.

Counters are keyed by (username, feature, IST date) and old days are pruned on
write, so the file stays proportional to active users rather than to time.
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from lib.atomic import read_json_resilient, write_json_atomic

# IST is UTC+5:30 with no daylight saving, so a fixed offset is correct here
# and needs no timezone database.
IST = timezone(timedelta(hours=5, minutes=30))

# How many past days to keep. Enough to answer "why was I rate-limited
# yesterday?" from a support request, and no more.
_KEEP_DAYS = 3

_lock = threading.Lock()
_path: Path | None = None
_cache: dict[str, Any] | None = None


def configure(data_dir: Path) -> None:
    global _path, _cache
    with _lock:
        _path = Path(data_dir) / "usage.json"
        _cache = None


def today_key(now: datetime | None = None) -> str:
    return (now or datetime.now(IST)).astimezone(IST).strftime("%Y-%m-%d")


def _load() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    if _path is None:
        raise RuntimeError("usage.configure() was never called")
    data = read_json_resilient(_path, {"days": {}})
    if not isinstance(data, dict) or "days" not in data:
        data = {"days": {}}
    _cache = data
    return data


def _save(data: dict[str, Any]) -> None:
    assert _path is not None
    _path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(_path, data)


def used(username: str, feature: str, *, day: str | None = None) -> int:
    day = day or today_key()
    with _lock:
        return int(_load()["days"].get(day, {})
                   .get((username or "").lower(), {})
                   .get(feature, 0))


def record(username: str, feature: str, *, day: str | None = None) -> int:
    """Count one use and return the new total."""
    day = day or today_key()
    who = (username or "").lower()
    with _lock:
        data = _load()
        bucket = data["days"].setdefault(day, {}).setdefault(who, {})
        bucket[feature] = int(bucket.get(feature, 0)) + 1
        _prune_locked(data, day)
        _save(data)
        return bucket[feature]


def snapshot(username: str, *, day: str | None = None) -> dict[str, int]:
    """Everything this user has spent today, for the account screen."""
    day = day or today_key()
    with _lock:
        return dict(_load()["days"].get(day, {}).get((username or "").lower(), {}))


def reset(username: str) -> None:
    """Clear a user's counters across all retained days.

    For support: the honest fix when someone was metered by a bug of ours is
    to give the quota back, not to tell them to wait until tomorrow.
    """
    who = (username or "").lower()
    with _lock:
        data = _load()
        touched = False
        for day in data["days"].values():
            if who in day:
                del day[who]
                touched = True
        if touched:
            _save(data)


def _prune_locked(data: dict[str, Any], today: str) -> None:
    cutoff = (datetime.strptime(today, "%Y-%m-%d")
              - timedelta(days=_KEEP_DAYS)).strftime("%Y-%m-%d")
    for day in [d for d in data["days"] if d < cutoff]:
        del data["days"][day]
