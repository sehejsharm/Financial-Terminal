"use client";

import { useMemo } from "react";
import { Radio } from "lucide-react";

import { useNow } from "@/lib/clock";
import { fmtCountdown, sessionsFor, type SessionState } from "@/lib/marketSessions";
import { useStreamStatus } from "@/lib/useQuote";
import type { Region } from "@/lib/instruments";

/**
 * The flight-deck rail: exchange clocks, socket state and board size, in one
 * band across the top of the dashboard.
 *
 * Every element is real. The session clocks are computed from each exchange's
 * own timezone, the LIVE/STALE state is the actual socket, and the instrument
 * count is what's genuinely subscribed. Nothing here animates to look busy.
 */

const PHASE_STYLE: Record<SessionState["phase"], { dot: string; text: string; word: string }> = {
  open:   { dot: "bg-green",       text: "text-green", word: "OPEN" },
  break:  { dot: "bg-amber",       text: "text-amber", word: "BREAK" },
  pre:    { dot: "bg-amber/60",    text: "text-mut",   word: "PRE" },
  closed: { dot: "bg-line2",       text: "text-mut",   word: "CLOSED" },
};

function ClockCell({ s }: { s: SessionState }) {
  const st = PHASE_STYLE[s.phase];
  const tip = s.phase === "open"
    ? `${s.city} — open, closes in ${fmtCountdown(s.minutesToChange)}`
    : s.phase === "pre" ? `${s.city} — opens in ${fmtCountdown(s.minutesToChange)}`
    : s.phase === "break" ? `${s.city} — intraday break, resumes in ${fmtCountdown(s.minutesToChange)}`
    : `${s.city} — closed`;

  return (
    // flex-1 so the clocks spread across the rail instead of bunching at the
    // left and leaving a dead band in the middle.
    <div title={`${tip}. Holidays are not modelled.`}
         className="flex flex-col gap-1 px-3 py-2 min-w-[104px] flex-1 border-r border-line">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${s.phase === "open" ? "animate-pulse" : ""}`} />
        <span className="text-[10.5px] tracking-[0.1em] text-txt font-bold">{s.label}</span>
      </div>
      <div className="num text-[13px] text-txt leading-none">{s.localTime}</div>
      <div className={`text-[9.5px] uppercase tracking-wider ${st.text}`}>
        {st.word}
        {s.minutesToChange != null && s.phase !== "closed" && (
          <span className="text-mut"> · {fmtCountdown(s.minutesToChange)}</span>
        )}
      </div>
      <div className="hud-track h-[2px] w-full">
        <div className={`hud-fill h-full ${s.phase === "open" ? "" : "opacity-40"}`}
             style={{
               width: `${Math.round((s.progress ?? 0) * 100)}%`,
               background: s.phase === "open" ? "rgb(var(--c-green))" : "rgb(var(--c-mut))",
             }} />
      </div>
    </div>
  );
}

const SOCKET: Record<string, { label: string; cls: string; tip: string }> = {
  live:         { label: "LIVE",   cls: "text-green", tip: "Ticks are arriving over the socket right now." },
  reconnecting: { label: "RECONN", cls: "text-amber", tip: "Socket dropped — reconnecting with backoff." },
  stale:        { label: "STALE",  cls: "text-red",   tip: "Connected, but no ticks recently. The feed may be paused." },
  closed:       { label: "CLOSED", cls: "text-mut",   tip: "Markets closed — showing each instrument's last session value." },
  connecting:   { label: "SYNC",   cls: "text-amber", tip: "Opening the market data socket…" },
};

export function StatusRail({ region, instrumentCount, pricedCount }: {
  region: Region; instrumentCount: number; pricedCount: number;
}) {
  const now = useNow();
  const { status } = useStreamStatus();
  const sessions = useMemo(() => sessionsFor(region.clocks, now), [region.clocks, now]);
  const sock = SOCKET[status] ?? SOCKET.connecting;

  const localTime = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).format(new Date(now));
    } catch { return ""; }
  }, [now]);

  const coverage = instrumentCount > 0
    ? Math.round((pricedCount / instrumentCount) * 100) : 0;

  return (
    <div data-testid="status-rail" className="hud hud-sweep mb-5 overflow-hidden">
      <div className="hud-sweep-bar" />
      <div className="flex flex-wrap items-stretch relative">
        {/* Identity block */}
        <div className="flex flex-col justify-center px-4 py-2 border-r border-line min-w-[168px]">
          <div className="flex items-center gap-2">
            <Radio size={12} className={`${sock.cls} ${status === "live" ? "animate-pulse" : ""}`} />
            <span className={`text-[10.5px] tracking-[0.14em] font-bold ${sock.cls}`}
                  title={sock.tip}>
              {sock.label}
            </span>
          </div>
          <div className="num text-[13px] text-txt leading-none mt-1.5">{localTime}</div>
          <div className="text-[9.5px] uppercase tracking-wider text-mut mt-1">
            {region.flag} {region.label} · {region.currency}
          </div>
        </div>

        {sessions.map((s) => <ClockCell key={s.code} s={s} />)}

        {/* Coverage block — honest instrument accounting. */}
        <div className="flex flex-col justify-center px-4 py-2 min-w-[132px] shrink-0"
             title={`${pricedCount} of ${instrumentCount} tiles on this board currently have a price. `
                    + `Tiles showing "—" aren't broken — the free data tier doesn't quote that symbol from this host.`}>
          <div className="label-xs">Feed coverage</div>
          <div className="num text-[15px] text-txt leading-none mt-1">
            {pricedCount}<span className="text-mut text-[11px]">/{instrumentCount}</span>
          </div>
          <div className="hud-track h-[2px] w-full mt-1.5">
            <div className="hud-fill h-full"
                 style={{
                   width: `${coverage}%`,
                   background: coverage >= 80 ? "rgb(var(--c-green))"
                     : coverage >= 40 ? "rgb(var(--c-amber))" : "rgb(var(--c-red))",
                 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
