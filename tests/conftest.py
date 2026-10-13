"""Shared test fixtures.

Both fixtures here exist for the same reason: the backend keeps some state in
MODULE GLOBALS, which outlives a test and therefore leaks between test modules.
That is correct for the application — one process, one rate limiter, one tick
cache — and it is a contamination hazard for a suite that runs in one process
in a randomised order.

Reset it here rather than in each test. A test that has to remember to clean up
somebody else's global is a test that will one day forget, and the failure
shows up somewhere else entirely.
"""
import pytest


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """The per-IP rate limiter is process-global; TestClient always presents
    the same client host, so cumulative logins across test modules would trip
    the login limit and flake unrelated tests."""
    try:
        from backend import ratelimit
        ratelimit._hits.clear()
    except ImportError:
        pass
    yield


@pytest.fixture(autouse=True)
def _reset_stream_hub():
    """Clear the stream hub's last-tick cache between tests.

    WHY, with the receipt. `hub.publish` DIFFS each tick against `hub._last`
    and returns early when nothing changed — correct behaviour, and the comment
    there says so: "nothing moved — emit nothing (bandwidth + no false flash)".
    But `_last` is a module global, so a value published by one test module is
    still there for the next one.

    tests/test_dataplane.py publishes RELIANCE.NS at ltp 2945.5 five times.
    tests/test_stream.py::test_stream_ws_subscribe_and_delta publishes
    RELIANCE.NS at ltp 2945.5 and then asserts a "px" frame arrives. Run in
    that order, the second publish diffs to nothing, no frame is emitted, and
    the stream test fails on an assertion about a tick it did publish —
    measured, not inferred:

        clean hub            -> 1 frame queued
        after an earlier     -> 0 frames queued
        publish of the same

    That is a real CI failure (920 passed, 1 failed) on a commit that changed
    only a markdown file, and it is invisible when either module runs alone.

    Also clears `_conns`: a connection left registered by a test that failed
    mid-way would otherwise keep receiving frames and holding a reference.
    """
    try:
        from backend.stream import hub
        hub._last.clear()
        hub._conns.clear()
        # _refcount tracks subscribers per symbol and is what active_symbols()
        # reads, so it has to be cleared alongside _conns or the hub reports
        # symbols nobody is subscribed to. (Clearing it directly rather than
        # via _decref on purpose: _decref also calls delayed.forget, and
        # reaching into the delayed plane from a fixture would make this
        # cleanup do more than cleanup.)
        hub._refcount.clear()
    except ImportError:
        pass
    yield
