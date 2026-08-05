"""Passkey registration and login.

Mounted under its own `/auth/passkey` prefix so it gets its OWN rate-limit
bucket. That is not cosmetic: exhausting the passkey budget must never block
the password form, which is the fallback that exists for exactly the moment
when the passkey is not working.

Login is usernameless. The browser holds the credential, shows its own account
picker, and sends back only a credential id — so there is no username field to
enumerate and no "which account?" step before the biometric prompt. That is
what makes this feel like the OS password manager rather than a second login
form.

Registration always happens inside an authenticated session. The question "is
this really you" is therefore answered by the session before a key is ever
enrolled, which is why attestation is not verified (see lib/webauthn.py).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend import auth
from backend.config import (
    WEBAUTHN_ORIGINS, WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME,
)
from lib import auth as user_store
from lib import passkey_store as store
from lib import webauthn

router = APIRouter(prefix="/auth/passkey", tags=["auth"])

# One message for every failure. Telling a caller WHICH check failed — unknown
# credential, bad signature, stale challenge — is free reconnaissance, and the
# user can do nothing differently with the detail anyway.
_GENERIC = "Could not verify that passkey. Sign in with your password instead."


class RegisterFinish(BaseModel):
    handle: str
    credential_id: str = Field(..., max_length=1500)
    client_data_json: str = Field(..., max_length=8000)
    attestation_object: str = Field(..., max_length=32000)
    label: str = Field("", max_length=60)


class LoginFinish(BaseModel):
    handle: str
    credential_id: str = Field(..., max_length=1500)
    client_data_json: str = Field(..., max_length=8000)
    authenticator_data: str = Field(..., max_length=8000)
    signature: str = Field(..., max_length=8000)


def _b64(field: str, value: str) -> bytes:
    try:
        return webauthn.b64url_decode(value)
    except webauthn.WebAuthnError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Malformed {field}.")


@router.get("/support")
def support():
    """What the login page needs to know before offering a passkey button.

    Public: it reveals only which domain this deployment binds credentials to,
    which the browser already knows, and nothing about any account.
    """
    return {"rp_id": WEBAUTHN_RP_ID, "rp_name": WEBAUTHN_RP_NAME}


# ── registration (authenticated) ─────────────────────────────────────────

@router.post("/register/begin")
def register_begin(user: dict = Depends(auth.current_user)):
    username = user["username"]
    handle, raw = store.new_challenge(username)
    return {
        "handle": handle,
        "challenge": webauthn.b64url_encode(raw),
        "rp": {"id": WEBAUTHN_RP_ID, "name": WEBAUTHN_RP_NAME},
        "user": {
            "id": store.user_handle(username),
            "name": username,
            "displayName": username,
        },
        # ES256 first, then RS256 for older Windows Hello TPMs. Anything the
        # browser picks outside this list is refused at verification, so the
        # list is the contract rather than a hint.
        "pubKeyCredParams": [
            {"type": "public-key", "alg": webauthn.COSE_ES256},
            {"type": "public-key", "alg": webauthn.COSE_RS256},
        ],
        # Platform + resident + preferred UV is what produces the intended
        # experience: a key that lives in the laptop's secure element or the
        # phone's keychain, is discoverable without typing a username, and
        # asks for the fingerprint rather than just a tap.
        "authenticatorSelection": {
            "authenticatorAttachment": "platform",
            "residentKey": "required",
            "requireResidentKey": True,
            "userVerification": "preferred",
        },
        # Stops a second enrolment on a device that already has one, which
        # would otherwise silently create a duplicate credential.
        "excludeCredentials": [
            {"type": "public-key", "id": c["id"]}
            for c in store.credentials_for(username)
        ],
        "timeout": store.CHALLENGE_TTL_SECONDS * 1000,
        "attestation": "none",
    }


@router.post("/register/finish", status_code=201)
def register_finish(body: RegisterFinish, user: dict = Depends(auth.current_user)):
    username = user["username"]
    taken = store.take_challenge(body.handle)
    if taken is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That enrolment expired — try again.")
    challenge, issued_for = taken
    # The challenge was minted for one account; using it under another session
    # would let a second user's registration ride on the first's ceremony.
    if issued_for and issued_for.lower() != username.lower():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _GENERIC)

    try:
        cred = webauthn.verify_registration(
            client_data_json=_b64("client data", body.client_data_json),
            attestation_object=_b64("attestation", body.attestation_object),
            expected_challenge=challenge,
            expected_origin=tuple(WEBAUTHN_ORIGINS),
            rp_id=WEBAUTHN_RP_ID,
        )
    except webauthn.WebAuthnError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That passkey could not be registered.")

    ok, message = store.add_credential(
        username, credential_id=cred.credential_id, public_key=cred.public_key,
        sign_count=cred.sign_count, algorithm=cred.algorithm,
        label=body.label or "Passkey", aaguid=cred.aaguid)
    if not ok:
        raise HTTPException(status.HTTP_409_CONFLICT, message)
    return {"ok": True, "message": message,
            "credentials": store.public_list(username)}


@router.get("/credentials")
def list_credentials(user: dict = Depends(auth.current_user)):
    return {"credentials": store.public_list(user["username"])}


@router.delete("/credentials/{credential_id:path}", status_code=204)
def delete_credential(credential_id: str,
                      user: dict = Depends(auth.current_user)):
    if not store.remove_credential(user["username"], credential_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such passkey.")


# ── login (anonymous) ────────────────────────────────────────────────────

@router.post("/login/begin")
def login_begin():
    """Mint a challenge for a usernameless assertion.

    Takes no body on purpose. Asking for a username here would turn this into
    an enumeration oracle (does this account have a passkey?) and would spoil
    the experience the feature exists for — the browser already knows which
    credentials it holds for this site.
    """
    handle, raw = store.new_challenge(None)
    return {
        "handle": handle,
        "challenge": webauthn.b64url_encode(raw),
        "rpId": WEBAUTHN_RP_ID,
        "timeout": store.CHALLENGE_TTL_SECONDS * 1000,
        "userVerification": "preferred",
        # Empty: the authenticator offers whatever it holds for this RP ID.
        "allowCredentials": [],
    }


@router.post("/login/finish")
def login_finish(body: LoginFinish):
    taken = store.take_challenge(body.handle)
    if taken is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _GENERIC)
    challenge, _issued_for = taken

    found = store.find_credential(body.credential_id)
    if not found:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _GENERIC)
    username, cred = found

    # Checked before the signature so a deactivated account cannot be revived
    # by a passkey that was enrolled while it was live.
    record = user_store.get_user(username)
    if not record:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _GENERIC)

    try:
        result = webauthn.verify_assertion(
            client_data_json=_b64("client data", body.client_data_json),
            authenticator_data=_b64("authenticator data", body.authenticator_data),
            signature=_b64("signature", body.signature),
            public_key_spki=webauthn.b64url_decode(cred["public_key"]),
            algorithm=int(cred.get("algorithm") or webauthn.COSE_ES256),
            expected_challenge=challenge,
            expected_origin=tuple(WEBAUTHN_ORIGINS),
            rp_id=WEBAUTHN_RP_ID,
            stored_sign_count=int(cred.get("sign_count") or 0),
        )
    except webauthn.WebAuthnError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _GENERIC)

    # Must be persisted, or the clone check compares against a counter that
    # never advances and is effectively switched off after the first login.
    store.record_use(username, body.credential_id, result.new_sign_count)

    token = auth.issue_token(record)
    # The client remembers this to offer "continue as X" next time, the way a
    # browser password manager does.
    return {**token, "username": record["username"]}
