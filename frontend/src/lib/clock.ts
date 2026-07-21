"use client";

import { useSyncExternalStore } from "react";

/**
 * One clock for the whole app. Every "Updated Xs ago" / "Xm ago" label reads
 * from this single 1-second tick, so they can't drift relative to each other
 * (previously DataAge ran its own 15s interval and two News copies never
 * ticked at all). One timer, shared via useSyncExternalStore.
 */
let now = typeof Date !== "undefined" ? Date.now() : 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => {
    now = Date.now();
    subs.forEach((f) => f());
  }, 1000);
}

function subscribe(cb: () => void) {
  ensureTimer();
  subs.add(cb);
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

/** Shared "now" (epoch ms), updated once per second for every consumer. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

/** "just now / 12s ago / 3m ago / 2h 5m ago / 4d ago" from an epoch-ms or
 *  ISO timestamp, measured against a caller-supplied `now` (pass useNow()). */
export function formatAge(at: number | string | null | undefined, nowMs: number): string {
  const ms = at == null ? null : typeof at === "string" ? Date.parse(at) : at;
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Compact "12m ago / 3h ago / 2d ago" for news-style lists ("" when future
 *  or unknown). */
export function timeAgoShort(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const secs = (nowMs - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(secs) || secs < 0) return "";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
