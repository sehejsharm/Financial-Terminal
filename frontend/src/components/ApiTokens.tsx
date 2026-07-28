"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Trash2 } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { ScrollX } from "@/components/ScrollX";
import { api, type ApiTokenInfo } from "@/lib/api";

/**
 * DAPI — personal API tokens for the spreadsheet bridge.
 *
 * The UI's job here is mostly to be honest about a long-lived credential:
 * show the plaintext exactly once, say plainly what the token can and cannot
 * do, and make revocation a single obvious click with last-used dates so a
 * stale token is visibly safe to delete.
 */
export function ApiTokens({ apiBase }: { apiBase: string }) {
  const [rows, setRows] = useState<ApiTokenInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ token: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await api.listApiTokens()); setErr(null); }
    catch (e: any) { setErr(e?.detail || "Could not load API tokens."); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await api.createApiToken(label.trim());
      setFresh({ token: r.token, label: r.label });
      setLabel(""); setCopied(false);
      await load();
    } catch (e: any) {
      setErr(e?.detail || "Could not create a token.");
    } finally { setBusy(false); }
  }

  async function revoke(t: ApiTokenInfo) {
    if (!confirm(
      `Revoke "${t.label || t.prefix}"?\n\nAnything using it — a spreadsheet, a `
      + `script — stops working immediately. This cannot be undone.`)) return;
    try { await api.revokeApiToken(t.id); await load(); }
    catch (e: any) { setErr(e?.detail || "Could not revoke that token."); }
  }

  const example = fresh?.token
    ? `${apiBase}/api/v1/data/bdp?tickers=RELIANCE.NS,TCS.NS&fields=name,price,pe_ratio&token=${fresh.token}`
    : `${apiBase}/api/v1/data/bdp?tickers=RELIANCE.NS,TCS.NS&fields=name,price,pe_ratio&token=YOUR_TOKEN`;

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={14} className="text-amber" />
        <h2 className="heading">DAPI — DATA API TOKENS</h2>
      </div>
      <div className="text-xs text-mut mb-3">
        Pull live data straight into Excel or Google Sheets. A browser session
        expires in minutes, which is no use to a sheet that refreshes on its own,
        so these tokens are long-lived — and deliberately limited because of it.
      </div>

      {err && <div className="mb-3"><PanelError error={err} retry={load} /></div>}

      <div className="panel-2 p-3 mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="label-xs">Label (what will use it)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)}
                 maxLength={60} placeholder="Portfolio sheet"
                 onKeyDown={(e) => { if (e.key === "Enter") create(); }}
                 className="input-bare !py-1 text-xs" />
        </label>
        <button onClick={create} disabled={busy} className="btn-primary text-xs disabled:opacity-50">
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>

      {fresh && (
        <div className="panel-2 p-3 mb-3 border border-amber/50">
          <div className="text-xs text-amber mb-1.5">
            Copy this now — it is stored hashed and cannot be shown again.
          </div>
          <div className="flex items-center gap-2 mb-2">
            <code className="flex-1 text-[11px] break-all bg-bg2 px-2 py-1.5 rounded num">
              {fresh.token}
            </code>
            <button onClick={() => {
                      navigator.clipboard?.writeText(fresh.token);
                      setCopied(true);
                    }}
                    className="btn-ghost text-xs flex items-center gap-1 shrink-0">
              <Copy size={11} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setFresh(null)} className="text-mut hover:text-txt text-[11px]">
            I&apos;ve saved it — hide
          </button>
        </div>
      )}

      <div className="panel mb-3">
        <ScrollX>
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                <th className="text-left px-3 py-2 font-medium">Label</th>
                <th className="text-left px-3 py-2 font-medium">Token</th>
                <th className="text-left px-3 py-2 font-medium">Created</th>
                <th className="text-left px-3 py-2 font-medium">Last used</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((t) => (
                <tr key={t.id} className="border-b border-line/60 hover:bg-panel">
                  <td className="px-3 py-1.5">{t.label || <span className="text-mut">—</span>}</td>
                  <td className="px-3 py-1.5 num text-mut">{t.prefix}…</td>
                  <td className="px-3 py-1.5 text-mut">{(t.created_at || "").slice(0, 10)}</td>
                  <td className="px-3 py-1.5 text-mut">
                    {t.last_used_at
                      ? t.last_used_at.slice(0, 10)
                      : <span title="Never used — safe to revoke">never</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button onClick={() => revoke(t)} className="text-mut hover:text-red" title="Revoke">
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-mut">
                  No tokens yet.
                </td></tr>
              )}
              {!rows && !err && (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-mut animate-pulse">
                  Loading…
                </td></tr>
              )}
            </tbody>
          </table>
        </ScrollX>
      </div>

      <div className="panel-2 p-3 mb-3">
        <div className="label-xs mb-2">How to use it</div>
        <div className="text-xs text-mut mb-1.5">
          Google Sheets — paste into a cell:
        </div>
        <code className="block text-[10.5px] break-all bg-bg2 px-2 py-1.5 rounded mb-3">
          =IMPORTDATA(&quot;{example}&quot;)
        </code>
        <div className="text-xs text-mut mb-1.5">
          History (BDH), one row per bar:
        </div>
        <code className="block text-[10.5px] break-all bg-bg2 px-2 py-1.5 rounded mb-3">
          {apiBase}/api/v1/data/bdh?ticker=RELIANCE.NS&amp;period=5Y&amp;token=YOUR_TOKEN
        </code>
        <div className="text-[10.5px] text-mut">
          Add <code>&amp;format=json</code> for code instead of CSV. The full field
          list is at <code>/api/v1/data/fields</code>. Note that 3Y/5Y/10Y windows
          are served as <span className="text-txt">weekly</span> bars, not daily.
        </div>
      </div>

      <div className="text-[10.5px] text-mut leading-relaxed">
        <span className="text-txt">What a token can do:</span> read market data
        through <code>/api/v1/data/*</code> — and nothing else. It cannot read your
        portfolio, your watchlists or your alerts, cannot place or change anything,
        cannot reach the admin surface, and cannot mint further tokens. That
        restriction is what makes a long-lived credential defensible.
        {" "}<span className="text-txt">What it can&apos;t protect you from:</span> anyone
        holding the string can pull market data as you until you revoke it. Passing
        it in a URL — which spreadsheet tools require, since they can&apos;t set
        headers — means it lands in server logs and browser history, so treat a
        shared sheet as a shared token and revoke on any doubt. Tokens are stored
        as SHA-256 hashes, so a leak of the database does not leak the tokens
        themselves.
      </div>
    </div>
  );
}
