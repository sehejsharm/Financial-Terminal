"""Shared test fixtures."""
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
