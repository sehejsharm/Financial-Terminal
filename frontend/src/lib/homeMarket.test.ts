import { beforeEach, describe, expect, it } from "vitest";

import {
  loadMarket, marketFor, marketFromTimezone, MARKETS, moversNote,
  resolveMarket, saveMarket, sessionState,
} from "./homeMarket";

function fakeStorage(fail = false) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (fail ? (() => { throw new Error("no"); })() : map.get(k) ?? null),
    setItem: (k: string, v: string) => { if (fail) throw new Error("no"); map.set(k, v); },
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(), key: () => null, length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = fakeStorage();
});

describe("marketFromTimezone", () => {
  it("puts an Indian reader in the Indian market", () => {
    // The bug: NIFTY was served to everyone, so a New York reader at 9am
    // local saw an Indian session that had closed hours earlier.
    expect(marketFromTimezone("Asia/Kolkata")).toBe("IN");
    expect(marketFromTimezone("Asia/Calcutta")).toBe("IN");
  });

  it("routes the Americas to the US", () => {
    for (const tz of ["America/New_York", "America/Chicago", "America/Sao_Paulo",
                      "US/Pacific", "Canada/Eastern"]) {
      expect(marketFromTimezone(tz), tz).toBe("US");
    }
  });

  it("separates the UK from the euro area", () => {
    expect(marketFromTimezone("Europe/London")).toBe("GB");
    expect(marketFromTimezone("Europe/Dublin")).toBe("GB");
    expect(marketFromTimezone("Europe/Paris")).toBe("EU");
    expect(marketFromTimezone("Europe/Berlin")).toBe("EU");
  });

  it("routes the rest of Asia-Pacific to its own board", () => {
    for (const tz of ["Asia/Tokyo", "Asia/Hong_Kong", "Asia/Singapore",
                      "Australia/Sydney"]) {
      expect(marketFromTimezone(tz), tz).toBe("AS");
    }
  });

  it("checks India BEFORE the rest of Asia", () => {
    // Asia/Kolkata matches both rules; order is what makes it India.
    expect(marketFromTimezone("Asia/Kolkata")).toBe("IN");
  });

  it("falls back to the home market rather than guessing", () => {
    expect(marketFromTimezone(null)).toBe("IN");
    expect(marketFromTimezone("")).toBe("IN");
    expect(marketFromTimezone("Mars/Olympus")).toBe("IN");
  });
});

describe("resolveMarket", () => {
  it("lets a SAVED choice beat the timezone", () => {
    // Someone in Dubai who picked India means it; re-deriving every load
    // would quietly overrule them.
    expect(resolveMarket("IN", "America/New_York")).toBe("IN");
    expect(resolveMarket("US", "Asia/Kolkata")).toBe("US");
  });

  it("uses the timezone when nothing is saved", () => {
    expect(resolveMarket(null, "Europe/London")).toBe("GB");
  });

  it("ignores a saved value that is no longer a market", () => {
    expect(resolveMarket("ZZ", "America/New_York")).toBe("US");
  });
});

describe("loadMarket / saveMarket", () => {
  it("round-trips a choice", () => {
    saveMarket("GB");
    expect(loadMarket()).toBe("GB");
  });

  it("survives storage being unavailable", () => {
    (globalThis as { localStorage: Storage }).localStorage = fakeStorage(true);
    expect(() => saveMarket("US")).not.toThrow();
    expect(() => loadMarket()).not.toThrow();
  });
});

describe("marketFor", () => {
  it("names the index each board ranks within", () => {
    expect(marketFor("IN").index).toBe("NIFTY 50");
    expect(marketFor("US").index).toBe("Dow 30");
  });

  it("falls back to the home market on an unknown key", () => {
    expect(marketFor("ZZ").key).toBe("IN");
    expect(marketFor(null).key).toBe("IN");
  });

  it("has a unique key per market", () => {
    const keys = MARKETS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("sessionState", () => {
  const IN = marketFor("IN");
  const US = marketFor("US");

  it("knows an Indian market is open mid-session", () => {
    // 2026-06-30 is a Tuesday. 06:00 UTC is 11:30 in Kolkata.
    const s = sessionState(IN, new Date("2026-06-30T06:00:00Z"));
    expect(s.open).toBe(true);
    expect(s.localTime).toBe("11:30");
    expect(s.read).toMatch(/India is open/);
  });

  it("knows it is closed before the bell", () => {
    // 02:00 UTC is 07:30 in Kolkata — before the 09:15 open.
    const s = sessionState(IN, new Date("2026-06-30T02:00:00Z"));
    expect(s.open).toBe(false);
    expect(s.read).toMatch(/last session's moves, not live ones/);
  });

  it("knows it is closed after the bell", () => {
    // 12:00 UTC is 17:30 in Kolkata — after the 15:30 close.
    expect(sessionState(IN, new Date("2026-06-30T12:00:00Z")).open).toBe(false);
  });

  it("closes for the weekend regardless of the hour", () => {
    // 2026-07-04 is a Saturday; 06:00 UTC would be mid-session on a weekday.
    const s = sessionState(IN, new Date("2026-07-04T06:00:00Z"));
    expect(s.open).toBe(false);
    expect(s.read).toMatch(/closed for the weekend/);
  });

  it("reads each venue in ITS OWN time", () => {
    // 14:00 UTC: India closed (19:30), US open (10:00 ET).
    const at = new Date("2026-06-30T14:00:00Z");
    expect(sessionState(IN, at).open).toBe(false);
    expect(sessionState(US, at).open).toBe(true);
    expect(sessionState(US, at).localTime).toBe("10:00");
  });
});

describe("moversNote", () => {
  const note = () => moversNote(
    marketFor("IN"), 50,
    sessionState(marketFor("IN"), new Date("2026-06-30T06:00:00Z")));

  it("says which universe the ranking is within", () => {
    // "Top gainer out of thirty" and "out of two thousand" are different
    // claims, and a bare list makes them look identical.
    expect(note()).toMatch(/Ranked within 50 NIFTY 50 constituents/);
    expect(note()).toMatch(/not the whole exchange/);
  });

  it("explains why it is not the whole exchange", () => {
    expect(note()).toMatch(/micro-caps moving 20% on almost no volume/);
  });

  it("admits it does not know public holidays", () => {
    expect(note()).toMatch(/can read “open” on a holiday/);
  });

  it("carries the session state through", () => {
    expect(note()).toMatch(/India is open/);
  });
});
