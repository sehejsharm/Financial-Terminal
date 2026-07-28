import { describe, expect, it } from "vitest";

import {
  EXCHANGES, exchange, fmtCountdown, localTimeAt, phaseLabel, sessionState,
  sessionsFor,
} from "./marketSessions";

/** A moment expressed in a given zone, as epoch ms. Built by searching for
 *  the UTC instant whose wall clock in `tz` matches — avoids hardcoding
 *  offsets that break under daylight saving. */
function at(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const t = guess - off * 60_000;
    const got = localTimeAt(tz, t);
    if (got.minutes === h * 60 + mi) {
      const dayCheck = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit" })
        .format(new Date(t));
      if (parseInt(dayCheck, 10) === d) return t;
    }
  }
  throw new Error(`could not construct ${tz} ${y}-${mo}-${d} ${h}:${mi}`);
}

describe("localTimeAt", () => {
  it("reports the exchange's own wall clock, not the runner's", () => {
    const t = Date.UTC(2026, 5, 15, 6, 0);   // 06:00 UTC, a Monday
    expect(localTimeAt("Asia/Kolkata", t).hhmm).toBe("11:30");   // UTC+5:30
    expect(localTimeAt("UTC", t).hhmm).toBe("06:00");
  });

  it("tracks daylight saving instead of a fixed offset", () => {
    // New York is UTC-5 in January and UTC-4 in July.
    const jan = Date.UTC(2026, 0, 15, 17, 0);
    const jul = Date.UTC(2026, 6, 15, 17, 0);
    expect(localTimeAt("America/New_York", jan).hhmm).toBe("12:00");
    expect(localTimeAt("America/New_York", jul).hhmm).toBe("13:00");
  });

  it("normalises the midnight hour to 00, never 24", () => {
    const t = at("Asia/Kolkata", 2026, 6, 15, 0, 5);
    expect(localTimeAt("Asia/Kolkata", t).hhmm).toBe("00:05");
    expect(localTimeAt("Asia/Kolkata", t).minutes).toBe(5);
  });

  it("reads the weekday in the exchange's zone, not UTC", () => {
    // Monday 02:00 in Tokyo is still Sunday in UTC.
    const t = at("Asia/Tokyo", 2026, 6, 15, 2, 0);
    expect(localTimeAt("Asia/Tokyo", t).day).toBe(1);
    expect(localTimeAt("UTC", t).day).toBe(0);
  });
});

describe("sessionState — NSE", () => {
  const nse = exchange("NSE")!;

  it("is open mid-session and counts down to the bell", () => {
    const s = sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 12, 30));  // Monday
    expect(s.phase).toBe("open");
    expect(s.minutesToChange).toBe(180);         // 12:30 -> 15:30
    expect(s.localTime).toBe("12:30");
    expect(s.progress).toBeGreaterThan(0.4);
    expect(s.progress).toBeLessThan(0.6);
  });

  it("is 'pre' before the open, counting down to it", () => {
    const s = sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 8, 15));
    expect(s.phase).toBe("pre");
    expect(s.minutesToChange).toBe(60);
    expect(s.progress).toBeNull();
  });

  it("is closed after the bell", () => {
    const s = sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 16, 0));
    expect(s.phase).toBe("closed");
    expect(s.minutesToChange).toBeNull();
  });

  it("is exactly open at 09:15 and exactly closed at 15:30", () => {
    expect(sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 9, 15)).phase).toBe("open");
    expect(sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 15, 30)).phase).toBe("closed");
  });

  it("is closed all weekend", () => {
    for (const d of [13, 14]) {   // Sat, Sun
      const s = sessionState(nse, at("Asia/Kolkata", 2026, 6, d, 12, 0));
      expect(s.phase, `day ${d}`).toBe("closed");
    }
  });
});

describe("sessionState — lunch-break exchanges", () => {
  const tse = exchange("TSE")!;

  it("reports 'break' during the Tokyo lunch, not 'closed'", () => {
    const s = sessionState(tse, at("Asia/Tokyo", 2026, 6, 15, 12, 0));
    expect(s.phase).toBe("break");
    expect(s.minutesToChange).toBe(30);          // back at 12:30
  });

  it("is open in both the morning and the afternoon window", () => {
    expect(sessionState(tse, at("Asia/Tokyo", 2026, 6, 15, 10, 0)).phase).toBe("open");
    expect(sessionState(tse, at("Asia/Tokyo", 2026, 6, 15, 14, 0)).phase).toBe("open");
  });

  it("progress never runs BACKWARDS across the lunch break", () => {
    const morning = sessionState(tse, at("Asia/Tokyo", 2026, 6, 15, 11, 0)).progress!;
    const lunch = sessionState(tse, at("Asia/Tokyo", 2026, 6, 15, 12, 0)).progress!;
    const afternoon = sessionState(tse, at("Asia/Tokyo", 2026, 6, 15, 13, 0)).progress!;
    expect(lunch).toBeGreaterThanOrEqual(morning);
    expect(afternoon).toBeGreaterThanOrEqual(lunch);
  });
});

describe("every declared exchange", () => {
  it("has coherent, non-overlapping, ascending windows", () => {
    for (const ex of EXCHANGES) {
      expect(ex.windows.length, ex.code).toBeGreaterThan(0);
      let prevEnd = -1;
      for (const [s, e] of ex.windows) {
        expect(e, ex.code).toBeGreaterThan(s);
        expect(s, ex.code).toBeGreaterThan(prevEnd);
        expect(e, ex.code).toBeLessThanOrEqual(24 * 60);
        prevEnd = e;
      }
    }
  });

  it("resolves a valid IANA zone", () => {
    for (const ex of EXCHANGES) {
      expect(() => localTimeAt(ex.tz, Date.now()), ex.code).not.toThrow();
    }
  });

  it("produces a renderable state at any hour of a full day", () => {
    for (const ex of EXCHANGES) {
      for (let h = 0; h < 24; h++) {
        const s = sessionState(ex, Date.UTC(2026, 5, 15, h, 0));
        expect(["open", "closed", "break", "pre"], `${ex.code} ${h}`).toContain(s.phase);
        expect(s.localTime, `${ex.code} ${h}`).toMatch(/^\d{2}:\d{2}$/);
        if (s.progress != null) {
          expect(s.progress).toBeGreaterThanOrEqual(0);
          expect(s.progress).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("sessionsFor", () => {
  it("keeps the requested order and silently skips unknown codes", () => {
    const out = sessionsFor(["NYSE", "MADE_UP", "NSE"], Date.now());
    expect(out.map((s) => s.code)).toEqual(["NYSE", "NSE"]);
  });
});

describe("formatting", () => {
  it("formats countdowns compactly", () => {
    expect(fmtCountdown(45)).toBe("45m");
    expect(fmtCountdown(135)).toBe("2h 15m");
    expect(fmtCountdown(0)).toBe("0m");
    expect(fmtCountdown(null)).toBe("");
    expect(fmtCountdown(-5)).toBe("");
  });

  it("labels each phase with what happens next", () => {
    const nse = exchange("NSE")!;
    expect(phaseLabel(sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 12, 30))))
      .toMatch(/^closes in /);
    expect(phaseLabel(sessionState(nse, at("Asia/Kolkata", 2026, 6, 15, 8, 0))))
      .toMatch(/^opens in /);
    expect(phaseLabel(sessionState(nse, at("Asia/Kolkata", 2026, 6, 13, 12, 0))))
      .toBe("closed");
  });
});
