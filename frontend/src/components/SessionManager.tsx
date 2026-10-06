"use client";

/** Where this account is signed in, and how to end any of it.
 *
 *  The server side of this shipped with the session rework; this is the part
 *  that makes it usable. The point is that someone can recognise a device they
 *  do NOT recognise and do something about it immediately, without emailing
 *  support — which is why each row shows a last-used time and an IP, and why
 *  "sign out everywhere" is one click rather than a sequence.
 */

import { useCallback, useEffect, useState } from "react";
import { LogOut, Monitor } from "lucide-react";

import { api, endSession, type SessionRecord } from "@/lib/api";
import { describeDevice, relativeTime } from "@/lib/planDisplay";

export function SessionManager() {
  const [rows, setRows] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.sessions()
      .then((r) => setRows(r.sessions))
      .catch(() => setError("Could not load your sessions. Retry in a moment."));
  }, []);

  useEffect(load, [load]);

  async function revoke(id: string) {
    setBusy(id); setError(null);
    try {
      await api.revokeSession(id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== id));
    } catch {
      setError("Could not end that session. Retry in a moment.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    setBusy("all"); setError(null);
    try {
      await api.logoutEverywhere();
      // This ends THIS session too, so there is nothing to stay on screen
      // for. A full reload lands on /login via the auth gate.
      await endSession();
      window.location.href = "/login";
    } catch {
      setError("Could not sign out everywhere. Retry in a moment.");
      setBusy(null);
    }
  }

  if (error && !rows) return <div className="text-red text-xs">{error}</div>;
  if (!rows) return <div className="text-xs text-mut">Loading your sessions…</div>;

  return (
    <div className="panel-2 p-4 flex flex-col gap-3">
      <div className="text-sm font-semibold">Where you are signed in</div>
      <div className="flex flex-col divide-y divide-line2">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center gap-3 py-2">
            <Monitor size={14} className="text-mut shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-xs truncate">
                {describeDevice(s.user_agent)}
                {s.current && (
                  <span className="text-amber ml-2 text-[10px] uppercase tracking-wider">
                    this device
                  </span>
                )}
              </div>
              <div className="text-[10px] text-mut">
                {relativeTime(s.last_used)}{s.ip ? ` · ${s.ip}` : ""}
              </div>
            </div>
            {!s.current && (
              <button
                type="button"
                onClick={() => revoke(s.id)}
                disabled={busy === s.id}
                className="btn-ghost !py-1 !px-2 text-[10px] disabled:opacity-60"
                aria-label={`Sign out ${describeDevice(s.user_agent)}`}
              >
                {busy === s.id ? "Ending…" : "Sign out"}
              </button>
            )}
          </div>
        ))}
      </div>

      {error && <div className="text-red text-xs">{error}</div>}

      <button
        type="button"
        onClick={revokeAll}
        disabled={busy !== null}
        className="btn-ghost !py-1 text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-60"
      >
        <LogOut size={11} aria-hidden />
        {busy === "all" ? "Signing out everywhere…" : "Sign out everywhere"}
      </button>
      <div className="text-[10px] text-mut leading-relaxed">
        Signing out everywhere ends every session including this one. Use it if
        you think someone else has your password — then change it.
      </div>
    </div>
  );
}
