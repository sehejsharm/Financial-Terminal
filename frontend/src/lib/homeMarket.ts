/** Which market the reader is sitting in.
 *
 *  "Gainers and losers" is only meaningful relative to a market, and the
 *  dashboard served NIFTY to everyone. A reader in New York opening it at 9am
 *  local was shown an Indian session that had closed hours earlier — the
 *  numbers were correct and answered a question they hadn't asked.
 *
 *  The browser already knows where it is: IANA gives a timezone, and a
 *  timezone maps to an exchange far more reliably than an IP does. That is a
 *  DEFAULT, not a decision — the picker is right there, and the choice is
 *  remembered, because a reader in Dubai following Indian markets should not
 *  have to re-pick every morning.
 */

export type MarketKey = "IN" | "US" | "GB" | "EU" | "AS";

export type Market = {
  key: MarketKey;
  label: string;
  /** What the movers are ranked within — stated, because "top gainer out of
   *  thirty" and "top gainer out of two thousand" are different claims. */
  index: string;
  currency: string;
  /** IANA zone used for the session clock. */
  tz: string;
};

export const MARKETS: readonly Market[] = [
  { key: "IN", label: "India", index: "NIFTY 50", currency: "INR", tz: "Asia/Kolkata" },
  { key: "US", label: "United States", index: "Dow 30", currency: "USD", tz: "America/New_York" },
  { key: "GB", label: "United Kingdom", index: "FTSE large caps", currency: "GBP", tz: "Europe/London" },
  { key: "EU", label: "Euro area", index: "Euro large caps", currency: "EUR", tz: "Europe/Paris" },
  { key: "AS", label: "Asia-Pacific", index: "Japan & HK large caps", currency: "JPY", tz: "Asia/Tokyo" },
];

export function marketFor(key: string | null | undefined): Market {
  return MARKETS.find((m) => m.key === key) ?? MARKETS[0];
}

/**
 * Timezone → market.
 *
 * Prefix-matched on the IANA region and then on specific zones, because there
 * are several hundred zone names and enumerating them would rot. Anything
 * unrecognised falls to India, which is this terminal's home market — a
 * default has to be something, and silently picking the US for a reader in
 * São Paulo is no better than picking India.
 */
const ZONE_RULES: ReadonlyArray<{ market: MarketKey; test: RegExp }> = [
  { market: "IN", test: /^Asia\/(Kolkata|Calcutta|Colombo|Kathmandu|Dhaka|Karachi)/ },
  { market: "AS", test: /^(Asia|Australia|Pacific\/Auckland)/ },
  { market: "GB", test: /^(Europe\/(London|Dublin|Belfast|Isle_of_Man)|GB)/ },
  { market: "EU", test: /^(Europe|Atlantic\/(Canary|Madeira)|CET|EET)/ },
  { market: "US", test: /^(America|US\/|Canada\/|Mexico\/)/ },
];

export function marketFromTimezone(tz: string | null | undefined): MarketKey {
  if (!tz) return "IN";
  for (const r of ZONE_RULES) if (r.test.test(tz)) return r.market;
  return "IN";
}

/** The browser's own zone, or null where it can't be read. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const KEY = "mb_home_market";

/**
 * The market to show: the reader's saved choice, else their timezone's.
 *
 * A saved choice always wins. Someone in Dubai who picked India means it, and
 * re-deriving from the timezone on every load would quietly overrule them.
 */
export function resolveMarket(saved: string | null,
                              tz: string | null): MarketKey {
  if (saved && MARKETS.some((m) => m.key === saved)) return saved as MarketKey;
  return marketFromTimezone(tz);
}

export function loadMarket(): MarketKey {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Private browsing or storage disabled — fall through to the timezone.
  }
  return resolveMarket(saved, browserTimezone());
}

export function saveMarket(key: MarketKey): void {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    // Losing the preference is survivable; taking the dashboard down is not.
  }
}

// ── is it open ────────────────────────────────────────────────────────────

/** Regular cash-session hours, local to the venue, in minutes from midnight. */
const SESSION: Record<MarketKey, { open: number; close: number }> = {
  IN: { open: 9 * 60 + 15, close: 15 * 60 + 30 },
  US: { open: 9 * 60 + 30, close: 16 * 60 },
  GB: { open: 8 * 60, close: 16 * 60 + 30 },
  EU: { open: 9 * 60, close: 17 * 60 + 30 },
  AS: { open: 9 * 60, close: 15 * 60 },
};

export type SessionState = {
  open: boolean;
  /** Local time at the venue, HH:MM. */
  localTime: string;
  read: string;
};

/**
 * Whether the market is trading, in ITS time.
 *
 * Matters more than it looks: a mover list from a closed market is a record of
 * a finished session, and it reads identically to a live one. Weekends are
 * handled; public holidays are NOT, and the note says so rather than asserting
 * a market is open on Diwali.
 */
export function sessionState(market: Market, now: Date): SessionState {
  let hh = 0, mm = 0, weekday = "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: market.tz, hour: "2-digit", minute: "2-digit",
      weekday: "short", hour12: false,
    }).formatToParts(now);
    for (const p of parts) {
      if (p.type === "hour") hh = Number(p.value);
      if (p.type === "minute") mm = Number(p.value);
      if (p.type === "weekday") weekday = p.value;
    }
  } catch {
    return { open: false, localTime: "—",
      read: "Could not read the venue's local time in this browser." };
  }

  const localTime = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const weekend = weekday === "Sat" || weekday === "Sun";
  const mins = hh * 60 + mm;
  const s = SESSION[market.key];
  const open = !weekend && mins >= s.open && mins < s.close;

  return {
    open,
    localTime,
    read: open
      ? `${market.label} is open — ${localTime} local.`
      : weekend
        ? `${market.label} is closed for the weekend. These are the last `
          + "session's moves, not today's."
        : `${market.label} is closed — ${localTime} local. These are the last `
          + "session's moves, not live ones.",
  };
}

/** The caveat every mover list needs. */
export function moversNote(market: Market, universe: number,
                           session: SessionState): string {
  return `${session.read} Ranked within ${universe} ${market.index} `
    + "constituents, not the whole exchange — a whole-market list is dominated "
    + "by micro-caps moving 20% on almost no volume, which is noise wearing "
    + "the costume of a signal. Session hours ignore public holidays, so a "
    + "market can read “open” on a holiday.";
}
