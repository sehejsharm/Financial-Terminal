"""Deadlines, retries and slow-request telemetry.

These cover the "it hangs forever" class of bug directly: a handler that
never returns must produce a 504 with a readable explanation, and that
timeout must be counted somewhere an operator can see it.
"""
from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import reliability


@pytest.fixture(autouse=True)
def _clean_stats():
    reliability.reset_report()
    yield
    reliability.reset_report()


def make_app(deadline=0.3) -> TestClient:
    app = FastAPI()
    app.add_middleware(reliability.DeadlineMiddleware, seconds=deadline)

    @app.get("/fast")
    async def fast():
        return {"ok": True}

    @app.get("/hangs")
    async def hangs():
        await asyncio.sleep(30)
        return {"ok": True}          # pragma: no cover - never reached

    @app.get("/boom")
    async def boom():
        raise ValueError("nope")

    @app.get("/api/v1/stream")
    async def stream():
        await asyncio.sleep(0.5)
        return {"ok": True}

    return TestClient(app, raise_server_exceptions=False)


class TestDeadline:
    def test_a_fast_request_is_untouched(self):
        r = make_app().get("/fast")
        assert r.status_code == 200 and r.json() == {"ok": True}

    def test_a_hanging_request_returns_504_not_a_hang(self):
        t0 = time.perf_counter()
        r = make_app(deadline=0.3).get("/hangs")
        elapsed = time.perf_counter() - t0
        assert r.status_code == 504
        assert elapsed < 5, "the deadline did not actually cut the request off"

    def test_the_504_explains_that_it_is_SERVER_side(self):
        # The reported symptom was a browser showing "check your connection"
        # for what was a backend failure. The message has to say otherwise.
        detail = make_app(deadline=0.2).get("/hangs").json()["detail"]
        assert "server-side" in detail.lower()
        assert "connection" in detail.lower()
        assert "retry" in detail.lower()

    def test_streams_are_exempt(self):
        # A long-lived stream must not be killed at the deadline; that would
        # break the live-quote path the whole app depends on.
        assert make_app(deadline=0.1).get("/api/v1/stream").status_code == 200

    def test_a_handler_error_still_propagates(self):
        # The middleware must not turn a 500 into a 504 or swallow it.
        assert make_app().get("/boom").status_code == 500


class TestTelemetry:
    def test_a_timeout_is_recorded_as_a_timeout(self):
        make_app(deadline=0.2).get("/hangs")
        rep = reliability.slow_report()
        assert rep["routes"], "the timeout was not recorded at all"
        assert sum(r["timeouts"] for r in rep["routes"]) == 1
        assert rep["recent"][0]["status"] == 504

    def test_fast_requests_are_counted_but_not_flagged_slow(self):
        c = make_app()
        for _ in range(3):
            c.get("/fast")
        rep = reliability.slow_report()
        row = next(r for r in rep["routes"] if r["route"].endswith("/fast"))
        assert row["calls"] == 3
        assert row["slow"] == 0 and row["timeouts"] == 0

    def test_timeouts_sort_to_the_top_of_the_report(self):
        c = make_app(deadline=0.2)
        c.get("/fast")
        c.get("/hangs")
        assert reliability.slow_report()["routes"][0]["timeouts"] == 1

    def test_ids_are_collapsed_so_one_route_is_one_row(self):
        # /news/TCS.NS and /news/INFY.NS are the same route, not two.
        reliability.record("/api/v1/market/news/TCS.NS", "GET", 10, 200)
        reliability.record("/api/v1/market/news/INFY.NS", "GET", 10, 200)
        rows = reliability.slow_report()["routes"]
        assert len(rows) == 1 and rows[0]["calls"] == 2

    def test_the_report_states_what_it_measures(self):
        assert "timeout" in reliability.slow_report()["note"].lower()

    def test_recent_entries_are_capped(self):
        for i in range(500):
            reliability.record("/api/v1/x", "GET", 9999, 200)
        assert len(reliability.slow_report(limit=1000)["recent"]) <= 200


class TestRetry:
    def test_returns_the_first_success_without_sleeping(self):
        calls = []

        def ok():
            calls.append(1)
            return "value"

        t0 = time.perf_counter()
        assert reliability.retry(ok) == "value"
        assert len(calls) == 1
        assert time.perf_counter() - t0 < 0.2

    def test_retries_a_transient_failure_then_succeeds(self):
        state = {"n": 0}

        def flaky():
            state["n"] += 1
            if state["n"] < 3:
                raise ConnectionError("upstream blip")
            return "recovered"

        assert reliability.retry(flaky, attempts=3, base=0.01) == "recovered"
        assert state["n"] == 3

    def test_reraises_the_LAST_real_exception_not_a_wrapper(self):
        # A caller that catches ConnectionError must still be able to.
        def always():
            raise ConnectionError("upstream down")

        with pytest.raises(ConnectionError, match="upstream down"):
            reliability.retry(always, attempts=2, base=0.01)

    def test_backoff_grows(self):
        state = {"n": 0}

        def always():
            state["n"] += 1
            raise RuntimeError

        t0 = time.perf_counter()
        with pytest.raises(RuntimeError):
            reliability.retry(always, attempts=3, base=0.05)
        # 0.05 + 0.10 of sleeping between three attempts.
        assert time.perf_counter() - t0 >= 0.14
        assert state["n"] == 3

    def test_a_single_attempt_never_sleeps(self):
        with pytest.raises(RuntimeError):
            reliability.retry(lambda: (_ for _ in ()).throw(RuntimeError()),
                              attempts=1, base=5)


class TestThreadPool:
    def test_the_pool_is_bounded_well_below_the_anyio_default(self):
        # 40 concurrent provider calls is more memory than this container is
        # allowed; the OOM kill that followed is what produced 502s.
        assert reliability.THREAD_LIMIT < 40

    def test_configure_applies_the_limit(self):
        import anyio.to_thread

        async def check():
            before = anyio.to_thread.current_default_thread_limiter().total_tokens
            reliability.configure_thread_pool(7)
            after = anyio.to_thread.current_default_thread_limiter().total_tokens
            reliability.configure_thread_pool(int(before))
            return after

        assert asyncio.run(check()) == 7
