"""Cache decorator — Redis if REDIS_URL is set, else in-process LRU.

Drop-in replacement for @st.cache_data semantics in `lib/`. Functions wrapped
with this decorator are cached by argument values; results must be JSON-
serialisable when REDIS is in use (pandas objects fall back to pickle).
"""
from __future__ import annotations

import functools
import hashlib
import pickle
import time
from collections import OrderedDict
from typing import Any, Callable

from backend.config import REDIS_URL

_redis = None
if REDIS_URL:
    try:
        import redis  # type: ignore
        _redis = redis.Redis.from_url(REDIS_URL, decode_responses=False)
        # ping to fail fast on a bad URL
        _redis.ping()
    except Exception:
        _redis = None


def _key(name: str, args: tuple, kwargs: dict) -> str:
    # Ignore underscore-prefixed kwargs (FastAPI injects the resolved auth
    # dependency as `_user`); keying on it made every cache entry per-user,
    # so user B never hit user A's warm movers/quotes.
    kwargs = {k: v for k, v in kwargs.items() if not k.startswith("_")}
    payload = pickle.dumps((args, sorted(kwargs.items())))
    return f"mb:{name}:{hashlib.sha1(payload).hexdigest()}"


class _LRU:
    """Tiny TTL-aware LRU for the no-Redis path."""

    def __init__(self, maxsize: int = 1024):
        self.maxsize = maxsize
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, key: str):
        rec = self._data.get(key)
        if not rec:
            return None
        expires, value = rec
        if expires and expires < time.time():
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)
        return value

    def set(self, key: str, value: Any, ttl: int | None):
        expires = (time.time() + ttl) if ttl else 0
        self._data[key] = (expires, value)
        self._data.move_to_end(key)
        if len(self._data) > self.maxsize:
            self._data.popitem(last=False)


_lru = _LRU()


def cached(ttl: int = 600) -> Callable:
    """Cache the wrapped function's return value for `ttl` seconds.

    The wrapper exposes `.refresh(*args, **kwargs)`: recompute unconditionally
    and overwrite the entry. The background prewarmer uses it to rewrite hot
    entries just before expiry so user requests never pay the provider
    round-trip.
    """

    def deco(fn):
        def _store(key: str, value: Any) -> None:
            if _redis is not None:
                try:
                    _redis.setex(key, ttl, pickle.dumps(value))
                except Exception:
                    pass
            else:
                _lru.set(key, value, ttl)

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = _key(fn.__qualname__, args, kwargs)
            if _redis is not None:
                blob = _redis.get(key)
                if blob is not None:
                    try:
                        return pickle.loads(blob)
                    except Exception:
                        pass
            else:
                hit = _lru.get(key)
                if hit is not None:
                    return hit
            value = fn(*args, **kwargs)
            _store(key, value)
            return value

        def refresh(*args, **kwargs):
            key = _key(fn.__qualname__, args, kwargs)
            value = fn(*args, **kwargs)
            _store(key, value)
            return value

        wrapper.refresh = refresh
        return wrapper

    return deco


def cache_info() -> dict:
    return {
        "backend": "redis" if _redis else "in-process",
        "redis_url_set": bool(REDIS_URL),
        "redis_connected": _redis is not None,
    }
