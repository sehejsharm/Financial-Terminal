"""A provider gap must not become a 500.

Starlette's JSONResponse renders with json.dumps(allow_nan=False), so one NaN
anywhere in a payload raises and the request dies:

    ValueError: Out of range float values are not JSON compliant: nan

That is not a hypothetical. It is what the e2e suite hit in CI, on a route that
computes a ratio from data a provider did not return — and it happens precisely
when providers are flaky, which is when a user most needs a graceful answer
rather than a 500.

The fix is central (backend/serialize.SafeJSONResponse, installed as the app's
default_response_class) rather than a sanitising call added to each router. The
helpers to do it per-route already existed and were applied in four routers out
of nine; the five that were missing it are the proof that "remember to call it"
does not hold. These tests pin the behaviour at the boundary, so they keep
holding for a router nobody has written yet.
"""
from __future__ import annotations

import math

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.serialize import SafeJSONResponse, deep_clean


@pytest.fixture(scope="module")
def client():
    """An app wired exactly as the real one is, with routes that return the
    shapes that used to 500."""
    app = FastAPI(default_response_class=SafeJSONResponse)

    @app.get("/bare")
    def bare():
        return {"ratio": float("nan")}

    @app.get("/nested")
    def nested():
        # The realistic shape: a list of holdings where one has no price, so
        # its weight is undefined.
        return {"holdings": [
            {"symbol": "A", "weight": 0.5},
            {"symbol": "B", "weight": float("nan")},
        ]}

    @app.get("/infinite")
    def infinite():
        # A zero denominator rather than missing data.
        return {"pe": float("inf"), "neg": float("-inf")}

    @app.get("/clean")
    def clean_route():
        return {"a": 1, "b": 2.5, "c": "x", "d": None, "e": [1, 2]}

    return TestClient(app)


class TestANaNDoesNotFiveHundred:
    def test_a_bare_nan_renders_as_null(self, client):
        r = client.get("/bare")
        assert r.status_code == 200
        assert r.json() == {"ratio": None}

    def test_a_nan_nested_in_a_list_of_dicts_renders(self, client):
        # The portfolio shape. Before the fix the whole response was lost
        # because one holding had no price.
        r = client.get("/nested")
        assert r.status_code == 200
        assert r.json()["holdings"][0]["weight"] == 0.5
        assert r.json()["holdings"][1]["weight"] is None

    def test_infinities_render_as_null_too(self, client):
        # A zero denominator produces inf, not nan, and allow_nan=False
        # rejects both.
        r = client.get("/infinite")
        assert r.status_code == 200
        assert r.json() == {"pe": None, "neg": None}

    def test_the_default_response_class_is_what_does_this(self):
        # Asserted directly, because the protection is the app's
        # default_response_class and a future refactor could drop that
        # keyword without any individual route test noticing.
        from backend import app as app_mod
        assert app_mod.app.router.default_response_class is SafeJSONResponse


class TestItChangesNothingThatAlreadyWorked:
    def test_a_payload_with_no_nan_is_untouched(self, client):
        r = client.get("/clean")
        assert r.status_code == 200
        assert r.json() == {"a": 1, "b": 2.5, "c": "x", "d": None, "e": [1, 2]}

    def test_the_bytes_are_identical_to_the_strict_encoder(self):
        """The safety argument, asserted.

        The sanitising pass only runs on a payload that would otherwise have
        raised — i.e. on a response that did not exist, because the request
        500'd. So anything that serialises today must serialise byte for byte
        the same. If this ever fails, the fix has started changing working
        responses and should be reverted.
        """
        from starlette.responses import JSONResponse
        payload = {"a": 1, "b": 2.5, "c": "x", "d": None,
                   "e": [1, 2, {"f": True}]}
        assert (SafeJSONResponse(content=payload).body
                == JSONResponse(content=payload).body)


class TestDeepClean:
    def test_missing_becomes_null_not_zero(self):
        # None, not 0.0. A missing or undefined figure is not zero, and
        # rendering it as zero is how a blank cell becomes a confident claim —
        # which on a financial screen is worse than an error.
        assert deep_clean(float("nan")) is None
        assert deep_clean(0.0) == 0.0

    def test_it_recurses_through_both_container_kinds(self):
        got = deep_clean({"a": [{"b": float("nan")}], "c": (float("inf"), 1)})
        assert got == {"a": [{"b": None}], "c": [None, 1]}

    def test_it_does_not_mutate_its_input(self):
        # The caller may still hold a reference; rebuilding rather than
        # mutating keeps the original intact.
        original = {"x": [1.0]}
        deep_clean(original)
        assert original == {"x": [1.0]}

    def test_ordinary_values_survive(self):
        for v in (1, -1, 0, 2.5, "s", True, False, None):
            assert deep_clean(v) == v


def test_the_bug_reproduces_without_the_fix():
    """Proof this test file is not vacuous.

    A plain JSONResponse — what every route used before — still raises on the
    payload above. If this ever stops raising, Starlette has changed its
    encoder and the fix may no longer be needed.
    """
    from starlette.responses import JSONResponse
    with pytest.raises(ValueError, match="not JSON compliant"):
        JSONResponse(content={"ratio": float("nan")})
    assert math.isnan(float("nan"))
