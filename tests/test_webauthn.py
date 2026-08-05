"""Passkey verification.

Every fixture here is built with real keys and real signatures rather than
mocks — the whole value of this module is that a forged assertion fails, and
a mock cannot demonstrate that. The helpers below encode CBOR and assemble
authenticator data the way a browser and authenticator would, so the tests
exercise the same bytes the production path sees.

The negative cases are the point. Each one removes exactly one security
property and asserts the ceremony is refused.
"""
from __future__ import annotations

import hashlib
import json

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa

from lib.webauthn import (
    COSE_ES256, COSE_RS256, FLAG_AT, FLAG_UP, FLAG_UV, WebAuthnError,
    b64url_decode, b64url_encode, cbor_decode, cose_to_public_key,
    parse_authenticator_data, verify_assertion, verify_registration,
)

RP_ID = "motherboard.example"
ORIGIN = "https://motherboard.example"
CHALLENGE = b"\x01\x02\x03\x04" * 8


# ── minimal CBOR encoder, for building fixtures ──────────────────────────

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
        return head(5, len(value)) + b"".join(
            cbor(k) + cbor(v) for k, v in value.items())
    raise TypeError(type(value))


# ── fixture builders ─────────────────────────────────────────────────────

def es256_cose(key: ec.EllipticCurvePublicKey) -> dict:
    n = key.public_numbers()
    return {1: 2, 3: COSE_ES256, -1: 1,
            -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")}


def rs256_cose(key: rsa.RSAPublicKey) -> dict:
    n = key.public_numbers()
    return {1: 3, 3: COSE_RS256,
            -1: n.n.to_bytes((n.n.bit_length() + 7) // 8, "big"),
            -2: n.e.to_bytes((n.e.bit_length() + 7) // 8, "big")}


def auth_data(*, rp_id: str = RP_ID, flags: int = FLAG_UP | FLAG_UV,
              sign_count: int = 0, cose: dict | None = None,
              cred_id: bytes = b"credential-0001") -> bytes:
    out = hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) \
        + sign_count.to_bytes(4, "big")
    if cose is not None:
        out += (b"\x00" * 16 + len(cred_id).to_bytes(2, "big") + cred_id
                + cbor(cose))
    return out


def client_data(*, typ: str, challenge: bytes = CHALLENGE,
                origin: str = ORIGIN, **extra) -> bytes:
    return json.dumps({"type": typ, "challenge": b64url_encode(challenge),
                       "origin": origin, **extra}).encode()


def attestation(cose: dict, **kw) -> bytes:
    return cbor({"fmt": "none", "attStmt": {},
                 "authData": auth_data(cose=cose, flags=kw.pop(
                     "flags", FLAG_UP | FLAG_UV | FLAG_AT), **kw)})


@pytest.fixture
def ec_key():
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture
def registered(ec_key):
    return verify_registration(
        client_data_json=client_data(typ="webauthn.create"),
        attestation_object=attestation(es256_cose(ec_key.public_key())),
        expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)


def sign_assertion(key, *, challenge: bytes = CHALLENGE, origin: str = ORIGIN,
                   sign_count: int = 1, rp_id: str = RP_ID,
                   flags: int = FLAG_UP | FLAG_UV, typ: str = "webauthn.get"):
    cd = client_data(typ=typ, challenge=challenge, origin=origin)
    ad = auth_data(rp_id=rp_id, flags=flags, sign_count=sign_count)
    sig = key.sign(ad + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
    return cd, ad, sig


# ── base64url ────────────────────────────────────────────────────────────

class TestBase64Url:
    def test_round_trips_without_padding(self):
        for raw in (b"", b"a", b"ab", b"abc", bytes(range(256))):
            assert b64url_decode(b64url_encode(raw)) == raw

    def test_accepts_the_unpadded_form_a_browser_sends(self):
        assert b64url_decode("YWJj") == b"abc"

    def test_uses_the_URL_alphabet_not_standard_base64(self):
        # Standard base64 would emit + and /, which are not URL-safe and would
        # be mangled in transit.
        enc = b64url_encode(b"\xfb\xff")
        assert "+" not in enc and "/" not in enc

    def test_REFUSES_malformed_input_rather_than_truncating(self):
        # Every value decoded here is attacker-controlled, so a silent partial
        # decode would be a parser disagreement waiting to happen.
        with pytest.raises(WebAuthnError):
            b64url_decode("!!!not base64!!!")


# ── CBOR ─────────────────────────────────────────────────────────────────

class TestCbor:
    @pytest.mark.parametrize("value", [
        0, 1, 23, 24, 255, 256, 65535, 65536, -1, -100,
        b"", b"bytes", "text", [1, 2, 3], {1: 2, -7: b"x"}, True, False,
        {"fmt": "none", "attStmt": {}, "authData": b"\x00" * 40},
    ])
    def test_round_trips_every_type_webauthn_uses(self, value):
        assert cbor_decode(cbor(value)) == value

    def test_REFUSES_indefinite_length_items(self):
        # CTAP2 mandates canonical, definite-length CBOR. A response using an
        # indefinite length is not conforming, and supporting it would only
        # widen what this parser has to be correct about.
        with pytest.raises(WebAuthnError):
            cbor_decode(bytes([0x5F, 0x41, 0x61, 0xFF]))

    def test_REFUSES_trailing_bytes(self):
        # Trailing data means the input is not what it claimed to be.
        with pytest.raises(WebAuthnError):
            cbor_decode(cbor(1) + b"\x00")

    def test_REFUSES_a_truncated_item(self):
        with pytest.raises(WebAuthnError):
            cbor_decode(bytes([0x42, 0x61]))       # 2-byte string, 1 byte given

    def test_does_not_hang_on_a_huge_declared_length(self):
        # A 4GB length header with no payload must fail immediately rather
        # than trying to allocate.
        with pytest.raises(WebAuthnError):
            cbor_decode(bytes([0x5A, 0xFF, 0xFF, 0xFF, 0xFF]))


# ── COSE keys ────────────────────────────────────────────────────────────

class TestCoseKeys:
    def test_reads_an_EC_P256_key(self, ec_key):
        got = cose_to_public_key(es256_cose(ec_key.public_key()))
        assert got.public_numbers() == ec_key.public_key().public_numbers()

    def test_reads_an_RSA_key(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        got = cose_to_public_key(rs256_cose(key.public_key()))
        assert got.public_numbers() == key.public_key().public_numbers()

    def test_reads_an_Ed25519_key(self):
        key = ed25519.Ed25519PrivateKey.generate()
        raw = key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        got = cose_to_public_key({1: 1, 3: -8, -1: 6, -2: raw})
        assert got.public_bytes(serialization.Encoding.Raw,
                                serialization.PublicFormat.Raw) == raw

    def test_refuses_an_unknown_key_type(self):
        with pytest.raises(WebAuthnError):
            cose_to_public_key({1: 99, 3: -7})

    def test_refuses_a_key_with_missing_coordinates(self):
        with pytest.raises(WebAuthnError):
            cose_to_public_key({1: 2, 3: COSE_ES256, -1: 1})


# ── authenticator data ───────────────────────────────────────────────────

class TestAuthenticatorData:
    def test_reads_the_flags_and_counter(self):
        a = parse_authenticator_data(auth_data(flags=FLAG_UP | FLAG_UV,
                                               sign_count=42))
        assert a.user_present and a.user_verified and a.sign_count == 42

    def test_separates_presence_from_verification(self, ec_key):
        # A bare touch sets UP but not UV. Only UV means a fingerprint or face
        # was actually matched, and conflating them would claim biometric
        # verification that never happened.
        a = parse_authenticator_data(auth_data(flags=FLAG_UP))
        assert a.user_present and not a.user_verified

    def test_extracts_the_credential_when_attested(self, ec_key):
        a = parse_authenticator_data(
            auth_data(flags=FLAG_UP | FLAG_AT, cose=es256_cose(ec_key.public_key()),
                      cred_id=b"abc"))
        assert a.credential_id == b"abc"
        assert a.cose_key[3] == COSE_ES256

    def test_refuses_data_too_short_to_hold_a_header(self):
        with pytest.raises(WebAuthnError):
            parse_authenticator_data(b"\x00" * 36)

    def test_refuses_an_out_of_range_credential_length(self):
        # Without the ceiling a bogus length becomes a huge slice.
        bad = (hashlib.sha256(RP_ID.encode()).digest() + bytes([FLAG_UP | FLAG_AT])
               + (0).to_bytes(4, "big") + b"\x00" * 16 + (9999).to_bytes(2, "big"))
        with pytest.raises(WebAuthnError):
            parse_authenticator_data(bad)


# ── registration ─────────────────────────────────────────────────────────

class TestRegistration:
    def test_accepts_a_well_formed_ceremony(self, registered):
        assert registered.algorithm == COSE_ES256
        assert registered.credential_id == b64url_encode(b"credential-0001")
        assert registered.user_verified is True

    def test_stores_a_key_that_can_be_loaded_back(self, registered, ec_key):
        loaded = serialization.load_der_public_key(
            b64url_decode(registered.public_key))
        assert loaded.public_numbers() == ec_key.public_key().public_numbers()

    def test_REFUSES_a_challenge_that_does_not_match(self, ec_key):
        with pytest.raises(WebAuthnError, match="challenge"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.create",
                                             challenge=b"different" * 4),
                attestation_object=attestation(es256_cose(ec_key.public_key())),
                expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)

    def test_REFUSES_a_lookalike_origin(self, ec_key):
        # A prefix or suffix check would let every one of these through.
        for evil in ("https://motherboard.example.evil.net",
                     "https://notmotherboard.example",
                     "http://motherboard.example",
                     "https://motherboard.example:8443"):
            with pytest.raises(WebAuthnError, match="origin"):
                verify_registration(
                    client_data_json=client_data(typ="webauthn.create",
                                                 origin=evil),
                    attestation_object=attestation(es256_cose(ec_key.public_key())),
                    expected_challenge=CHALLENGE, expected_origin=ORIGIN,
                    rp_id=RP_ID)

    def test_REFUSES_a_credential_issued_for_another_domain(self, ec_key):
        # The RP ID hash is inside the signed data, so this is what stops a
        # passkey minted for one site being presented at another.
        att = cbor({"fmt": "none", "attStmt": {},
                    "authData": auth_data(rp_id="attacker.example",
                                          flags=FLAG_UP | FLAG_AT,
                                          cose=es256_cose(ec_key.public_key()))})
        with pytest.raises(WebAuthnError, match="relying-party"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.create"),
                attestation_object=att, expected_challenge=CHALLENGE,
                expected_origin=ORIGIN, rp_id=RP_ID)

    def test_REFUSES_an_authentication_response_replayed_as_registration(self, ec_key):
        with pytest.raises(WebAuthnError, match="ceremony type"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.get"),
                attestation_object=attestation(es256_cose(ec_key.public_key())),
                expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)

    def test_REFUSES_when_no_user_was_present(self, ec_key):
        with pytest.raises(WebAuthnError, match="presence"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.create"),
                attestation_object=attestation(es256_cose(ec_key.public_key()),
                                               flags=FLAG_AT),
                expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)

    def test_can_REQUIRE_a_biometric_rather_than_a_touch(self, ec_key):
        with pytest.raises(WebAuthnError, match="user verification"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.create"),
                attestation_object=attestation(es256_cose(ec_key.public_key()),
                                               flags=FLAG_UP | FLAG_AT),
                expected_challenge=CHALLENGE, expected_origin=ORIGIN,
                rp_id=RP_ID, require_user_verification=True)

    def test_REFUSES_a_cross_origin_ceremony(self, ec_key):
        with pytest.raises(WebAuthnError, match="cross-origin"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.create",
                                             crossOrigin=True),
                attestation_object=attestation(es256_cose(ec_key.public_key())),
                expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)

    def test_refuses_an_algorithm_it_will_not_verify(self, ec_key):
        cose = {**es256_cose(ec_key.public_key()), 3: -65535}
        with pytest.raises(WebAuthnError, match="algorithm"):
            verify_registration(
                client_data_json=client_data(typ="webauthn.create"),
                attestation_object=attestation(cose),
                expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)

    def test_accepts_any_of_several_allowed_origins(self, ec_key):
        # Preview deployments need this; each one is still an exact match.
        got = verify_registration(
            client_data_json=client_data(typ="webauthn.create",
                                         origin="https://preview.example"),
            attestation_object=attestation(es256_cose(ec_key.public_key())),
            expected_challenge=CHALLENGE,
            expected_origin=(ORIGIN, "https://preview.example"), rp_id=RP_ID)
        assert got.credential_id


# ── authentication ───────────────────────────────────────────────────────

class TestAssertion:
    def _verify(self, registered, cd, ad, sig, **kw):
        return verify_assertion(
            client_data_json=cd, authenticator_data=ad, signature=sig,
            public_key_spki=b64url_decode(registered.public_key),
            algorithm=registered.algorithm, expected_challenge=CHALLENGE,
            expected_origin=ORIGIN, rp_id=RP_ID, **kw)

    def test_accepts_a_genuine_signature(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key)
        assert self._verify(registered, cd, ad, sig).new_sign_count == 1

    def test_REFUSES_a_signature_from_a_DIFFERENT_key(self, registered):
        # The whole point: possession of the private key is the credential.
        cd, ad, sig = sign_assertion(ec.generate_private_key(ec.SECP256R1()))
        with pytest.raises(WebAuthnError, match="signature"):
            self._verify(registered, cd, ad, sig)

    def test_REFUSES_tampered_authenticator_data(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key)
        tampered = ad[:32] + bytes([ad[32]]) + (999).to_bytes(4, "big")
        with pytest.raises(WebAuthnError):
            self._verify(registered, cd, tampered, sig)

    def test_REFUSES_a_swapped_client_data(self, ec_key, registered):
        # The signature covers both halves together, so one cannot be
        # exchanged for another validly-signed one.
        cd, ad, sig = sign_assertion(ec_key)
        other = client_data(typ="webauthn.get", challenge=CHALLENGE,
                            origin=ORIGIN, extra="x")
        with pytest.raises(WebAuthnError):
            self._verify(registered, other, ad, sig)

    def test_REFUSES_a_replayed_challenge(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key, challenge=b"stale-challenge!" * 2)
        with pytest.raises(WebAuthnError, match="challenge"):
            self._verify(registered, cd, ad, sig)

    def test_REFUSES_a_lookalike_origin(self, ec_key, registered):
        cd, ad, sig = sign_assertion(
            ec_key, origin="https://motherboard.example.evil.net")
        with pytest.raises(WebAuthnError, match="origin"):
            self._verify(registered, cd, ad, sig)

    def test_REFUSES_a_registration_response_replayed_as_login(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key, typ="webauthn.create")
        with pytest.raises(WebAuthnError, match="ceremony type"):
            self._verify(registered, cd, ad, sig)

    def test_REFUSES_a_credential_asserted_against_another_domain(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key, rp_id="attacker.example")
        with pytest.raises(WebAuthnError, match="relying-party"):
            self._verify(registered, cd, ad, sig)

    def test_REFUSES_a_counter_that_went_BACKWARDS(self, ec_key, registered):
        # A counter going backwards means two authenticators are answering for
        # one credential — the signal that a key has been cloned.
        cd, ad, sig = sign_assertion(ec_key, sign_count=5)
        with pytest.raises(WebAuthnError, match="counter"):
            self._verify(registered, cd, ad, sig, stored_sign_count=9)

    def test_REFUSES_a_counter_that_stood_still_once_in_use(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key, sign_count=7)
        with pytest.raises(WebAuthnError, match="counter"):
            self._verify(registered, cd, ad, sig, stored_sign_count=7)

    def test_ALLOWS_an_authenticator_that_keeps_no_counter(self, ec_key, registered):
        # Most platform passkeys report 0 forever. Rejecting those would lock
        # out the majority of real users.
        cd, ad, sig = sign_assertion(ec_key, sign_count=0)
        assert self._verify(registered, cd, ad, sig, stored_sign_count=0)

    def test_can_REQUIRE_a_biometric_rather_than_a_touch(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key, flags=FLAG_UP)
        with pytest.raises(WebAuthnError, match="user verification"):
            self._verify(registered, cd, ad, sig, require_user_verification=True)

    def test_reports_whether_a_biometric_was_used(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key, flags=FLAG_UP | FLAG_UV)
        assert self._verify(registered, cd, ad, sig).user_verified is True

    def test_refuses_an_unreadable_stored_key(self, ec_key, registered):
        cd, ad, sig = sign_assertion(ec_key)
        with pytest.raises(WebAuthnError, match="unreadable"):
            verify_assertion(
                client_data_json=cd, authenticator_data=ad, signature=sig,
                public_key_spki=b"not a key", algorithm=COSE_ES256,
                expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)


class TestRsaAssertion:
    def test_verifies_an_RS256_credential(self):
        # Older Windows Hello TPMs produce these rather than EC.
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        reg = verify_registration(
            client_data_json=client_data(typ="webauthn.create"),
            attestation_object=attestation(rs256_cose(key.public_key())),
            expected_challenge=CHALLENGE, expected_origin=ORIGIN, rp_id=RP_ID)
        assert reg.algorithm == COSE_RS256

        cd = client_data(typ="webauthn.get")
        ad = auth_data(sign_count=3)
        sig = key.sign(ad + hashlib.sha256(cd).digest(),
                       padding.PKCS1v15(), hashes.SHA256())
        got = verify_assertion(
            client_data_json=cd, authenticator_data=ad, signature=sig,
            public_key_spki=b64url_decode(reg.public_key),
            algorithm=reg.algorithm, expected_challenge=CHALLENGE,
            expected_origin=ORIGIN, rp_id=RP_ID)
        assert got.new_sign_count == 3
