"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { api, token } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { access_token } = await api.login(username, password);
      token.set(access_token);
      router.replace("/");
    } catch (err: any) {
      setError(err?.detail || "Invalid credentials.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="text-amber font-bold tracking-[0.22em] text-2xl mb-1">MOTHERBOARD</div>
      <div className="label-xs mb-8">Secure terminal access</div>

      <form onSubmit={onSubmit} className="panel-2 w-[380px] max-w-full p-6 flex flex-col gap-3 shadow-panel">
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
        {error && <div className="text-red text-xs mt-1">{error}</div>}
        <button disabled={busy} className="btn-primary mt-3 disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="text-[10px] text-mut text-center mt-3 uppercase tracking-wider">
          Educational research — not investment advice
        </div>
      </form>
    </div>
  );
}
