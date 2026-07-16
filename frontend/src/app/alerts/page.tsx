"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { Shell } from "@/components/Shell";
import { api, type Alert, type AlertEvent } from "@/lib/api";
import { useLive } from "@/lib/useLive";
import { fmtNum } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = {
  price: "Price",
  pe: "Trailing P/E",
  spread_10y2y: "US 10Y–2Y spread",
};

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Delivery channels: email (server-side SMTP) + web push (per-device). */
function DeliveryPanel() {
  const [cfg, setCfg] = useState<{ email: boolean; push: boolean; vapid_public_key: string | null } | null>(null);
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled" | "denied" | "error">("idle");
  const [testMsg, setTestMsg] = useState<string | null>(null);

  useEffect(() => {
    api.pushConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  async function enablePush() {
    if (!cfg?.vapid_public_key) return;
    setPushState("enabling");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPushState("denied"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.vapid_public_key) as BufferSource,
      });
      await api.pushSubscribe(sub.toJSON());
      setPushState("enabled");
    } catch {
      setPushState("error");
    }
  }

  async function test() {
    setTestMsg("Sending…");
    try {
      const r = await api.alertTest();
      const parts = [];
      if (r.results.email !== null) parts.push(`email ${r.results.email ? "sent ✓" : "failed"}`);
      if (r.results.push !== null) parts.push(`push ${r.results.push ? "sent ✓" : "failed"} (${r.devices} device${r.devices === 1 ? "" : "s"})`);
      setTestMsg(parts.length ? parts.join(" · ") : "No delivery channels configured yet.");
    } catch { setTestMsg("Test failed."); }
  }

  return (
    <div className="panel-2 p-3 mb-6">
      <div className="label-xs mb-2">Delivery channels</div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className={`chip ${cfg?.email ? "!text-green !border-green/50" : ""}`}>
          Email {cfg === null ? "…" : cfg.email ? "configured" : "off"}
        </span>
        <span className={`chip ${cfg?.push ? "!text-green !border-green/50" : ""}`}>
          Push {cfg === null ? "…" : cfg.push ? "available" : "off"}
        </span>
        {cfg?.push && pushState !== "enabled" && (
          <button onClick={enablePush} disabled={pushState === "enabling"} className="btn-ghost text-xs">
            {pushState === "enabling" ? "Enabling…" : "Enable push on this device"}
          </button>
        )}
        {pushState === "enabled" && <span className="text-green">This device will receive push alerts ✓</span>}
        {pushState === "denied" && <span className="text-red">Notifications blocked in browser settings.</span>}
        {pushState === "error" && <span className="text-red">Could not subscribe — try again.</span>}
        <button onClick={test} className="btn-ghost text-xs">Send test alert</button>
        {testMsg && <span className="text-mut">{testMsg}</span>}
      </div>
      {cfg !== null && !cfg.email && !cfg.push && (
        <div className="text-[10.5px] text-mut mt-2">
          To activate: set SMTP_* (email) and/or VAPID_* (push) in the server&apos;s
          deploy/.env — see .env.example for the exact variables — then restart.
          Alerts always appear in-app regardless.
        </div>
      )}
    </div>
  );
}

/** Alert center: create/delete conditions + triggered-event feed.
 *  Conditions are evaluated server-side every ~60s; triggered alerts
 *  deactivate and land in the feed (and the header bell). */
export default function AlertsPage() {
  const [kind, setKind] = useState<"price" | "pe" | "spread_10y2y">("price");
  const [ticker, setTicker] = useState("");
  const [op, setOp] = useState<">" | "<">("<");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data, busy, updatedAt, refresh } = useLive<{ alerts: Alert[]; events: AlertEvent[] }>(
    () => api.alerts(), 30_000,
  );

  async function create() {
    setErr(null);
    const v = parseFloat(value);
    if (Number.isNaN(v)) { setErr("Threshold value required."); return; }
    if (kind !== "spread_10y2y" && !ticker.trim()) { setErr("Ticker required for this alert kind."); return; }
    try {
      await api.createAlert({ kind, ticker: kind === "spread_10y2y" ? null : ticker.trim().toUpperCase(), op, value: v });
      setValue(""); refresh();
      // Mark bell as seen up to now (new events after this will badge).
    } catch (e: any) { setErr(e?.detail || "Could not create alert."); }
  }

  async function del(id: string) {
    try { await api.deleteAlert(id); refresh(); } catch { /* noop */ }
  }

  const alerts = data?.alerts ?? [];
  const events = [...(data?.events ?? [])].reverse();

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-3">
        <h1 className="heading">ALERTS</h1>
        <div className="flex-1" />
        <DataAge at={updatedAt} onRefresh={refresh} busy={busy} />
      </div>
      <div className="text-mut text-xs mb-4">
        Evaluated server-side every ~60s against live provider data. Triggered
        alerts deactivate and appear in the feed + header bell.
      </div>

      <DeliveryPanel />

      <div className="panel-2 p-3 mb-6 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 w-44">
          <span className="label-xs">Condition</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as any)} className="input-bare cursor-pointer">
            <option value="price">Price</option>
            <option value="pe">Trailing P/E</option>
            <option value="spread_10y2y">US 10Y–2Y spread</option>
          </select>
        </label>
        {kind !== "spread_10y2y" && (
          <label className="flex flex-col gap-1 flex-1 min-w-[150px]">
            <span className="label-xs">Ticker</span>
            <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="RELIANCE.NS" className="input-bare" />
          </label>
        )}
        <label className="flex flex-col gap-1 w-20">
          <span className="label-xs">Op</span>
          <select value={op} onChange={(e) => setOp(e.target.value as any)} className="input-bare cursor-pointer">
            <option value="<">&lt;</option>
            <option value=">">&gt;</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 w-32">
          <span className="label-xs">Threshold</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} type="number" className="input-bare"
                 placeholder={kind === "spread_10y2y" ? "0" : "18"} />
        </label>
        <button onClick={create} className="btn-primary">Create alert</button>
        {err && <div className="text-red text-xs w-full">{err}</div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div className="heading mb-2">Active & recent</div>
          {alerts.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No alerts yet.</div>}
          <div className="flex flex-col gap-2">
            {alerts.map((a) => (
              <div key={a.id} className="panel-2 p-3 flex items-center gap-3">
                <span className={`text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${a.active ? "border-green/60 text-green" : "border-line2 text-mut"}`}>
                  {a.active ? "Armed" : "Fired"}
                </span>
                <span className="text-sm flex-1">
                  {a.ticker ? <span className="text-amber">{a.ticker} </span> : null}
                  {KIND_LABELS[a.kind]} {a.op} <span className="num">{fmtNum(a.value, 2)}</span>
                </span>
                {a.triggered_at && <span className="text-[10px] text-mut">fired {a.triggered_at.slice(0, 16).replace("T", " ")}</span>}
                <button onClick={() => del(a.id)} className="text-mut hover:text-red" title="Delete alert">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="heading mb-2">Triggered events</div>
          {events.length === 0 && <div className="panel-2 p-4 text-mut text-sm">Nothing has fired yet.</div>}
          <div className="flex flex-col gap-2">
            {events.map((e, i) => (
              <div key={i} className="panel-2 p-3 text-sm flex items-center gap-3">
                <span className="text-amber">▲</span>
                <span className="flex-1">{e.message}</span>
                <span className="text-[10px] text-mut whitespace-nowrap">{e.ts.slice(0, 16).replace("T", " ")}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
