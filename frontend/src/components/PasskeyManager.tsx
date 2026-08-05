"use client";

/**
 * Enrol and remove passkeys for the signed-in account.
 *
 * Enrolment can only happen here, inside a session, because the session is
 * what answers "is this really you" before a key is bound to the account —
 * the verification code relies on that and deliberately does not check
 * attestation.
 *
 * Nothing in this panel is required. A user who never opens it keeps signing
 * in with a password forever, which is the whole point of adding passkeys as
 * a supplement rather than a replacement.
 */

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, Trash2 } from "lucide-react";

import { Note } from "@/components/ui";
import { api, type PasskeyRecord } from "@/lib/api";
import { available, createCredential, isCancellation } from "@/lib/passkey";

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone or iPad";
  if (/Android/.test(ua)) return "Android device";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

export function PasskeyManager() {
  const [creds, setCreds] = useState<PasskeyRecord[] | null>(null);
  const [canEnrol, setCanEnrol] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCreds((await api.passkeyList()).credentials);
    } catch {
      setCreds([]);
    }
  }, []);

  useEffect(() => {
    available().then(setCanEnrol);
    refresh();
  }, [refresh]);

  async function enrol() {
    setBusy(true); setError(null); setOk(null);
    try {
      const opts = await api.passkeyRegisterBegin();
      const created = await createCredential(opts as never);
      const res = await api.passkeyRegisterFinish({
        handle: opts.handle, label: deviceLabel(), ...created,
      });
      setCreds(res.credentials);
      setOk("Passkey added. Next time, sign in straight from the login screen.");
    } catch (err: unknown) {
      if (isCancellation(err)) { setBusy(false); return; }
      setError((err as { detail?: string } | null)?.detail
               ?? "Could not add a passkey on this device.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true); setError(null); setOk(null);
    try {
      await api.passkeyDelete(id);
      await refresh();
    } catch {
      setError("Could not remove that passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-4">
      <div className="heading mb-1 flex items-center gap-2">
        <Fingerprint size={13} /> Passkeys
      </div>
      <div className="text-[11.5px] text-mut mb-3 leading-relaxed">
        Sign in with the fingerprint, face or PIN this device already uses.
        Your biometric is matched by the device and never reaches this server —
        only a signature does. Your password keeps working either way.
      </div>

      {canEnrol === false && (
        <Note>
          This device has no built-in authenticator available to the browser,
          so a passkey cannot be added here. Signing in with your password is
          unaffected.
        </Note>
      )}

      {canEnrol && (
        <button onClick={enrol} disabled={busy}
                data-testid="passkey-enrol"
                className="btn-primary !py-1.5 text-[11.5px] flex items-center gap-2 disabled:opacity-60">
          <Fingerprint size={12} />
          {busy ? "Waiting for your device…" : "Add a passkey for this device"}
        </button>
      )}

      {ok && <div className="text-green text-[11.5px] mt-2">{ok}</div>}
      {error && <div className="text-red text-[11.5px] mt-2">{error}</div>}

      {creds && creds.length > 0 && (
        <table className="w-full text-[11.5px] mt-3">
          <thead className="text-mut uppercase tracking-wider">
            <tr className="border-b border-line2">
              <th className="text-left py-1.5 font-medium">Device</th>
              <th className="text-left py-1.5 font-medium">Added</th>
              <th className="text-left py-1.5 font-medium">Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {creds.map((c) => (
              <tr key={c.id} className="border-b border-line/60">
                <td className="py-1.5 text-txt">{c.label}</td>
                <td className="py-1.5 text-mut">{(c.created ?? "—").slice(0, 10)}</td>
                <td className="py-1.5 text-mut">
                  {c.last_used ? c.last_used.slice(0, 10) : "never"}
                </td>
                <td className="py-1.5 text-right">
                  <button onClick={() => remove(c.id)} disabled={busy}
                          title="Remove this passkey"
                          className="text-mut hover:text-red disabled:opacity-50">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creds && creds.length === 0 && canEnrol && (
        <div className="text-[11.5px] text-mut mt-3">
          No passkeys yet on this account.
        </div>
      )}
    </div>
  );
}
