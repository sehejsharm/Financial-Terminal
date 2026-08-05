/** Browser side of passkey sign-in.
 *
 *  The point of this feature is that signing in should feel like unlocking the
 *  device, because that is literally what happens: the fingerprint or face is
 *  matched by the laptop or phone, against data in its secure element, and
 *  never travels. What crosses the network is a signature over a
 *  server-issued challenge.
 *
 *  Passkeys SUPPLEMENT the password here. Everything below is allowed to fail
 *  — no platform authenticator, a browser that does not support WebAuthn, a
 *  user who cancels the prompt, a credential minted for a domain the app has
 *  since moved off — and every one of those failures has to land the user on
 *  the password form rather than on an error. That is why `available()` probes
 *  rather than assumes, and why the caller treats a rejected promise as "show
 *  the password form", not "something is broken".
 *
 *  The one thing NOT handled here is a domain change. A passkey is bound to
 *  the exact relying-party id it was created under, so moving the app to a new
 *  domain silently stops the browser offering existing credentials. The
 *  recovery is the password, and then enrolling again.
 */

/** WebAuthn speaks ArrayBuffers; the API speaks unpadded base64url. */
export function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBuf(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/** Is WebAuthn usable at all in this browser? */
export function supported(): boolean {
  return typeof window !== "undefined"
    && typeof window.PublicKeyCredential === "function"
    && !!navigator.credentials;
}

/**
 * Is there a built-in authenticator — Touch ID, Windows Hello, Android?
 *
 * Distinct from `supported()`: a desktop browser can support WebAuthn while
 * having nothing but a USB key available, and offering "sign in with your
 * fingerprint" there is a promise the device cannot keep. Resolves false
 * rather than throwing, because a probe that fails is just a "no".
 */
export async function available(): Promise<boolean> {
  if (!supported()) return false;
  try {
    return await window.PublicKeyCredential
      .isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** True when the user dismissed the prompt rather than the ceremony failing.
 *  A cancel is a choice, not an error, and must not surface as one. */
export function isCancellation(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

type RegisterOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: { type: "public-key"; id: string }[];
  timeout?: number;
};

/** Run the enrolment ceremony and return what the server needs to verify it. */
export async function createCredential(opts: RegisterOptions) {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBuf(opts.challenge),
      rp: opts.rp,
      user: {
        // The handle is opaque and server-generated: the spec forbids putting
        // anything personally identifying in here, and a username qualifies.
        id: new TextEncoder().encode(opts.user.id),
        name: opts.user.name,
        displayName: opts.user.displayName,
      },
      pubKeyCredParams: opts.pubKeyCredParams,
      authenticatorSelection: opts.authenticatorSelection,
      excludeCredentials: (opts.excludeCredentials ?? []).map((c) => ({
        type: c.type, id: b64urlToBuf(c.id),
      })),
      timeout: opts.timeout,
      attestation: "none",
    },
  }) as PublicKeyCredential | null;

  if (!credential) throw new Error("No credential was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    credential_id: bufToB64url(credential.rawId),
    client_data_json: bufToB64url(response.clientDataJSON),
    attestation_object: bufToB64url(response.attestationObject),
  };
}

type LoginOptions = {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
};

/**
 * Run the sign-in ceremony.
 *
 * `allowCredentials` is deliberately omitted, which is what makes this
 * usernameless: the authenticator offers whatever it holds for this domain and
 * the user picks in the OS dialog, exactly like a saved password. Sending a
 * list would require knowing who is signing in before they have.
 */
export async function getAssertion(opts: LoginOptions) {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBuf(opts.challenge),
      rpId: opts.rpId,
      timeout: opts.timeout,
      userVerification: opts.userVerification ?? "preferred",
    },
  }) as PublicKeyCredential | null;

  if (!credential) throw new Error("No passkey was selected.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    credential_id: bufToB64url(credential.rawId),
    client_data_json: bufToB64url(response.clientDataJSON),
    authenticator_data: bufToB64url(response.authenticatorData),
    signature: bufToB64url(response.signature),
  };
}

// ── the account this device signs in as ──────────────────────────────────
//
// Remembering the last account to sign in with a passkey is what turns the
// login page into "Continue as ana" instead of a form. It is a convenience
// hint only — the server still requires a valid signature — so it lives in
// localStorage and a wrong or stale value costs nothing but a wasted button.

const PRIMARY_KEY = "mb_passkey_primary";

export function primaryAccount(): string | null {
  try {
    return localStorage.getItem(PRIMARY_KEY);
  } catch {
    return null;                       // private mode, storage disabled
  }
}

export function setPrimaryAccount(username: string): void {
  try {
    localStorage.setItem(PRIMARY_KEY, username);
  } catch { /* a lost hint is not worth surfacing */ }
}

export function clearPrimaryAccount(): void {
  try {
    localStorage.removeItem(PRIMARY_KEY);
  } catch { /* noop */ }
}
