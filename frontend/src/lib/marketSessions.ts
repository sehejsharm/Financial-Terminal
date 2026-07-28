/** Exchange session clocks for the dashboard status rail.
 *
 *  Sessions are declared in each exchange's OWN local time and resolved
 *  through Intl with that exchange's IANA zone, so daylight saving is handled
 *  by the platform rather than by an offset table that goes wrong twice a
 *  year. Pure functions taking `now` as an argument, so they're testable
 *  without freezing the clock.
 *
 *  WHAT THIS DOES NOT KNOW: public holidays. An exchange closed for Diwali or
 *  Thanksgiving still reads "OPEN" here. The UI says so rather than implying
 *  a precision this has no data for — a holiday calendar means a maintained
 *  per-exchange dataset, which is exactly the kind of thing that rots
 *  silently once it stops being updated.
 */

export type Phase = "open" | "closed" | "break" | "pre";

export type Exchange = {
  code: string;
  label: string;
  city: string;
  tz: string;
  /** Trading windows in exchange-local minutes-from-midnight. */
  windows: [number, number][];
  /** 0=Sun … 6=Sat. */
  days: number[];
};

const hm = (h: number, m: number) => h * 60 + m;
const WEEKDAYS = [1, 2, 3, 4, 5];

export const EXCHANGES: Exchange[] = [
  {
    code: "NSE", label: "NSE", city: "Mumbai", tz: "Asia/Kolkata",
    windows: [[hm(9, 15), hm(15, 30)]], days: WEEKDAYS,
  },
  {
    code: "NYSE", label: "NYSE", city: "New York", tz: "America/New_York",
    windows: [[hm(9, 30), hm(16, 0)]], days: WEEKDAYS,
  },
  {
    code: "LSE", label: "LSE", city: "London", tz: "Europe/London",
    windows: [[hm(8, 0), hm(16, 30)]], days: WEEKDAYS,
  },
  {
    // Tokyo breaks for lunch — two windows, not one.
    code: "TSE", label: "TSE", city: "Tokyo", tz: "Asia/Tokyo",
    windows: [[hm(9, 0), hm(11, 30)], [hm(12, 30), hm(15, 30)]], days: WEEKDAYS,
  },
  {
    code: "HKEX", label: "HKEX", city: "Hong Kong", tz: "Asia/Hong_Kong",
    windows: [[hm(9, 30), hm(12, 0)], [hm(13, 0), hm(16, 0)]], days: WEEKDAYS,
  },
  {
    code: "SGX", label: "SGX", city: "Singapore", tz: "Asia/Singapore",
    windows: [[hm(9, 0), hm(12, 0)], [hm(13, 0), hm(17, 0)]], days: WEEKDAYS,
  },
  {
    code: "ASX", label: "ASX", city: "Sydney", tz: "Australia/Sydney",
    windows: [[hm(10, 0), hm(16, 0)]], days: WEEKDAYS,
  },
];

export function exchange(code: string): Exchange | undefined {
  return EXCHANGES.find((e) => e.code === code);
}

/** Wall-clock time at an exchange: minutes-from-midnight and weekday. */
export function localTimeAt(tz: string, now: number): { minutes: number; day: number; hhmm: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit",
    weekday: "short", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // "24" appears at midnight in some ICU builds; normalise it to 0.
  const h = parseInt(get("hour"), 10) % 24;
  const m = parseInt(get("minute"), 10);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minutes: h * 60 + m,
    day: dayMap[get("weekday")] ?? 0,
    hhmm: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  };
}

export type SessionState = {
  code: string;
  label: string;
  city: string;
  phase: Phase;
  /** Exchange-local wall clock, "HH:MM". */
  localTime: string;
  /** Minutes until the next phase change, or null if it's not today. */
  minutesToChange: number | null;
  /** How far through the trading day, 0-1. Null outside the session. */
  progress: number | null;
};

/**
 * Session state for one exchange at `now`.
 *
 * "pre" means the market opens later today; "break" is an intraday halt (the
 * Tokyo/Hong Kong lunch); "closed" is a weekend or after the final bell.
 */
export function sessionState(ex: Exchange, now: number): SessionState {
  const { minutes, day, hhmm } = localTimeAt(ex.tz, now);
  const base = { code: ex.code, label: ex.label, city: ex.city, localTime: hhmm };

  if (!ex.days.includes(day)) {
    return { ...base, phase: "closed", minutesToChange: null, progress: null };
  }

  const first = ex.windows[0][0];
  const last = ex.windows[ex.windows.length - 1][1];

  for (let i = 0; i < ex.windows.length; i++) {
    const [start, end] = ex.windows[i];
    if (minutes >= start && minutes < end) {
      // Progress spans the WHOLE trading day (first open → final bell), so a
      // lunch break doesn't make the bar jump backwards.
      return {
        ...base, phase: "open",
        minutesToChange: end - minutes,
        progress: Math.min(1, Math.max(0, (minutes - first) / (last - first))),
      };
    }
    if (minutes < start) {
      return {
        ...base,
        phase: i === 0 ? "pre" : "break",
        minutesToChange: start - minutes,
        progress: i === 0 ? null : Math.min(1, Math.max(0, (minutes - first) / (last - first))),
      };
    }
  }
  return { ...base, phase: "closed", minutesToChange: null, progress: null };
}

export function sessionsFor(codes: string[], now: number): SessionState[] {
  return codes
    .map((c) => exchange(c))
    .filter((e): e is Exchange => !!e)
    .map((e) => sessionState(e, now));
}

/** "2h 15m" / "45m" — compact countdown for the rail. */
export function fmtCountdown(mins: number | null): string {
  if (mins == null || !Number.isFinite(mins) || mins < 0) return "";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function phaseLabel(s: SessionState): string {
  switch (s.phase) {
    case "open": return `closes in ${fmtCountdown(s.minutesToChange)}`;
    case "pre": return `opens in ${fmtCountdown(s.minutesToChange)}`;
    case "break": return `back in ${fmtCountdown(s.minutesToChange)}`;
    default: return "closed";
  }
}
