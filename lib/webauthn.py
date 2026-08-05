"""WebAuthn passkey verification.

Passkeys SUPPLEMENT the password here — they never replace it. A user who
loses the device still signs in the way they always did, which is what makes
this safe to ship without also designing an account-recovery flow first.

Nothing secret about the user ever reaches this server. The fingerprint or
face scan is matched by the device, against data held in the device's secure
element, and the only thing that crosses the network is a signature proving
"the authenticator holding private key K agreed to this specific challenge".
This module checks that proof.

WHY THE PARSING IS HAND-WRITTEN. The two libraries normally used for this
(`webauthn`, `cbor2`) are not installable in the environment this was built
in, and adding an unvettable dependency to the authentication path is a worse
trade than writing the subset that is actually needed. WebAuthn's CBOR usage
is small and fixed: CTAP2 mandates canonical, definite-length encodings, so
the decoder below deliberately REFUSES indefinite-length items rather than
supporting them — a stream that uses one is not a conforming authenticator
response, and accepting it would only widen what this code has to be correct
about.

The security properties that matter are all in `verify_registration` and
`verify_assertion`:

  - the challenge is compared in constant time, and the caller must have
    issued it, stored it once, and deleted it on use (replay protection lives
    in the caller because it owns the storage)
  - the origin is matched exactly, never by prefix or suffix — `evil-app.com`
    must not pass a check meant for `app.com`
  - the RP ID hash inside the signed authenticator data is checked against
    the configured relying-party ID, which is what stops a credential issued
    for one domain being replayed at another
  - the signature covers authenticatorData || SHA-256(clientDataJSON), so
    neither half can be swapped independently
  - the signature counter must advance when the authenticator uses one, which
    is the only available signal that a credential has been cloned
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa


class WebAuthnError(Exception):
    """A ceremony failed verification.

    Deliberately one type with a plain message: the caller returns a single
    generic failure to the client regardless of which check failed, because
    telling an attacker WHICH part of their forgery was wrong is free help.
    """


# ── base64url ────────────────────────────────────────────────────────────

def b64url_decode(s: str | bytes) -> bytes:
    """Decode WebAuthn's unpadded base64url.

    Strict: anything that is not valid base64url raises rather than decoding
    to something shorter and continuing, because every value that arrives
    this way is attacker-controlled.
    """
    if isinstance(s, bytes):
        s = s.decode("ascii", errors="strict")
    s = s.strip()
    pad = "=" * (-len(s) % 4)
    try:
        return base64.urlsafe_b64decode(s + pad)
    except Exception as exc:                      # binascii.Error, UnicodeError
        raise WebAuthnError("malformed base64url") from exc


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


# ── the CBOR subset CTAP2 actually emits ─────────────────────────────────

_CBOR_BREAK = 0xFF


class _Cbor:
    """Definite-length CBOR decoder, tracking how much it consumed.

    The position matters: an attested credential's COSE key is a CBOR map
    embedded in a fixed-layout byte string, and the extensions that follow it
    can only be located by knowing where the map ended.
    """

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def _take(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self.data):
            raise WebAuthnError("truncated CBOR")
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def _head(self) -> tuple[int, int]:
        (b,) = self._take(1)
        major, minor = b >> 5, b & 0x1F
        if minor < 24:
            return major, minor
        if minor == 24:
            return major, self._take(1)[0]
        if minor == 25:
            return major, int.from_bytes(self._take(2), "big")
        if minor == 26:
            return major, int.from_bytes(self._take(4), "big")
        if minor == 27:
            return major, int.from_bytes(self._take(8), "big")
        # 31 is indefinite length. CTAP2 canonical CBOR forbids it, so a
        # response containing one is not conforming and is refused rather
        # than parsed.
        raise WebAuthnError("unsupported CBOR length encoding")

    def decode(self) -> Any:
        major, arg = self._head()
        if major == 0:
            return arg
        if major == 1:
            return -1 - arg
        if major == 2:
            return self._take(arg)
        if major == 3:
            return self._take(arg).decode("utf-8", errors="strict")
        if major == 4:
            return [self.decode() for _ in range(arg)]
        if major == 5:
            out: dict[Any, Any] = {}
            for _ in range(arg):
                k = self.decode()
                if isinstance(k, bytes):
                    raise WebAuthnError("unsupported CBOR map key")
                out[k] = self.decode()
            return out
        if major == 6:
            return self.decode()                  # tag: unwrap the content
        if major == 7:
            if arg == 20:
                return False
            if arg == 21:
                return True
            if arg in (22, 23):
                return None
            raise WebAuthnError("unsupported CBOR simple value")
        raise WebAuthnError("unsupported CBOR major type")


def cbor_decode(data: bytes) -> Any:
    """Decode one CBOR item, refusing trailing bytes.

    Trailing data means the input is not what it claimed to be, and ignoring
    it is how parsers end up disagreeing about the same message.
    """
    d = _Cbor(data)
    value = d.decode()
    if d.pos != len(data):
        raise WebAuthnError("trailing bytes after CBOR item")
    return value


# ── COSE keys ────────────────────────────────────────────────────────────

COSE_ES256 = -7
COSE_EdDSA = -8
COSE_ES384 = -35
COSE_ES512 = -36
COSE_PS256 = -37
COSE_RS256 = -257

# What a browser may offer during registration, best first. ES256 is what
# essentially every platform authenticator (Touch ID, Windows Hello, Android)
# produces; RS256 is here for older Windows Hello TPMs.
SUPPORTED_ALGORITHMS = (COSE_ES256, COSE_EdDSA, COSE_RS256)

_EC_CURVES = {1: ec.SECP256R1(), 2: ec.SECP384R1(), 3: ec.SECP521R1()}


def cose_to_public_key(cose: dict):
    """A COSE_Key map -> a `cryptography` public key object."""
    if not isinstance(cose, dict):
        raise WebAuthnError("credential public key is not a COSE map")
    kty = cose.get(1)
    alg = cose.get(3)

    if kty == 2:                                  # EC2
        curve = _EC_CURVES.get(cose.get(-1))
        x, y = cose.get(-2), cose.get(-3)
        if curve is None or not isinstance(x, bytes) or not isinstance(y, bytes):
            raise WebAuthnError("malformed EC2 credential public key")
        return ec.EllipticCurvePublicNumbers(
            int.from_bytes(x, "big"), int.from_bytes(y, "big"), curve,
        ).public_key()

    if kty == 3:                                  # RSA
        n, e = cose.get(-1), cose.get(-2)
        if not isinstance(n, bytes) or not isinstance(e, bytes):
            raise WebAuthnError("malformed RSA credential public key")
        return rsa.RSAPublicNumbers(
            int.from_bytes(e, "big"), int.from_bytes(n, "big"),
        ).public_key()

    if kty == 1:                                  # OKP (Ed25519)
        x = cose.get(-2)
        if cose.get(-1) != 6 or not isinstance(x, bytes):
            raise WebAuthnError("malformed OKP credential public key")
        return ed25519.Ed25519PublicKey.from_public_bytes(x)

    raise WebAuthnError(f"unsupported credential key type {kty!r} (alg {alg!r})")


def _verify_signature(public_key, alg: int, signature: bytes, message: bytes) -> None:
    try:
        if isinstance(public_key, ec.EllipticCurvePublicKey):
            digest = {COSE_ES256: hashes.SHA256(), COSE_ES384: hashes.SHA384(),
                      COSE_ES512: hashes.SHA512()}.get(alg, hashes.SHA256())
            public_key.verify(signature, message, ec.ECDSA(digest))
        elif isinstance(public_key, rsa.RSAPublicKey):
            if alg == COSE_PS256:
                public_key.verify(
                    signature, message,
                    padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                                salt_length=padding.PSS.DIGEST_LENGTH),
                    hashes.SHA256())
            else:
                public_key.verify(signature, message,
                                  padding.PKCS1v15(), hashes.SHA256())
        elif isinstance(public_key, ed25519.Ed25519PublicKey):
            public_key.verify(signature, message)
        else:
            raise WebAuthnError("unsupported credential key type")
    except InvalidSignature as exc:
        raise WebAuthnError("signature did not verify") from exc


# ── authenticator data ───────────────────────────────────────────────────

FLAG_UP = 0x01     # user was present (touched the sensor)
FLAG_UV = 0x04     # user was verified (biometric or PIN, not just presence)
FLAG_AT = 0x40     # attested credential data is included
FLAG_ED = 0x80     # extension data is included


@dataclass
class AuthenticatorData:
    rp_id_hash: bytes
    flags: int
    sign_count: int
    aaguid: bytes | None = None
    credential_id: bytes | None = None
    cose_key: dict | None = None

    @property
    def user_present(self) -> bool:
        return bool(self.flags & FLAG_UP)

    @property
    def user_verified(self) -> bool:
        """True when the device actually checked a fingerprint/face/PIN.

        Distinct from presence: a bare touch sets UP but not UV, and only UV
        means a biometric was matched.
        """
        return bool(self.flags & FLAG_UV)


def parse_authenticator_data(data: bytes) -> AuthenticatorData:
    if len(data) < 37:
        raise WebAuthnError("authenticator data too short")
    out = AuthenticatorData(
        rp_id_hash=data[:32],
        flags=data[32],
        sign_count=int.from_bytes(data[33:37], "big"),
    )
    rest = data[37:]
    if out.flags & FLAG_AT:
        if len(rest) < 18:
            raise WebAuthnError("attested credential data truncated")
        out.aaguid = rest[:16]
        cred_len = int.from_bytes(rest[16:18], "big")
        # A 1KB ceiling on the credential id: the spec caps it at 1023 bytes,
        # and without the check a bogus length turns into a huge slice.
        if cred_len > 1023 or len(rest) < 18 + cred_len:
            raise WebAuthnError("credential id length is out of range")
        out.credential_id = rest[18:18 + cred_len]
        d = _Cbor(rest[18 + cred_len:])
        out.cose_key = d.decode()
    return out


# ── clientDataJSON ───────────────────────────────────────────────────────

def _check_client_data(client_data_json: bytes, *, expected_type: str,
                       expected_challenge: bytes,
                       expected_origins: tuple[str, ...]) -> dict:
    try:
        cd = json.loads(client_data_json.decode("utf-8"))
    except Exception as exc:
        raise WebAuthnError("clientDataJSON is not valid JSON") from exc
    if not isinstance(cd, dict):
        raise WebAuthnError("clientDataJSON is not an object")

    if cd.get("type") != expected_type:
        # Stops a registration response being replayed as an authentication
        # one, which is the reason the field exists.
        raise WebAuthnError("wrong ceremony type")

    got = b64url_decode(cd.get("challenge") or "")
    if not hmac.compare_digest(got, expected_challenge):
        raise WebAuthnError("challenge did not match")

    # Exact match only. A prefix or suffix test here would let
    # `app.com.evil.net` or `notapp.com` through.
    if cd.get("origin") not in expected_origins:
        raise WebAuthnError("origin not allowed")

    if cd.get("crossOrigin") is True:
        raise WebAuthnError("cross-origin ceremony refused")
    return cd


def _origins(expected_origin: str | tuple[str, ...] | list[str]) -> tuple[str, ...]:
    if isinstance(expected_origin, str):
        return (expected_origin,)
    return tuple(expected_origin)


# ── ceremonies ───────────────────────────────────────────────────────────

@dataclass
class RegisteredCredential:
    credential_id: str            # base64url
    public_key: str               # base64url SPKI DER
    sign_count: int
    algorithm: int
    user_verified: bool
    aaguid: str | None


def verify_registration(*, client_data_json: bytes, attestation_object: bytes,
                        expected_challenge: bytes,
                        expected_origin: str | tuple[str, ...] | list[str],
                        rp_id: str,
                        require_user_verification: bool = False,
                        ) -> RegisteredCredential:
    """Check a `navigator.credentials.create()` response and extract the key.

    Attestation statements are deliberately NOT verified. Attestation proves
    which make and model of authenticator was used, which matters when an
    enterprise needs to mandate specific hardware; here it would only let the
    app refuse a user's own perfectly good phone, and verifying it properly
    means shipping and maintaining a root-certificate store. The registration
    already happens inside an authenticated session, so the question "is this
    the right user" is answered before this function is reached.
    """
    _check_client_data(client_data_json, expected_type="webauthn.create",
                       expected_challenge=expected_challenge,
                       expected_origins=_origins(expected_origin))

    att = cbor_decode(attestation_object)
    if not isinstance(att, dict) or not isinstance(att.get("authData"), bytes):
        raise WebAuthnError("malformed attestation object")

    auth = parse_authenticator_data(att["authData"])
    if not hmac.compare_digest(auth.rp_id_hash, hashlib.sha256(rp_id.encode()).digest()):
        raise WebAuthnError("relying-party id mismatch")
    if not auth.user_present:
        raise WebAuthnError("authenticator reported no user presence")
    if require_user_verification and not auth.user_verified:
        raise WebAuthnError("user verification required but not performed")
    if not auth.credential_id or auth.cose_key is None:
        raise WebAuthnError("attestation contained no credential")

    alg = auth.cose_key.get(3)
    if alg not in SUPPORTED_ALGORITHMS:
        raise WebAuthnError(f"unsupported credential algorithm {alg!r}")

    public_key = cose_to_public_key(auth.cose_key)
    spki = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo)

    return RegisteredCredential(
        credential_id=b64url_encode(auth.credential_id),
        public_key=b64url_encode(spki),
        sign_count=auth.sign_count,
        algorithm=int(alg),
        user_verified=auth.user_verified,
        aaguid=auth.aaguid.hex() if auth.aaguid else None,
    )


@dataclass
class AssertionResult:
    new_sign_count: int
    user_verified: bool


def verify_assertion(*, client_data_json: bytes, authenticator_data: bytes,
                     signature: bytes, public_key_spki: bytes,
                     algorithm: int, expected_challenge: bytes,
                     expected_origin: str | tuple[str, ...] | list[str],
                     rp_id: str, stored_sign_count: int = 0,
                     require_user_verification: bool = False,
                     ) -> AssertionResult:
    """Check a `navigator.credentials.get()` response against a stored key."""
    _check_client_data(client_data_json, expected_type="webauthn.get",
                       expected_challenge=expected_challenge,
                       expected_origins=_origins(expected_origin))

    auth = parse_authenticator_data(authenticator_data)
    if not hmac.compare_digest(auth.rp_id_hash, hashlib.sha256(rp_id.encode()).digest()):
        raise WebAuthnError("relying-party id mismatch")
    if not auth.user_present:
        raise WebAuthnError("authenticator reported no user presence")
    if require_user_verification and not auth.user_verified:
        raise WebAuthnError("user verification required but not performed")

    try:
        public_key = serialization.load_der_public_key(public_key_spki)
    except Exception as exc:
        raise WebAuthnError("stored credential key is unreadable") from exc

    # The signature covers both halves together, so neither the authenticator
    # data nor the client data can be swapped independently.
    message = authenticator_data + hashlib.sha256(client_data_json).digest()
    _verify_signature(public_key, algorithm, signature, message)

    # A counter that goes backwards means two authenticators are answering for
    # one credential, i.e. the key was cloned. Authenticators that do not
    # implement a counter report 0 forever, and rejecting those would lock out
    # most platform passkeys — so the check applies only once a counter is in
    # use.
    if auth.sign_count or stored_sign_count:
        if auth.sign_count <= stored_sign_count:
            raise WebAuthnError("signature counter did not advance")

    return AssertionResult(new_sign_count=auth.sign_count,
                           user_verified=auth.user_verified)
