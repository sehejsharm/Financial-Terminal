"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Shell } from "@/components/Shell";
import { Pager, SortableTh, TableToolbar, useTableControls } from "@/components/tableControls";
import { api, type AdminUser, type AuditEvent, type VcReport } from "@/lib/api";

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [vcReports, setVcReports] = useState<VcReport[] | null>(null);
  const [tab, setTab] = useState<"users" | "audit" | "vc">("users");
  const auditCtl = useTableControls(audit ?? [], 50);
  const [forbidden, setForbidden] = useState(false);

  // New-user form
  const [u, setU] = useState("");
  const [pw, setPw] = useState("");
  const [role, setRole] = useState<"user" | "master_admin">("user");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  function refresh() {
    api.adminUsers().then(setUsers).catch((e) => { if (e?.status === 403) setForbidden(true); else setUsers([]); });
    api.adminAudit(100).then(setAudit).catch(() => setAudit([]));
    api.vcReports().then(setVcReports).catch(() => setVcReports([]));
  }
  useEffect(refresh, []);

  async function createUser() {
    if (!u.trim() || !pw.trim()) { setMsg({ text: "Username and password required.", ok: false }); return; }
    try {
      const r = await api.adminCreateUser(u.trim(), pw, role);
      setMsg({ text: r.message || "User created.", ok: true });
      setU(""); setPw(""); refresh();
    } catch (e: any) {
      setMsg({ text: e?.detail || "Create failed.", ok: false });
    }
  }

  async function deactivate(username: string) {
    if (!confirm(`Deactivate ${username}?`)) return;
    try { await api.adminDeactivateUser(username); refresh(); } catch { /* noop */ }
  }

  if (forbidden) {
    return (
      <Shell>
        <div className="panel-2 p-4 text-red text-sm">This area is restricted to the Master Admin.</div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="heading mb-3">ADMIN</h1>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setTab("users")} className={`btn ${tab === "users" ? "btn-primary" : "btn-ghost"}`}>Users</button>
        <button onClick={() => setTab("audit")} className={`btn ${tab === "audit" ? "btn-primary" : "btn-ghost"}`}>Audit log</button>
        <button onClick={() => setTab("vc")} className={`btn ${tab === "vc" ? "btn-primary" : "btn-ghost"}`}>
          VC reports{vcReports && vcReports.length > 0 ? ` (${vcReports.length})` : ""}
        </button>
      </div>

      {tab === "vc" && (
        <>
          <div className="text-mut text-xs mb-3">
            Value-chain relationships users flagged as wrong (AI-generated maps).
            Review and, where confirmed, pin a corrected map from the terminal.
          </div>
          {(!vcReports || vcReports.length === 0) && (
            <div className="panel-2 p-4 text-mut text-sm">No reports. Nothing flagged yet.</div>
          )}
          {vcReports && vcReports.length > 0 && (
            <div className="panel overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line">
                    <th className="text-left px-3 py-2 font-medium">When</th>
                    <th className="text-left px-3 py-2 font-medium">By</th>
                    <th className="text-left px-3 py-2 font-medium">Map</th>
                    <th className="text-left px-3 py-2 font-medium">Node</th>
                    <th className="text-left px-3 py-2 font-medium">Role</th>
                    <th className="text-left px-3 py-2 font-medium">Category</th>
                    <th className="text-left px-3 py-2 font-medium">Reason</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {vcReports.map((r, i) => (
                    <tr key={i} className="border-b border-line/60 hover:bg-panel">
                      <td className="px-3 py-2 text-mut whitespace-nowrap">{r.ts?.slice(0, 16).replace("T", " ")}</td>
                      <td className="px-3 py-2">{r.user ?? "—"}</td>
                      <td className="px-3 py-2 text-amber">{r.ticker}</td>
                      <td className="px-3 py-2">{r.node_name}</td>
                      <td className="px-3 py-2 uppercase text-mut">{r.role}</td>
                      <td className="px-3 py-2">
                        {/* Records predating categories read as 'unspecified'. */}
                        <span className={r.category && r.category !== "unspecified" ? "text-amber" : "text-mut"}>
                          {(r.category ?? "unspecified").replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-mut">{r.reason || "—"}</td>
                      <td className="px-3 py-2">
                        <button className="btn-ghost text-[11px]"
                          onClick={async () => {
                            const pctRaw = window.prompt(`Corrected exposure %% for ${r.node_name} (blank = keep)`, "");
                            const note = window.prompt("Corrected description (blank = keep)", "") || "";
                            const pct = pctRaw ? parseFloat(pctRaw) : null;
                            try {
                              await api.vcOverride(r.ticker, { role: r.role, node_name: r.node_name,
                                revenue_pct: pct != null && !Number.isNaN(pct) ? pct : null, note, locked: true });
                              alert("Correction published — the edge is now verified + locked (AI regenerations cannot overwrite it).");
                            } catch { alert("Failed to publish correction."); }
                          }}>
                          Fix &amp; publish
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "users" && (
        <>
          <div className="panel-2 p-4 mb-5">
            <div className="heading mb-3">Create user</div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_180px_auto] gap-2">
              <input value={u} onChange={(e) => setU(e.target.value)} placeholder="Username" className="input-bare" />
              <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="Password" className="input-bare" />
              <select value={role} onChange={(e) => setRole(e.target.value as any)} className="input-bare cursor-pointer">
                <option value="user">user</option>
                <option value="master_admin">master_admin</option>
              </select>
              <button onClick={createUser} className="btn-primary">Create</button>
            </div>
            {msg && <div className={`text-xs mt-2 ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</div>}
          </div>

          <div className="heading mb-2">Users</div>
          {users === null && <div className="text-mut text-xs">Loading…</div>}
          {users && users.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No users.</div>}
          {users && users.length > 0 && (
            <div className="panel overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line">
                    <th className="text-left px-3 py-2 font-medium">Username</th>
                    <th className="text-left px-3 py-2 font-medium">Role</th>
                    <th className="text-left px-3 py-2 font-medium">Active</th>
                    <th className="text-left px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((usr) => (
                    <tr key={usr.username} className="border-b border-line/60 hover:bg-panel">
                      <td className="px-3 py-2 text-txt">{usr.username}</td>
                      <td className="px-3 py-2 text-amber">{usr.role}</td>
                      <td className="px-3 py-2">{usr.active === false ? "—" : "✓"}</td>
                      <td className="px-3 py-2 text-mut">{usr.created_at ? usr.created_at.slice(0, 10) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {usr.role !== "master_admin" && usr.active !== false && (
                          <button onClick={() => deactivate(usr.username)} className="text-mut hover:text-red" title="Deactivate">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "audit" && (
        <>
          {audit === null && <div className="text-mut text-xs">Loading audit log…</div>}
          {audit && audit.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No events.</div>}
          {audit && audit.length > 0 && (
            <>
              <TableToolbar ctl={auditCtl} placeholder="Filter by user / path / status…" />
              <div className="panel overflow-auto max-h-[70vh]">
                <table className="w-full text-[11px]">
                  <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
                    <tr className="border-b border-line">
                      <SortableTh label="Timestamp" k="ts" ctl={auditCtl} />
                      <SortableTh label="User" k="user" ctl={auditCtl} />
                      <SortableTh label="Method" k="method" ctl={auditCtl} />
                      <SortableTh label="Path" k="path" ctl={auditCtl} />
                      <SortableTh label="Status" k="status" ctl={auditCtl} align="right" />
                      <SortableTh label="ms" k="latency_ms" ctl={auditCtl} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {auditCtl.pageRows.map((e, i) => (
                      <tr key={i} className="border-b border-line/40">
                        <td className="px-3 py-1.5 num text-mut whitespace-nowrap">{e.ts.replace("T", " ").slice(0, 19)}</td>
                        <td className="px-3 py-1.5">{e.user ?? "—"}</td>
                        <td className="px-3 py-1.5 text-amber">{e.method}</td>
                        <td className="px-3 py-1.5 truncate max-w-[280px]">{e.path}</td>
                        <td className={`px-3 py-1.5 num text-right ${e.status >= 400 ? "text-red" : "text-green"}`}>{e.status}</td>
                        <td className="px-3 py-1.5 num text-right">{e.latency_ms}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager ctl={auditCtl} />
            </>
          )}
        </>
      )}
    </Shell>
  );
}
