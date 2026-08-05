"use client";

/**
 * Sign in with a passkey, or with a password.
 *
 * The passkey is the fast path and the password is the floor. Every way the
 * fast path can fail — no platform authenticator, an unsupported browser, a
 * cancelled prompt, a credential minted for a domain the app has since moved
 * off — lands on the password form, because a passkey that stops working must
 * never be a locked door.
 *
 * The "continue as X" treatment mirrors what a browser password manager does:
 * once someone has signed in here with a biometric, that account becomes the
 * one this device offers by default, and switching to another is a deliberate
 * click rather than the default state.
 */

import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Fingerprint, KeyRound } from "lucide-react";

import { api, token } from "@/lib/api";
import {
  available, clearPrimaryAccount, getAssertion, isCancellation,
  primaryAccount, setPrimaryAccount,
} from "@/lib/passkey";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // null while the capability probe is still running, so the button does not
  // flash in and then out on a device that cannot do this.
  const [canUsePasskey, setCanUsePasskey] = useState<boolean | null>(null);
  const [primary, setPrimary] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let alive = true;
    setPrimary(primaryAccount());
    available().then((ok) => { if (alive) setCanUsePasskey(ok); });
    return () => { alive = false; };
  }, []);

  const signInWithPasskey = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const opts = await api.passkeyLoginBegin();
      const assertion = await getAssertion({
        challenge: opts.challenge, rpId: opts.rpId, timeout: opts.timeout,
      });
      const res = await api.passkeyLoginFinish({
        handle: opts.handle, ...assertion,
      });
      token.set(res.access_token);
      setPrimaryAccount(res.username);
      router.replace("/");
    } catch (err: unknown) {
      // Dismissing the OS prompt is a choice, not a failure, and showing red
      // text for it trains people to distrust the screen.
      if (isCancellation(err)) {
        setBusy(false);
        return;
      }
      setShowPassword(true);
      setError(
        (err as { detail?: string } | null)?.detail
        ?? "That passkey did not work on this device. Sign in with your "
           + "password — you can set up a new passkey afterwards.",
      );
    } finally {
      setBusy(false);
    }
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { access_token } = await api.login(username, password);
      token.set(access_token);
      router.replace("/");
    } catch (err: unknown) {
      setError((err as { detail?: string } | null)?.detail
               ?? "Invalid credentials.");
    } finally {
      setBusy(false);
    }
  }

  const passwordFormVisible = showPassword || canUsePasskey === false;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="text-amber font-bold tracking-[0.22em] text-2xl mb-1">MOTHERBOARD</div>
      <div className="label-xs mb-8">Secure terminal access</div>

      <div className="panel-2 w-[380px] max-w-full p-6 flex flex-col gap-3 shadow-panel">
        {canUsePasskey && (
          <>
            <button
              type="button"
              onClick={signInWithPasskey}
              disabled={busy}
              data-testid="passkey-signin"
              className="btn-primary flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <Fingerprint size={15} />
              {busy ? "Waiting for your device…"
                : primary ? `Continue as ${primary}` : "Sign in with a passkey"}
            </button>
            <div className="text-[10px] text-mut text-center leading-relaxed">
              Your fingerprint or face is checked by this device and never
              leaves it.
            </div>

            {!passwordFormVisible && (
              <button
                type="button"
                onClick={() => { setShowPassword(true); setError(null); }}
                className="btn-ghost !py-1 text-[11px] flex items-center justify-center gap-1.5 mt-1"
              >
                <KeyRound size={11} />
                {primary ? "Use a different account" : "Use a password instead"}
              </button>
            )}
          </>
        )}

        {passwordFormVisible && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            {canUsePasskey && (
              <div className="border-t border-line2 pt-3 label-xs">
                Sign in with a password
              </div>
            )}
            <label className="label-xs">Username</label>
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input-bare"
            />
            <label className="label-xs mt-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-bare"
            />
            <button disabled={busy} className="btn-primary mt-3 disabled:opacity-60">
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {primary && (
              <button
                type="button"
                onClick={() => { clearPrimaryAccount(); setPrimary(null); }}
                className="text-[10px] text-mut hover:text-txt underline text-center"
              >
                Stop offering {primary} on this device
              </button>
            )}
          </form>
        )}

        {error && <div className="text-red text-xs mt-1">{error}</div>}

        <div className="text-[10px] text-mut text-center mt-3 uppercase tracking-wider">
          Educational research — not investment advice
        </div>
      </div>
    </div>
  );
}
