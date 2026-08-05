"""Passkey registration and login, over the real HTTP surface.

tests/test_webauthn.py proves the crypto. This proves the ceremony as wired:
that a passkey registered by one account cannot sign anyone else in, that a
captured ceremony cannot be replayed, that deactivating an account closes the
passkey door as well as the password one, and — the property the whole
"supplement" design rests on — that passwords keep working throughout.

Signatures here are real, produced by a key generated in the test, so a
regression that broke verification could not pass by returning 200.
"""
from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from lib.webauthn import FLAG_AT, FLAG_UP, FLAG_UV, b64url_encode

# The defaults the app derives from CORS_ORIGINS when nothing is configured.
RP_ID = "localhost"
ORIGIN = "http://localhost:3000"


# ── the same fixture builders test_webauthn uses ─────────────────────────

def cbor(value) -> bytes:
    def head(major: int, arg: int) -> bytes:
        if arg < 24:
            return bytes([major << 5 | arg])
        if arg < 256:
            return bytes([major << 5 | 24, arg])
        if arg < 65536:
            return bytes([major << 5 | 25]) + arg.to_bytes(2, "big")
        return bytes([major << 5 | 26]) + arg.to_bytes(4, "big")

    if isinstance(value, bool):
        return bytes([0xF5 if value else 0xF4])
    if isinstance(value, int):
        return head(0, value) if value >= 0 else head(1, -1 - value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        b = value.encode()
        return head(3, len(b)) + b
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(cbor(v) for v in value)
    if isinstance(value, dict):
        return head(5, len(value)) + b"".join(cbor(k) + cbor(v)
                                              for k, v in value.items())
    raise TypeError(type(value))


def es256_cose(key) -> dict:
    n = key.public_numbers()
    return {1: 2, 3: -7, -1: 1,
            -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")}


def auth_data(*, rp_id=RP_ID, flags=FLAG_UP | FLAG_UV, sign_count=0,
              cose=None, cred_id=b"cred-0001") -> bytes:
    out = (hashlib.sha256(rp_id.encode()).digest() + bytes([flags])
           + sign_count.to_bytes(4, "big"))
    if cose is not None:
        out += b"\x00" * 16 + len(cred_id).to_bytes(2, "big") + cred_id + cbor(cose)
    return out


def client_data(*, typ, challenge: str, origin=ORIGIN) -> bytes:
    return json.dumps({"type": typ, "challenge": challenge,
                       "origin": origin}).encode()


# ── app under test ───────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    tmp = tmp_path_factory.mktemp("passkeys")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    monkeymodule.setenv("BACKEND_JWT_SECRET",
                        "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    import lib.auth as lib_auth
    monkeymodule.setattr(lib_auth, "DATA_DIR", Path(tmp))
    monkeymodule.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    monkeymodule.setattr(lib_auth, "INITIAL_PW_PATH",
                         Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))
    from backend import app as app_mod
    importlib.reload(app_mod)
    return TestClient(app_mod.app)


@pytest.fixture(autouse=True)
def _clean_limits():
    from backend import ratelimit
    from lib import passkey_store
    ratelimit._hits.clear()
    passkey_store._reset_challenges_for_test()
    yield
    ratelimit._hits.clear()


def login(client, username, password):
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(client):
    return login(client, "admin", "test-pw-123")


@pytest.fixture(scope="module")
def users(client, admin):
    for name in ("ana", "raj"):
        client.post("/api/v1/admin/users", headers=admin,
                    json={"username": name, "password": f"{name}-pw-12345",
                          "role": "user"})
    return {n: login(client, n, f"{n}-pw-12345") for n in ("ana", "raj")}


def enrol(client, headers, key, cred_id=b"cred-0001"):
    """Run a full registration ceremony and return the response."""
    begin = client.post("/api/v1/auth/passkey/register/begin", headers=headers)
    assert begin.status_code == 200, begin.text
    opts = begin.json()
    att = cbor({"fmt": "none", "attStmt": {},
                "authData": auth_data(flags=FLAG_UP | FLAG_UV | FLAG_AT,
                                      cose=es256_cose(key.public_key()),
                                      cred_id=cred_id)})
    return client.post("/api/v1/auth/passkey/register/finish", headers=headers,
                       json={
                           "handle": opts["handle"],
                           "credential_id": b64url_encode(cred_id),
                           "client_data_json": b64url_encode(
                               client_data(typ="webauthn.create",
                                           challenge=opts["challenge"])),
                           "attestation_object": b64url_encode(att),
                           "label": "Test device",
                       })


def assert_login(client, key, cred_id=b"cred-0001", *, sign_count=1,
                 origin=ORIGIN, rp_id=RP_ID):
    """Run a full assertion ceremony and return the response."""
    begin = client.post("/api/v1/auth/passkey/login/begin")
    assert begin.status_code == 200, begin.text
    opts = begin.json()
    cd = client_data(typ="webauthn.get", challenge=opts["challenge"],
                     origin=origin)
    ad = auth_data(rp_id=rp_id, sign_count=sign_count)
    sig = key.sign(ad + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
    return client.post("/api/v1/auth/passkey/login/finish", json={
        "handle": opts["handle"],
        "credential_id": b64url_encode(cred_id),
        "client_data_json": b64url_encode(cd),
        "authenticator_data": b64url_encode(ad),
        "signature": b64url_encode(sig),
    })


@pytest.fixture
def key():
    return ec.generate_private_key(ec.SECP256R1())


# ── the happy path ───────────────────────────────────────────────────────

class TestEnrolAndSignIn:
    def test_a_registered_passkey_signs_the_owner_in(self, client, users, key):
        assert enrol(client, users["ana"], key).status_code == 201
        r = assert_login(client, key)
        assert r.status_code == 200, r.text
        assert r.json()["username"] == "ana"
        assert r.json()["access_token"]

    def test_the_token_works_on_a_normal_endpoint(self, client, users, key):
        enrol(client, users["ana"], key, cred_id=b"cred-token")
        token = assert_login(client, key, cred_id=b"cred-token").json()["access_token"]
        me = client.get("/api/v1/auth/me",
                        headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200 and me.json()["username"] == "ana"

    def test_registration_requires_a_session(self, client):
        # Enrolment is what binds a key to an identity, so it can only happen
        # inside a session that already proved who the user is.
        assert client.post("/api/v1/auth/passkey/register/begin").status_code == 401

    def test_the_passkey_is_listed_and_can_be_removed(self, client, users, key):
        enrol(client, users["raj"], key, cred_id=b"cred-raj-1")
        listed = client.get("/api/v1/auth/passkey/credentials",
                            headers=users["raj"]).json()["credentials"]
        assert any(c["label"] == "Test device" for c in listed)
        # The public key is not a secret, but it has no business in a response.
        assert all("public_key" not in c for c in listed)
        cid = b64url_encode(b"cred-raj-1")
        assert client.delete(f"/api/v1/auth/passkey/credentials/{cid}",
                             headers=users["raj"]).status_code == 204
        assert assert_login(client, key, cred_id=b"cred-raj-1").status_code == 401


# ── what must NOT work ───────────────────────────────────────────────────

class TestRefusals:
    def test_a_challenge_cannot_be_REPLAYED(self, client, users, key):
        # The captured ceremony is byte-for-byte valid; only single use stops
        # it. This is the check that makes an intercepted login worthless.
        enrol(client, users["ana"], key, cred_id=b"cred-replay")
        begin = client.post("/api/v1/auth/passkey/login/begin").json()
        cd = client_data(typ="webauthn.get", challenge=begin["challenge"])
        ad = auth_data(sign_count=1)
        sig = key.sign(ad + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        body = {"handle": begin["handle"],
                "credential_id": b64url_encode(b"cred-replay"),
                "client_data_json": b64url_encode(cd),
                "authenticator_data": b64url_encode(ad),
                "signature": b64url_encode(sig)}
        assert client.post("/api/v1/auth/passkey/login/finish", json=body).status_code == 200
        assert client.post("/api/v1/auth/passkey/login/finish", json=body).status_code == 401

    def test_a_key_registered_to_ANOTHER_account_cannot_be_claimed(self, client,
                                                                   users, key):
        enrol(client, users["ana"], key, cred_id=b"cred-shared")
        r = enrol(client, users["raj"], key, cred_id=b"cred-shared")
        assert r.status_code == 409
        # And it still signs in only its real owner.
        assert assert_login(client, key,
                            cred_id=b"cred-shared").json()["username"] == "ana"

    def test_a_forged_signature_is_refused(self, client, users, key):
        enrol(client, users["ana"], key, cred_id=b"cred-forge")
        assert assert_login(client, ec.generate_private_key(ec.SECP256R1()),
                            cred_id=b"cred-forge").status_code == 401

    def test_an_unknown_credential_is_refused(self, client, key):
        assert assert_login(client, key, cred_id=b"never-registered").status_code == 401

    def test_a_ceremony_from_another_ORIGIN_is_refused(self, client, users, key):
        enrol(client, users["ana"], key, cred_id=b"cred-origin")
        assert assert_login(client, key, cred_id=b"cred-origin",
                            origin="https://evil.example").status_code == 401

    def test_a_ceremony_for_another_DOMAIN_is_refused(self, client, users, key):
        enrol(client, users["ana"], key, cred_id=b"cred-rp")
        assert assert_login(client, key, cred_id=b"cred-rp",
                            rp_id="evil.example").status_code == 401

    def test_a_STALE_counter_is_refused(self, client, users, key):
        # A counter that fails to advance is the clone signal, and it only
        # works if the advanced value was persisted after the first login.
        enrol(client, users["ana"], key, cred_id=b"cred-count")
        assert assert_login(client, key, cred_id=b"cred-count",
                            sign_count=5).status_code == 200
        assert assert_login(client, key, cred_id=b"cred-count",
                            sign_count=5).status_code == 401
        assert assert_login(client, key, cred_id=b"cred-count",
                            sign_count=6).status_code == 200

    def test_a_DEACTIVATED_account_cannot_sign_in_with_its_passkey(
            self, client, admin, users, key):
        enrol(client, users["raj"], key, cred_id=b"cred-off")
        assert assert_login(client, key, cred_id=b"cred-off").status_code == 200
        assert client.delete("/api/v1/admin/users/raj",
                             headers=admin).status_code == 204
        # Closing an account has to close every door, not just the password.
        assert assert_login(client, key, cred_id=b"cred-off",
                            sign_count=9).status_code == 401

    def test_failures_never_say_WHICH_check_failed(self, client, key):
        # Naming the failed check is free reconnaissance and the user can do
        # nothing differently with it.
        r = assert_login(client, key, cred_id=b"nope")
        assert r.json()["detail"] == (
            "Could not verify that passkey. Sign in with your password instead.")


# ── the property the whole design rests on ───────────────────────────────

class TestSupplementsPasswords:
    def test_the_password_still_works_after_enrolling_a_passkey(self, client,
                                                                users, key):
        enrol(client, users["ana"], key, cred_id=b"cred-both")
        assert login(client, "ana", "ana-pw-12345")

    def test_passkey_traffic_does_not_consume_the_PASSWORD_login_budget(
            self, client, users, key):
        # The rate limiter used to bucket every /auth path together, so a
        # handful of failed biometrics would have locked the user out of the
        # fallback that exists for exactly that moment.
        for _ in range(25):
            client.post("/api/v1/auth/passkey/login/begin")
        r = client.post("/api/v1/auth/login",
                        json={"username": "ana", "password": "ana-pw-12345"})
        assert r.status_code == 200, "password login was starved by passkey traffic"

    def test_the_passkey_route_is_still_rate_limited(self, client):
        # Its own bucket, but not an unlimited one.
        codes = [client.post("/api/v1/auth/passkey/login/begin").status_code
                 for _ in range(60)]
        assert 429 in codes

    def test_support_reveals_nothing_about_any_account(self, client):
        r = client.get("/api/v1/auth/passkey/support")
        assert r.status_code == 200
        assert set(r.json()) == {"rp_id", "rp_name"}
