"use client";

/**
 * Where an invite or a reset link lands.
 *
 * One page for both because they are the same action — "choose a password for
 * this account" — and the only difference is the sentence explaining why you
 * are here. Two near-identical pages would drift.
 *
 * The token is validated on load so an expired or spent link says so
 * immediately, rather than after someone has typed a password twice. That
 * check is deliberately read-only on the server; it must not spend the one use
 * the submit needs.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

import { ApiError, api, csrf, token as accessToken } from "@/lib/api";

// Matches the server's floor (lib/auth.reset_password). Checked here too so
// the answer is instant rather than a round trip, but the server is the one
// that decides.
const MIN_LENGTH = 6;

function SetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const linkToken = params.get("token") || "";
  // Invite and reset links are the same shape; the purpose rides in the URL
  // and the server checks it, so an invite token cannot be redeemed as a reset.
  const purpose = params.get("purpose") === "reset" ? "reset" : "invite";

  const [account, setAccount] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!linkToken) {
      setChecking(false);
      setLinkError("This link is missing its token. Open the link from your "
                   + "email directly rather than copying part of it.");
      return;
    }
    let alive = true;
    api.inspectInvite(linkToken, purpose)
      .then((r) => { if (alive) { setAccount(r.username); setChecking(false); } })
      .catch((e: unknown) => {
        if (!alive) return;
        setChecking(false);
        setLinkError(e instanceof ApiError
          ? e.detail
          : "Could not check this link. Retry in a moment.");
      });
    return () => { alive = false; };
  }, [linkToken, purpose]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Checked before sending: the token is spent by the submit, so a
    // mismatched confirmation that reached the server would cost the user
    // their link and force them to ask for another.
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.acceptInvite(linkToken, password, purpose);
      // Signed in already — asking someone to log in immediately after
      // setting a password makes them think it did not work.
      accessToken.set(res.access_token, res.expires_at);
      csrf.set(res.csrf_token);
      router.replace("/");
    } catch (err: unknown) {
      setError(err instanceof ApiError
        ? err.detail
        : "Could not set your password. Retry in a moment.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center p-6">
      <div className="text-amber font-bold tracking-[0.22em] text-2xl mb-1">MOTHERBOARD</div>
      <div className="label-xs mb-8">
        {purpose === "reset" ? "Reset your password" : "Finish setting up your account"}
      </div>

      <div className="panel-2 w-[380px] max-w-full p-6 flex flex-col gap-3 shadow-panel">
        {checking && <div className="text-xs text-mut">Checking your link…</div>}

        {!checking && linkError && (
          <>
            <div className="text-red text-xs leading-relaxed">{linkError}</div>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="btn-ghost !py-1 text-[11px] mt-2"
            >
              Back to sign in
            </button>
          </>
        )}

        {!checking && !linkError && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="label-xs">
              Choose a password for <span className="text-txt">{account}</span>
            </div>
            <label className="label-xs mt-1" htmlFor="sp-password">New password</label>
            <input
              id="sp-password"
              autoFocus
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-bare"
            />
            <label className="label-xs mt-2" htmlFor="sp-confirm">Confirm password</label>
            <input
              id="sp-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="input-bare"
            />
            <button
              disabled={busy}
              data-testid="set-password-submit"
              className="btn-primary mt-3 flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <KeyRound size={13} />
              {busy ? "Setting your password…" : "Set password and sign in"}
            </button>
            {error && <div className="text-red text-xs mt-1">{error}</div>}
            <div className="text-[10px] text-mut leading-relaxed mt-1">
              This link works once. Nobody else, including whoever created the
              account, can see the password you choose.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  // useSearchParams needs a Suspense boundary to keep this route static —
  // without it the whole page opts into dynamic rendering.
  return (
    <Suspense fallback={null}>
      <SetPasswordForm />
    </Suspense>
  );
}
