"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { TickerInput } from "@/components/TickerInput";
import { Shell } from "@/components/Shell";
import { Methodology } from "@/components/Methodology";
import { Note, PageHeader } from "@/components/ui";
import { api, type Alert, type AlertEvent } from "@/lib/api";
import {
  alertsNote, distanceLabel, findDuplicate, health, KINDS, metaFor, validate,
  type Kind, type Op,
} from "@/lib/alertCheck";
import { useLive } from "@/lib/useLive";
import { fmtNum } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = {
  price: "Price",
  pe: "Trailing P/E",
  spread_10y2y: "US 10Y–2Y spread",
  move: "Abs day move %",
  volume_spike: "Volume vs 30d avg (x)",
};

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Delivery channels: email (your address), Telegram (free "text"), and
 *  web push (per-device). Server-side credentials are configured by the
 *  master admin right here in the UI — no shell access needed. */
function DeliveryPanel() {
  const [cfg, setCfg] = useState<{
    email: boolean; push: boolean; telegram: boolean;
    vapid_public_key: string | null; my_email: string | null; telegram_linked: boolean;
  } | null>(null);
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled" | "denied" | "error">("idle");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [myEmail, setMyEmail] = useState("");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [tg, setTg] = useState<{ bot: string | null; code: string } | null>(null);
  const [tgMsg, setTgMsg] = useState<string | null>(null);
  const [me, setMe] = useState<{ username: string; role: string } | null>(null);

  function loadCfg() {
    api.pushConfig().then((c) => { setCfg(c); setMyEmail(c.my_email ?? ""); }).catch(() => setCfg(null));
  }
  useEffect(() => {
    loadCfg();
    api.me().then(setMe).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveEmail() {
    setEmailMsg("Saving…");
    try {
      await api.setDeliveryEmail(myEmail.trim());
      setEmailMsg(myEmail.trim() ? "Saved — alerts will email this address ✓" : "Cleared.");
    } catch (e: any) { setEmailMsg(e?.detail || "Save failed."); }
  }

  async function tgStart() {
    setTgMsg(null);
    try { setTg(await api.telegramStart()); }
    catch (e: any) { setTgMsg(e?.detail || "Telegram isn't configured yet."); }
  }

  async function tgVerify() {
    setTgMsg("Checking…");
    try {
      await api.telegramVerify();
      setTg(null); setTgMsg("Linked ✓ — you'll get alerts on Telegram.");
      loadCfg();
    } catch (e: any) { setTgMsg(e?.detail || "Not found yet — send the code first."); }
  }

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
      if (r.results.telegram !== null) parts.push(`Telegram ${r.results.telegram ? "sent ✓" : "failed"}`);
      if (r.results.push !== null) parts.push(`push ${r.results.push ? "sent ✓" : "failed"} (${r.devices} device${r.devices === 1 ? "" : "s"})`);
      setTestMsg(parts.length ? parts.join(" · ") : "No delivery channels active yet — set them up below.");
    } catch { setTestMsg("Test failed."); }
  }

  return (
    <div className="panel-2 p-3 mb-6">
      <div className="flex flex-wrap items-center gap-3 text-xs mb-3">
        <span className="label-xs">Delivery channels</span>
        <span className={`chip ${cfg?.email ? "!text-green !border-green/50" : ""}`}>
          Email {cfg === null ? "…" : cfg.email ? "ready" : "off"}
        </span>
        <span className={`chip ${cfg?.telegram ? "!text-green !border-green/50" : ""}`}>
          Telegram {cfg === null ? "…" : cfg.telegram ? (cfg.telegram_linked ? "linked ✓" : "ready") : "off"}
        </span>
        <span className={`chip ${cfg?.push ? "!text-green !border-green/50" : ""}`}>
          Push {cfg === null ? "…" : cfg.push ? "available" : "off"}
        </span>
        <button onClick={test} className="btn-ghost text-xs">Send test alert</button>
        {testMsg && <span className="text-mut">{testMsg}</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        {/* Email — per-user address */}
        <div>
          <div className="label-xs mb-1.5">Email me at</div>
          <div className="flex gap-1.5">
            <input value={myEmail} onChange={(e) => setMyEmail(e.target.value)}
                   placeholder="you@example.com" className="input-bare flex-1 min-w-0 !py-1 text-xs" />
            <button onClick={saveEmail} className="btn-ghost text-xs shrink-0">Save</button>
          </div>
          {emailMsg && <div className="text-mut mt-1">{emailMsg}</div>}
          {cfg !== null && !cfg.email && (
            <div className="text-[10px] text-mut mt-1">
              Email sending isn&apos;t set up on the server yet
              {me?.role === "master_admin" ? " — configure it below." : " — ask the admin."}
            </div>
          )}
        </div>

        {/* Telegram — free instant messages to your phone */}
        <div>
          <div className="label-xs mb-1.5">Telegram (free texts to your phone)</div>
          {cfg?.telegram_linked && !tg && (
            <div className="flex items-center gap-2">
              <span className="text-green">Linked ✓</span>
              <button onClick={async () => { await api.telegramUnlink().catch(() => {}); loadCfg(); }}
                      className="btn-ghost text-xs">Unlink</button>
            </div>
          )}
          {!cfg?.telegram_linked && !tg && (
            <button onClick={tgStart} className="btn-ghost text-xs">Link my Telegram</button>
          )}
          {tg && (
            <ol className="list-decimal pl-4 space-y-1 text-mut">
              <li>Open <a className="text-amber underline" target="_blank" rel="noopener noreferrer"
                          href={`https://t.me/${tg.bot ?? ""}`}>@{tg.bot ?? "the bot"}</a> in Telegram</li>
              <li>Tap <strong className="text-txt">Start</strong>, then send: <code className="text-amber">{tg.code}</code></li>
              <li><button onClick={tgVerify} className="btn-ghost text-xs">I sent it — verify</button></li>
            </ol>
          )}
          {tgMsg && <div className="text-mut mt-1">{tgMsg}</div>}
          {cfg !== null && !cfg.telegram && (
            <div className="text-[10px] text-mut mt-1">
              Not set up on the server yet
              {me?.role === "master_admin" ? " — add a bot token below." : " — ask the admin."}
            </div>
          )}
        </div>

        {/* Browser push */}
        <div>
          <div className="label-xs mb-1.5">Browser push</div>
          {cfg?.push && pushState !== "enabled" && (
            <button onClick={enablePush} disabled={pushState === "enabling"} className="btn-ghost text-xs">
              {pushState === "enabling" ? "Enabling…" : "Enable push on this device"}
            </button>
          )}
          {pushState === "enabled" && <span className="text-green">This device will receive push alerts ✓</span>}
          {pushState === "denied" && <span className="text-red">Notifications blocked in browser settings.</span>}
          {pushState === "error" && <span className="text-red">Could not subscribe — try again.</span>}
          {cfg !== null && !cfg.push && (
            <div className="text-[10px] text-mut mt-1">Not configured on the server (VAPID keys).</div>
          )}
        </div>
      </div>

      {me?.role === "master_admin" && <AdminDeliverySetup onSaved={loadCfg} />}
    </div>
  );
}

/** Master-admin server setup for email + Telegram — edited here in the UI
 *  and stored server-side, so enabling delivery never requires shell access. */
function AdminDeliverySetup({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<Record<string, string>>({});
  const [botName, setBotName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.deliveryServerConfig()
      .then((r) => { setS(r.settings); setBotName(r.telegram_bot); })
      .catch(() => {});
  }, [open]);

  async function save() {
    setMsg("Saving…");
    try {
      const r = await api.saveDeliveryServerConfig(s);
      setMsg(`Saved ✓ — email ${r.channels.email ? "ON" : "off"}, Telegram ${r.channels.telegram ? "ON" : "off"}.`);
      onSaved();
    } catch (e: any) { setMsg(e?.detail || "Save failed."); }
  }

  // Plain function returning a <SettingField> element (stable module-level
  // type). Rendering an inline component TYPE here would remount the input
  // on every keystroke — same bug class as the WACC panel.
  const F = (props: { k: string; label: string; placeholder?: string; secret?: boolean }) => (
    <SettingField key={props.k} label={props.label} placeholder={props.placeholder}
                  secret={props.secret} value={s[props.k] ?? ""}
                  onChange={(v) => setS((p) => ({ ...p, [props.k]: v }))} />
  );

  return (
    <div className="mt-4 pt-3 border-t border-line">
      <button onClick={() => setOpen((v) => !v)} className="text-amber text-xs hover:underline">
        {open ? "▾ Hide" : "▸ Admin: delivery setup (email + Telegram)"}
      </button>
      {open && (
        <div className="mt-3 space-y-4 text-xs">
          <div>
            <div className="label-xs mb-1">Email (free via a Gmail App Password)</div>
            <div className="text-mut text-[10.5px] mb-2">
              1) Turn on 2-step verification for a Gmail account · 2) create an App
              Password at myaccount.google.com/apppasswords · 3) paste it here with
              host <code className="text-amber">smtp.gmail.com</code>, port 587, and the
              Gmail address as user. (Any other SMTP service works the same way.)
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {F({ k: "smtp_host", label: "SMTP host", placeholder: "smtp.gmail.com" })}
              {F({ k: "smtp_port", label: "Port", placeholder: "587" })}
              {F({ k: "smtp_user", label: "User (email)", placeholder: "you@gmail.com" })}
              {F({ k: "smtp_pass", label: "App password", secret: true })}
              {F({ k: "smtp_from", label: "From (optional)" })}
              {F({ k: "alert_email_to", label: "Fallback recipient (optional)" })}
            </div>
          </div>
          <div>
            <div className="label-xs mb-1">Telegram bot (free)</div>
            <div className="text-mut text-[10.5px] mb-2">
              In Telegram, message <a className="text-amber underline" target="_blank"
              rel="noopener noreferrer" href="https://t.me/BotFather">@BotFather</a> →
              send <code className="text-amber">/newbot</code> → pick any name → paste the
              token it gives you here. Every user can then link their own Telegram above.
              {botName && <span className="text-green"> Current bot: @{botName} ✓</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {F({ k: "telegram_bot_token", label: "Bot token", secret: true })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={save} className="btn-primary text-xs">Save delivery settings</button>
            {msg && <span className="text-mut">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Alert center: create/delete conditions + triggered-event feed.
 *  Conditions are evaluated server-side every ~60s; triggered alerts
 *  deactivate and land in the feed (and the header bell). */
export default function AlertsPage() {
  const [kind, setKind] = useState<Kind>("price");
  const [ticker, setTicker] = useState("");
  const [op, setOp] = useState<Op>("<");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // The live value of whatever the draft condition measures. Without it an
  // alert that can never fire looks exactly like a good one.
  const [current, setCurrent] = useState<number | null>(null);
  const [currentBusy, setCurrentBusy] = useState(false);
  useEffect(() => {
    const t = ticker.trim().toUpperCase();
    if (!metaFor(kind).needsTicker || !t) { setCurrent(null); return; }
    let alive = true;
    setCurrentBusy(true);
    // Price and day-move come off the quote; P/E off the snapshot. A kind
    // with no cheap source stays null, and the validator says so rather than
    // implying the alert is fine.
    const src = kind === "pe"
      ? api.snapshot(t).then((sn) => (sn?.trailing_pe as number | undefined) ?? null)
      : api.quote(t).then((q) => (kind === "move"
          ? (q?.change_pct != null ? Math.abs(q.change_pct) : null)
          : q?.price ?? null));
    src.then((v) => { if (alive) setCurrent(typeof v === "number" ? v : null); })
       .catch(() => { if (alive) setCurrent(null); })
       .finally(() => { if (alive) setCurrentBusy(false); });
    return () => { alive = false; };
  }, [kind, ticker]);

  const { data, busy, updatedAt, refresh } = useLive<{ alerts: Alert[]; events: AlertEvent[] }>(
    () => api.alerts(), 30_000,
  );

  async function create() {
    setErr(null);
    const v = parseFloat(value);
    if (Number.isNaN(v)) { setErr("Threshold value required."); return; }
    if (kind !== "spread_10y2y" && !ticker.trim()) { setErr("Ticker required for this alert kind."); return; }
    const dupe = findDuplicate(data?.alerts ?? [], { kind, ticker, op, value: v });
    if (dupe && !confirm(
      `You already have this exact alert (${dupe.active ? "armed" : "fired"}). `
      + "Create a second one anyway?")) return;
    try {
      await api.createAlert({ kind, ticker: kind === "spread_10y2y" ? null : ticker.trim().toUpperCase(), op, value: v });
      setValue(""); refresh();
      // Mark bell as seen up to now (new events after this will badge).
    } catch (e: any) { setErr(e?.detail || "Could not create alert."); }
  }

  async function del(id: string) {
    if (!confirm("Delete this alert? This cannot be undone.")) return;
    try { await api.deleteAlert(id); refresh(); } catch { /* noop */ }
  }

  const alerts = data?.alerts ?? [];
  const events = [...(data?.events ?? [])].reverse();
  const parsed = value.trim() === "" ? null : parseFloat(value);
  const problems = value.trim() === "" ? []
    : validate({ kind, op, value: parsed, ticker }, current);
  // Only a hard error blocks. A warning is information, not a veto — the user
  // may well mean the unusual number.
  const blocked = problems.some((p) => p.severity === "error");

  return (
    <Shell>
      <PageHeader
        title="ALERTS"
        subtitle="Evaluated server-side every ~60s against live provider data.
                  Triggered alerts deactivate and appear in the feed and the
                  header bell."
        actions={<DataAge at={updatedAt} onRefresh={refresh} busy={busy} />} />

      <DeliveryPanel />

      <div className="panel-2 p-3 mb-6 flex flex-wrap items-end gap-2"
           data-testid="alert-form">
        <label className="flex flex-col gap-1 w-44">
          <span className="label-xs">Condition</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as any)} className="input-bare cursor-pointer">
            <option value="price">Price</option>
            <option value="pe">Trailing P/E</option>
            <option value="move">Abs day move %</option>
            <option value="volume_spike">Volume spike (x avg)</option>
            <option value="spread_10y2y">US 10Y–2Y spread</option>
          </select>
        </label>
        {kind !== "spread_10y2y" && (
          <label className="flex flex-col gap-1 flex-1 min-w-[150px]">
            <span className="label-xs">Ticker</span>
            <TickerInput value={ticker} onCommit={setTicker} placeholder="RELIANCE.NS" />
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
        <button onClick={create} disabled={blocked} className="btn-primary">
          Create alert
        </button>
        {err && <div className="text-red text-xs w-full">{err}</div>}

        {/* What is wrong with this alert, before it is armed. An alert that
            can never fire looked exactly like a good one. */}
        <div className="w-full flex flex-col gap-1">
          {metaFor(kind).needsTicker && ticker.trim() && (
            <div className="text-[10.5px] text-mut num">
              {currentBusy ? "checking current value…"
                : current != null
                  ? `${metaFor(kind).label} now: ${fmtNum(current, 2)}${metaFor(kind).unit}`
                  : "current value unavailable for this listing"}
            </div>
          )}
          {problems.map((p) => (
            <div key={p.text}
                 className={`text-[10.5px] leading-relaxed ${
                   p.severity === "error" ? "text-red"
                     : p.severity === "warn" ? "text-amber/90" : "text-mut"}`}>
              {p.text}
            </div>
          ))}
          {!problems.length && value.trim() && (
            <div className="text-[10.5px] text-green">
              {distanceLabel(op, parseFloat(value), current, kind)}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div className="heading mb-2">Active & recent</div>
          {alerts.length === 0 && <div className="panel-2 p-4 text-mut text-sm">No alerts yet.</div>}
          <div className="mb-2"><Note>{alertsNote(health(alerts))}</Note></div>
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
                {a.active && a.ticker === ticker.trim().toUpperCase() && current != null && (
                  <span className="text-[10px] text-mut whitespace-nowrap num">
                    {distanceLabel(a.op as Op, a.value, current, a.kind as Kind)}
                  </span>
                )}
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
              <div key={i} className="panel-2 p-3 text-sm flex items-center gap-3 flex-wrap">
                <span className="text-amber">▲</span>
                <span className="flex-1 min-w-[200px]">{e.message}</span>
                {/* Delivery history: which channels this event actually
                    reached (in-app is implicit — you're reading it). */}
                {e.delivery && Object.keys(e.delivery).length > 0 && (
                  <span className="flex gap-1">
                    {Object.entries(e.delivery).map(([ch, ok]) => (
                      <span key={ch}
                            title={ok ? `Delivered via ${ch}` : `${ch} delivery FAILED`}
                            className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${
                              ok ? "border-green/50 text-green" : "border-red/60 text-red"}`}>
                        {ch} {ok ? "✓" : "✗"}
                      </span>
                    ))}
                  </span>
                )}
                <span className="text-[10px] text-mut whitespace-nowrap">{e.ts.slice(0, 16).replace("T", " ")}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <Methodology id="alerts" className="mt-4" />
    </Shell>
  );
}

/** Controlled settings input — module-level so its identity is stable and
 *  React never remounts it mid-keystroke. */
function SettingField({ label, value, onChange, placeholder, secret }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; secret?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label-xs">{label}</span>
      <input value={value} type={secret ? "password" : "text"}
             onChange={(e) => onChange(e.target.value)}
             placeholder={placeholder} className="input-bare !py-1 text-xs"
             autoComplete="off" />
    </label>
  );
}
