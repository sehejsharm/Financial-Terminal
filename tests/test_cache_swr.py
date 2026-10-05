"""Stale-while-revalidate in the response cache.

The cache used to serve a stale copy only when the wrapped function RAISED.
That covered a provider outage but not the far more common case: a cold key
with a slow upstream behind it. The request blocked for however long the
provider took — measured at 40 seconds on /screens/fields, which runs a whole
universe scan — while a perfectly serviceable copy from ten minutes ago sat
unused one key away.

These pin the new behaviour and, just as importantly, the limits of it:
a key that has never been computed still blocks, because there is genuinely
nothing to serve; and one refresh runs per key at a time, because N concurrent
misses each starting their own scan makes the slow path slower the more people
hit it.
"""
from __future__ import annotations

import threading
import time

import pytest

from backend import cache as cache_mod

# A TTL short enough to expire inside a test, long enough that the first call
# is still a genuine hit. NOT zero: _LRU.set treats a falsy ttl as "no expiry"
# (`expires = (time.time() + ttl) if ttl else 0`), so ttl=0 caches FOREVER
# rather than never — a trap worth knowing about, though no caller hits it.
EXPIRES_FAST = 0.05
EXPIRY_PAD = 0.12


@pytest.fixture(autouse=True)
def _clean_cache():
    """Each test gets its own cache + in-flight state."""
    cache_mod._lru = cache_mod._LRU()
    with cache_mod._inflight_lock:
        cache_mod._inflight.clear()
    yield
    with cache_mod._inflight_lock:
        cache_mod._inflight.clear()


def _settle(timeout: float = 3.0):
    """Wait for background revalidation to drain."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with cache_mod._inflight_lock:
            if not cache_mod._inflight:
                return
        time.sleep(0.01)


class TestStaleWhileRevalidate:
    def test_a_cold_key_with_no_history_still_blocks(self):
        # Nothing to serve means nothing to serve. This is the case that must
        # NOT change: inventing a value would be worse than waiting.
        calls = []

        @cache_mod.cached(ttl=60)
        def slow():
            calls.append(1)
            return {"v": 1}

        assert slow() == {"v": 1}
        assert len(calls) == 1

    def test_an_expired_key_serves_the_stale_copy_WITHOUT_waiting(self):
        # The headline behaviour. The second call must not pay the 0.5s.
        calls = []

        @cache_mod.cached(ttl=EXPIRES_FAST)
        def slow():
            calls.append(1)
            time.sleep(0.5)
            return {"v": len(calls)}

        first = slow()                     # cold: pays the cost, seeds stale
        assert first["v"] == 1
        time.sleep(EXPIRY_PAD)             # let the fresh entry lapse

        t0 = time.perf_counter()
        second = slow()                    # expired: should serve stale fast
        elapsed = time.perf_counter() - t0

        assert second["v"] == 1, "served something other than the stale copy"
        assert elapsed < 0.2, f"blocked for {elapsed:.2f}s instead of serving stale"
        _settle()

    def test_the_stale_copy_says_it_is_stale(self):
        # A number with no provenance is how a stale figure gets read as live.
        @cache_mod.cached(ttl=EXPIRES_FAST)
        def f():
            return {"v": 1}

        f()
        time.sleep(EXPIRY_PAD)
        out = f()
        assert out["stale"] is True
        assert "cached_as_of" in out

    def test_the_background_refresh_actually_updates_the_value(self):
        calls = []

        @cache_mod.cached(ttl=EXPIRES_FAST)
        def f():
            calls.append(1)
            return {"v": len(calls)}

        assert f()["v"] == 1
        time.sleep(EXPIRY_PAD)
        f()                                # serves stale, schedules refresh
        _settle()
        assert len(calls) >= 2, "no background refresh ran"

    def test_concurrent_misses_trigger_ONE_refresh_not_a_stampede(self):
        # Without single-flight, ten simultaneous misses start ten scans.
        calls = []
        lock = threading.Lock()

        @cache_mod.cached(ttl=EXPIRES_FAST)
        def f():
            with lock:
                calls.append(1)
            time.sleep(0.3)
            return {"v": 1}

        f()                                # seed the stale copy
        time.sleep(EXPIRY_PAD)
        before = len(calls)

        threads = [threading.Thread(target=f) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        _settle(timeout=5)

        # Ten concurrent stale-serves may coalesce into one refresh; the point
        # is that it is nowhere near ten.
        assert len(calls) - before <= 2, (
            f"{len(calls) - before} refreshes ran for 10 concurrent misses")

    def test_a_failing_background_refresh_does_not_surface_to_the_caller(self):
        # The caller already has their stale copy; a background explosion is
        # not their problem.
        state = {"n": 0}

        @cache_mod.cached(ttl=EXPIRES_FAST)
        def f():
            state["n"] += 1
            if state["n"] > 1:
                raise RuntimeError("provider down")
            return {"v": 1}

        assert f()["v"] == 1
        time.sleep(EXPIRY_PAD)
        assert f()["v"] == 1               # must not raise
        _settle()
        time.sleep(EXPIRY_PAD)
        assert f()["v"] == 1               # still serving the good copy

    def test_a_fresh_hit_never_touches_the_function(self):
        calls = []

        @cache_mod.cached(ttl=60)
        def f():
            calls.append(1)
            return {"v": 1}

        f(); f(); f()
        assert len(calls) == 1
