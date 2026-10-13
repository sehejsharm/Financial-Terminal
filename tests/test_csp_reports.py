"""The CSP report collector.

frontend/next.config.js ships Content-Security-Policy in report-only mode for
reasons it documents at length and that still hold. What it did NOT have was
anywhere for the reports to go: no `report-uri`, no `report-to`, no endpoint.
So the policy reported to nobody, and "no violations seen" was
indistinguishable from "nobody was looking".

These tests pin the two properties that make the collector worth having:

  * it accepts whatever a browser actually sends, in every shape, without ever
    returning an error — a 4xx is something no browser can act on, so it buys
    noise in the proxy log and nothing else;
  * it cannot be used to exhaust the process, which matters because this is an
    unauthenticated write surface and the aggregation key contains
    sender-chosen strings.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.routes import csp

REPORT = "/api/v1/csp-report"
SUMMARY = "/api/v1/csp-report/summary"

ADMIN_PW = "test-pw-123"
USER_PW = "user-pw-123"

# The shape Chrome and Safari post for `report-uri`.
LEGACY = {"csp-report": {
    "document-uri": "https://app.example/terminal?t=RELIANCE.NS",
    "referrer": "",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "script-src 'self'",
    "blocked-uri": "inline",
    "status-code": 200,
    "script-sample": "self.__next_f.push([1,\"0:[\\\"$\\\"",
}}

# The shape the Reporting API posts for `report-to` — a BATCH.
MODERN = [{
    "age": 0,
    "type": "csp-violation",
    "url": "https://app.example/quant",
    "body": {
        "documentURL": "https://app.example/quant",
        "effectiveDirective": "script-src-elem",
        "blockedURL": "inline",
        "disposition": "report",
        "statusCode": 200,
    },
}]


@pytest.fixture(scope="module")
def app_mod(tmp_path_factory):
    """The app on a scratch data dir with a known admin, same shape as
    tests/test_public_endpoints.py — the store is module state, so it has to be
    pointed somewhere disposable before the app is built."""
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    tmp = tmp_path_factory.mktemp("csp")
    mp.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    mp.setenv("MOTHERBOARD_ADMIN_PASSWORD", ADMIN_PW)
    mp.setenv("BACKEND_JWT_SECRET",
              "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    import lib.auth as lib_auth
    mp.setattr(lib_auth, "DATA_DIR", Path(tmp))
    mp.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    mp.setattr(lib_auth, "INITIAL_PW_PATH", Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    lib_auth.create_user("plain", USER_PW)
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))
    from backend import app as mod
    importlib.reload(mod)
    yield mod
    mp.undo()


@pytest.fixture
def client(app_mod):
    # Reset around every test: the aggregate is module state by design (that
    # is what makes it survive across requests), so a leftover row from one
    # test would be counted by the next.
    csp.reset_for_tests()
    # NOT `with TestClient(...)`: the context-manager form runs the app's
    # startup hooks, which spawn the cache prewarmer and the alert evaluator
    # and start calling live providers. None of that is needed to post a JSON
    # body at a route, and it makes the module slow and noisy. Same reason
    # tests/test_public_endpoints.py constructs it bare.
    yield TestClient(app_mod.app)
    csp.reset_for_tests()


def _token(client, username, password) -> str:
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def admin_headers(client):
    return {"Authorization": f"Bearer {_token(client, 'admin', ADMIN_PW)}"}


@pytest.fixture
def user_headers(client):
    return {"Authorization": f"Bearer {_token(client, 'plain', USER_PW)}"}


def _rows(client, admin_headers):
    return client.get(SUMMARY, headers=admin_headers).json()


class TestItAcceptsWhatBrowsersActuallySend:
    def test_the_legacy_report_uri_shape(self, client, admin_headers):
        assert client.post(REPORT, json=LEGACY).status_code == 204
        body = _rows(client, admin_headers)
        assert body["signatures"] == 1
        row = body["rows"][0]
        assert row["directive"] == "script-src-elem"
        assert row["blocked_uri"] == "inline"
        assert row["count"] == 1

    def test_the_modern_reporting_api_batch(self, client, admin_headers):
        assert client.post(REPORT, json=MODERN).status_code == 204
        body = _rows(client, admin_headers)
        assert body["signatures"] == 1
        assert body["rows"][0]["document"] == "/quant"

    def test_a_batch_of_several_is_all_recorded(self, client, admin_headers):
        batch = [
            {"type": "csp-violation", "body": {"documentURL": "https://a/x",
                                               "effectiveDirective": "img-src",
                                               "blockedURL": "https://evil/i.png"}},
            {"type": "csp-violation", "body": {"documentURL": "https://a/y",
                                               "effectiveDirective": "style-src",
                                               "blockedURL": "inline"}},
        ]
        assert client.post(REPORT, json=batch).status_code == 204
        assert _rows(client, admin_headers)["signatures"] == 2

    def test_a_bare_unwrapped_body(self, client, admin_headers):
        # Some proxies unwrap the csp-report envelope before forwarding.
        assert client.post(REPORT, json={
            "document-uri": "https://a/z", "effective-directive": "font-src",
            "blocked-uri": "data:"}).status_code == 204
        assert _rows(client, admin_headers)["signatures"] == 1


class TestItNeverReturnsAnErrorToABrowser:
    """A browser cannot act on a 4xx here, so an error status is pure noise.

    Each of these would be a 422 from ordinary request-model validation, which
    is why this route takes a raw Request and parses it itself.
    """

    @pytest.mark.parametrize("payload", [
        b"",                       # empty body
        b"not json at all",        # unparseable
        b"[]",                     # empty batch
        b"null",
        b"42",
        b'"a string"',
        b'{"csp-report": "not an object"}',
        b'[1, 2, 3]',              # a list of non-objects
        b'{}',                     # valid JSON, nothing identifiable
    ])
    def test_junk_is_accepted_quietly(self, client, payload):
        r = client.post(REPORT, content=payload,
                        headers={"Content-Type": "application/csp-report"})
        assert r.status_code == 204, r.text
        assert r.content == b""

    def test_nothing_identifiable_takes_no_slot(self, client, admin_headers):
        # An empty object is well-formed but says nothing; it must not consume
        # one of the bounded signature slots.
        client.post(REPORT, json={})
        assert _rows(client, admin_headers)["signatures"] == 0


class TestAggregation:
    def test_repeats_collapse_onto_one_signature(self, client, admin_headers):
        """The property that stops a broken page filling the disk.

        One bad page in one browser emits a report per occurrence. Logging each
        turns a CSS mistake into a disk-space incident on a 1GB VM.
        """
        for _ in range(50):
            client.post(REPORT, json=LEGACY)
        body = _rows(client, admin_headers)
        assert body["signatures"] == 1
        assert body["rows"][0]["count"] == 50
        assert body["reports_received"] == 50

    def test_different_directives_stay_separate(self, client, admin_headers):
        client.post(REPORT, json=LEGACY)
        client.post(REPORT, json={"csp-report": {
            **LEGACY["csp-report"], "effective-directive": "img-src"}})
        assert _rows(client, admin_headers)["signatures"] == 2

    def test_rows_come_back_most_frequent_first(self, client, admin_headers):
        client.post(REPORT, json={"csp-report": {
            "document-uri": "https://a/rare", "effective-directive": "img-src",
            "blocked-uri": "x"}})
        for _ in range(5):
            client.post(REPORT, json=LEGACY)
        rows = _rows(client, admin_headers)["rows"]
        assert [r["count"] for r in rows] == [5, 1]


class TestItCannotBeUsedToExhaustTheProcess:
    def test_the_signature_map_is_capped_and_says_so(self, client, admin_headers):
        """Unauthenticated, and the key contains sender-chosen strings.

        Without a cap, a sender varying blocked-uri grows this map without
        limit. Past the cap new signatures are DROPPED rather than evicting
        what is already recorded — the early ones are the real findings, and
        the overflow is reported so a truncated list never looks complete.
        """
        for i in range(csp.MAX_SIGNATURES + 25):
            client.post(REPORT, json={"csp-report": {
                "document-uri": "https://a/p", "effective-directive": "img-src",
                "blocked-uri": f"https://evil.example/{i}.png"}})
        body = _rows(client, admin_headers)
        assert body["signatures"] == csp.MAX_SIGNATURES
        assert body["dropped_over_cap"] == 25
        assert body["cap"] == csp.MAX_SIGNATURES

    def test_long_fields_are_truncated(self, client, admin_headers):
        client.post(REPORT, json={"csp-report": {
            "document-uri": "https://a/" + "d" * 5000,
            "effective-directive": "s" * 5000,
            "blocked-uri": "b" * 5000,
            "script-sample": "x" * 100_000,
        }})
        row = _rows(client, admin_headers)["rows"][0]
        for field in ("directive", "blocked_uri", "document", "sample"):
            assert len(row[field]) <= csp.MAX_FIELD, field

    def test_a_multiline_sample_becomes_one_line(self, client, admin_headers):
        # Otherwise one report writes several lines into the journal and can
        # forge log entries.
        client.post(REPORT, json={"csp-report": {
            "document-uri": "https://a/p", "effective-directive": "script-src",
            "blocked-uri": "inline",
            "script-sample": "line one\nline two\r\nline three"}})
        sample = _rows(client, admin_headers)["rows"][0]["sample"]
        assert "\n" not in sample and "\r" not in sample


class TestTheSummaryIsNotPublic:
    def test_it_requires_a_master_admin(self, client):
        """It describes the app's script surface and can echo a fragment of
        whatever script was blocked — the detail somebody probing for an
        injection point would most like to read back."""
        assert client.get(SUMMARY).status_code in (401, 403)

    def test_a_plain_user_cannot_read_it(self, client, user_headers):
        assert client.get(SUMMARY, headers=user_headers).status_code == 403


class TestTheQueryStringIsNotStored:
    def test_only_the_path_is_kept(self, client, admin_headers):
        """document-uri carries tickers and, on some routes, a token query
        parameter. A violation is identified by WHICH PAGE it happened on, so
        the path is the whole signal — and keeping the query would put
        credentials into an aggregate that an admin endpoint serves back."""
        client.post(REPORT, json={"csp-report": {
            "document-uri": "https://app.example/stream?token=SECRET-JWT-VALUE",
            "effective-directive": "script-src", "blocked-uri": "inline"}})
        row = _rows(client, admin_headers)["rows"][0]
        assert row["document"] == "/stream"
        assert "SECRET-JWT-VALUE" not in str(row)
        assert "token" not in row["document"]


def test_the_endpoint_is_absent_from_the_public_schema(app_mod):
    """include_in_schema=False: it is machine-to-machine and listing it in the
    OpenAPI document only advertises an unauthenticated write surface."""
    # The docs are env-gated, so ask the app for its schema directly rather
    # than over HTTP.
    assert REPORT not in app_mod.app.openapi()["paths"]
