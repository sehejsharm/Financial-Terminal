"use client";

import Link from "next/link";
import { useState } from "react";

import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";

const PRESETS = ["PEG Screen", "Hidden Gems", "Growth"];

export default function ScreenersPage() {
  const [active, setActive] = useState(PRESETS[0]);
  const [rows, setRows] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setRows(null);
    try {
      const data = await api.preset(active);
      setRows(data);
    } catch (e: any) {
      setErr(e?.detail || "Screen failed.");
    } finally {
      setBusy(false);
    }
  }

  const cols = rows && rows.length
    ? Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
    : [];

  return (
    <Shell>
      <h1 className="heading mb-3">SCREENERS</h1>

      <div className="flex flex-wrap gap-2 mb-4">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setActive(p)}
            className={`btn ${active === p ? "btn-primary" : "btn-ghost"}`}
          >
            {p}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={run} disabled={busy} className="btn-primary">
          {busy ? "Scanning…" : "Run screen"}
        </button>
      </div>

      {err && <div className="text-red text-sm mb-3">{err}</div>}

      {rows && rows.length === 0 && (
        <div className="panel-2 p-4 text-mut">No matches.</div>
      )}

      {rows && rows.length > 0 && (
        <div className="panel overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                {cols.map((c) => (
                  <th key={c} className="text-left px-3 py-2 font-medium">{c}</th>
                ))}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60 hover:bg-panel">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 num">
                      {r[c] === null || r[c] === undefined ? "—" : String(r[c])}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <Link
                      href={`/terminal?t=${encodeURIComponent((r.ticker || "").endsWith(".NS") ? r.ticker : r.ticker + ".NS")}`}
                      className="text-amber hover:underline"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
