"use client";

/**
 * Global QuoteStore — ONE WebSocket for the whole app, ref-counted per-symbol
 * subscriptions, rAF-batched paint at ~10fps, and a subscription-per-cell
 * model so 200 streaming cells never re-render a whole table.
 *
 * Design (see the streaming plan):
 *  - Components subscribe by symbol via useQuote(); the store ref-counts and
 *    sends {op:sub}/{op:unsub} only on 0↔1 transitions.
 *  - Incoming {t:"px"} deltas land in a `pending` buffer; a single rAF flush
 *    merges them, computes prevLtp (flash direction), and notifies ONLY the
 *    per-symbol listeners whose value changed.
 *  - Seeds from the REST quoteBulk immediately so first paint isn't blank, and
 *    persists last-good ticks to sessionStorage so a reload never shows "—".
 *  - WebSocket primary; falls back to SSE after repeated WS failures.
 *  - Auth: JWT from the mb_token cookie as ?token= (WS can't set headers).
 */
import { api, token, type Quote } from "@/lib/api";

export type Tick = {
  s: string;
  ltp: number | null;
  chg: number | null;
  chgPct: number | null;
  bid?: number | null;
  ask?: number | null;
  vol?: number | null;
  ts: number;
  ccy?: string;
  src?: string;
  stale?: boolean;
  prevLtp?: number | null; // client-tracked, drives the up/down flash
  seeded?: boolean;        // true = from REST/cache, not a live tick yet
};

// "idle" = nothing on this page subscribes to the stream (the badge then
// falls back to the legacy polling indicator during migration).
export type StreamStatus = "idle" | "connecting" | "live" | "reconnecting" | "stale" | "closed";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const WS_URL = API.replace(/^http/, "ws") + "/api/v1/stream";
const SSE_URL = API + "/api/v1/stream/sse";
const STALE_MS = 15_000;
const PERSIST_KEY = "mb_last_ticks";

type Listener = () => void;

class QuoteStore {
  private ticks = new Map<string, Tick>();
  private pending = new Map<string, Partial<Tick>>();
  private symListeners = new Map<string, Set<Listener>>();
  private refcount = new Map<string, number>();
  private statusListeners = new Set<Listener>();

  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  private useSse = false;
  private wsFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushScheduled = false;
  private evalTimer: ReturnType<typeof setInterval> | null = null;

  private _status: StreamStatus = "idle";
  lastTickAt = 0;
  lastMessageAt = 0;
  marketOpen = false;

  constructor() {
    if (typeof window !== "undefined") this.loadPersisted();
  }

  // ── public: per-symbol subscription (ref-counted) ──────────────────────
  subscribe(symbols: string[]): () => void {
    const syms = symbols.map((s) => s.toUpperCase()).filter(Boolean);
    const fresh: string[] = [];
    for (const s of syms) {
      const n = (this.refcount.get(s) || 0) + 1;
      this.refcount.set(s, n);
      if (n === 1) fresh.push(s);
    }
    if (fresh.length) {
      this.ensureConnected();
      this.send({ op: "sub", symbols: fresh });
      this.seed(fresh); // REST fill so cells paint before the first tick
    }
    return () => {
      const gone: string[] = [];
      for (const s of syms) {
        const n = (this.refcount.get(s) || 0) - 1;
        if (n <= 0) { this.refcount.delete(s); gone.push(s); }
        else this.refcount.set(s, n);
      }
      if (gone.length) this.send({ op: "unsub", symbols: gone });
      this.evalStatus();
    };
  }

  getTick(sym: string): Tick | undefined {
    return this.ticks.get(sym.toUpperCase());
  }

  subscribeTick(sym: string, cb: Listener): () => void {
    const s = sym.toUpperCase();
    let set = this.symListeners.get(s);
    if (!set) { set = new Set(); this.symListeners.set(s, set); }
    set.add(cb);
    return () => { set!.delete(cb); if (!set!.size) this.symListeners.delete(s); };
  }

  get status(): StreamStatus { return this._status; }
  subscribeStatus(cb: Listener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  // ── connection ─────────────────────────────────────────────────────────
  private ensureConnected() {
    if (typeof window === "undefined") return;
    if (this.ws || this.es) return;
    if (!this.evalTimer) this.evalTimer = setInterval(() => this.evalStatus(), 1000);
    this.useSse ? this.connectSse() : this.connectWs();
  }

  private connectWs() {
    const tk = token.get();
    try {
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(tk || "")}`);
      this.ws = ws;
      this.setStatus("connecting");
      ws.onopen = () => {
        this.wsFailures = 0;
        this.lastMessageAt = Date.now();
        this.resubscribeAll();
        this.evalStatus();
      };
      ws.onmessage = (e) => this.onFrame(e.data);
      ws.onclose = () => { this.ws = null; this.scheduleReconnect(); };
      ws.onerror = () => { this.wsFailures++; try { ws.close(); } catch { /* noop */ } };
    } catch {
      this.wsFailures++;
      this.scheduleReconnect();
    }
  }

  private connectSse() {
    const tk = token.get();
    const syms = [...this.refcount.keys()];
    const es = new EventSource(
      `${SSE_URL}?token=${encodeURIComponent(tk || "")}&symbols=${encodeURIComponent(syms.join(","))}`);
    this.es = es;
    this.setStatus("connecting");
    es.onopen = () => { this.lastMessageAt = Date.now(); this.evalStatus(); };
    es.onmessage = (e) => this.onFrame(e.data);
    es.onerror = () => { es.close(); this.es = null; this.scheduleReconnect(); };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.setStatus("reconnecting");
    // After 3 WS failures, fall back to SSE for the rest of the session.
    if (!this.useSse && this.wsFailures >= 3) this.useSse = true;
    const attempt = Math.min(this.wsFailures, 6);
    const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.refcount.size) this.ensureConnected();
      else this.setStatus("closed");
    }, delay);
  }

  private resubscribeAll() {
    const syms = [...this.refcount.keys()];
    if (syms.length) this.send({ op: "sub", symbols: syms });
  }

  private send(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // SSE is receive-only; its subscriptions are fixed at connect time. A sub
    // change under SSE forces a reconnect with the new symbol set.
    else if (this.es && (msg as any)?.op) {
      this.es.close(); this.es = null; this.scheduleReconnect();
    }
  }

  // ── frames ─────────────────────────────────────────────────────────────
  private onFrame(raw: string) {
    this.lastMessageAt = Date.now();
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case "px":
      case "snap":
        for (const d of msg.d || []) this.pending.set(d.s, { ...this.pending.get(d.s), ...d });
        this.lastTickAt = Date.now();
        this.scheduleFlush();
        break;
      case "stat":
        this.marketOpen = !!msg.d?.marketOpen;
        this.evalStatus();
        break;
      case "hb":
        this.evalStatus();
        break;
    }
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => { this.flushScheduled = false; this.flush(); };
    // rAF batches paint to the frame rate; setTimeout fallback keeps ~10fps
    // when the tab is backgrounded (rAF pauses there).
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(run);
    else setTimeout(run, 100);
  }

  private flush() {
    if (!this.pending.size) return;
    const changed: string[] = [];
    for (const [sym, delta] of this.pending) {
      const prev = this.ticks.get(sym);
      const prevLtp = prev?.ltp ?? null;
      const next: Tick = {
        s: sym,
        ltp: prev?.ltp ?? null, chg: prev?.chg ?? null, chgPct: prev?.chgPct ?? null,
        bid: prev?.bid, ask: prev?.ask, vol: prev?.vol,
        ccy: prev?.ccy, src: prev?.src, stale: prev?.stale,
        ts: prev?.ts ?? 0,
        ...delta,
        prevLtp,
        seeded: false,
      };
      this.ticks.set(sym, next);
      changed.push(sym);
    }
    this.pending.clear();
    this.persist();
    for (const sym of changed) {
      const set = this.symListeners.get(sym);
      if (set) for (const cb of set) cb();
    }
  }

  // ── REST seed + persistence (no blank first paint / reload) ────────────
  private async seed(symbols: string[]) {
    const need = symbols.filter((s) => !this.ticks.get(s));
    if (!need.length) return;
    try {
      const quotes = await api.quoteBulk(need);
      let touched = false;
      for (const [sym, q] of Object.entries(quotes)) {
        const s = sym.toUpperCase();
        if (this.ticks.get(s) || !q) continue; // a live tick already arrived
        this.ticks.set(s, this.fromQuote(s, q));
        touched = true;
        const set = this.symListeners.get(s);
        if (set) for (const cb of set) cb();
      }
      if (touched) this.persist();
    } catch { /* live socket will fill it */ }
  }

  private fromQuote(sym: string, q: Quote): Tick {
    const price = q.price;
    const prev = q.prev_close;
    return {
      s: sym, ltp: price, prevLtp: price,
      chg: price != null && prev != null ? price - prev : null,
      chgPct: q.change_pct ?? null,
      ccy: q.currency ?? undefined,
      ts: Date.now(), seeded: true,
    };
  }

  private persist() {
    try {
      const obj: Record<string, Tick> = {};
      for (const [s, t] of this.ticks) obj[s] = t;
      sessionStorage.setItem(PERSIST_KEY, JSON.stringify(obj));
    } catch { /* quota / private mode */ }
  }

  private loadPersisted() {
    try {
      const raw = sessionStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, Tick>;
      for (const [s, t] of Object.entries(obj)) this.ticks.set(s, { ...t, seeded: true });
    } catch { /* noop */ }
  }

  // ── status ─────────────────────────────────────────────────────────────
  private evalStatus() {
    if (this.refcount.size === 0) { this.setStatus("idle"); return; }
    const open = !!(this.ws && this.ws.readyState === WebSocket.OPEN) || !!this.es;
    let next: StreamStatus;
    if (!open) next = this.reconnectTimer ? "reconnecting" : "connecting";
    else if (!this.marketOpen) next = "closed";
    else if (Date.now() - this.lastTickAt > STALE_MS) next = "stale";
    else next = "live";
    this.setStatus(next);
  }

  private setStatus(s: StreamStatus) {
    if (s === this._status) return;
    this._status = s;
    for (const cb of this.statusListeners) cb();
  }
}

// Module singleton — one store, one socket, for the whole app.
export const quoteStore = new QuoteStore();
