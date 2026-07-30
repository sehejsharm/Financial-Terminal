/** What the option chain is saying.
 *
 *  OMON printed a grid of strikes with Greeks attached and a max-pain number.
 *  Everything a chain is actually consulted for was missing: how far the market
 *  thinks the stock moves by expiry, whether it is paying more to be protected
 *  than to participate, where the open interest is piled up, and whether any of
 *  these contracts can be traded at the prices displayed.
 *
 *  Those four questions are what an options screen is for, and all four are
 *  answerable from the rows already on the page.
 *
 *  Pure. Every threshold here is arguable, so it is visible and tested rather
 *  than buried in JSX.
 */

export type Row = Record<string, number | string | boolean | null>;

function num(r: Row, key: string): number | null {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Rows with a usable strike, nearest-first around `spot`. */
function byDistance(rows: Row[], spot: number): Row[] {
  return rows
    .filter((r) => num(r, "strike") != null)
    .sort((a, b) => Math.abs(num(a, "strike")! - spot) - Math.abs(num(b, "strike")! - spot));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Whether a contract is in the money.
 *
 * A call is in the money below the spot and a put ABOVE it. The old chain used
 * the call rule for both, so every put row was shaded exactly backwards — the
 * worthless ones highlighted and the valuable ones plain.
 */
export function isItm(strike: number | null, spot: number,
                     side: "calls" | "puts"): boolean {
  if (strike == null || !(spot > 0)) return false;
  return side === "calls" ? strike < spot : strike > spot;
}

/** Calendar days to expiry. Negative for a date already past. */
export function daysToExpiry(expiry: string, now: number): number | null {
  const t = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - now) / 86_400_000);
}

// ── what the market is pricing ────────────────────────────────────────────

export type ExpectedMove = {
  /** The straddle's cost as a percentage of spot. */
  pct: number | null;
  /** In currency terms. */
  amount: number | null;
  strike: number | null;
  upper: number | null;
  lower: number | null
  problem: string | null;
};

/** Mid price where both sides are quoted, falling back to the last trade.
 *  The mid is preferred because a last price can be hours stale on a strike
 *  nobody has touched, while a live quote is at least current. */
function priceOf(r: Row): number | null {
  const bid = num(r, "bid"), ask = num(r, "ask");
  if (bid != null && ask != null && ask > 0 && bid >= 0) return (bid + ask) / 2;
  return num(r, "lastPrice");
}

/**
 * The move the options market is pricing in by expiry.
 *
 * The at-the-money straddle is the cleanest read on a chain: buying the call
 * and the put at the same strike costs whatever the market thinks the stock
 * moves in either direction, so its price IS the expected move. A reader who
 * sees "±6.4% by 20 June" has learned more than the entire Greeks grid told
 * them.
 */
export function expectedMove(calls: Row[], puts: Row[], spot: number): ExpectedMove {
  const empty = {
    pct: null, amount: null, strike: null, upper: null, lower: null,
  };
  if (!(spot > 0)) {
    return { ...empty, problem: "No spot price to measure against." };
  }
  const c = byDistance(calls, spot)[0];
  const p = byDistance(puts, spot)[0];
  if (!c || !p) {
    return { ...empty, problem: "The chain is missing one side, so there is no straddle to price." };
  }
  const cs = num(c, "strike")!, ps = num(p, "strike")!;
  // The two nearest strikes must be the SAME strike. Pricing a call at 100
  // against a put at 120 is a strangle, and calling it a straddle overstates
  // the expected move by the width between them.
  if (cs !== ps) {
    return { ...empty, problem: "The nearest call and put sit at different strikes, so there is no clean at-the-money straddle." };
  }
  const cp = priceOf(c), pp = priceOf(p);
  if (cp == null || pp == null || cp <= 0 || pp <= 0) {
    return { ...empty, problem: "The at-the-money contracts are not quoted, so the expected move can't be read off them." };
  }
  const amount = cp + pp;
  return {
    pct: (amount / spot) * 100,
    amount, strike: cs,
    upper: cs + amount,
    lower: cs - amount,
    problem: null,
  };
}

// ── skew ──────────────────────────────────────────────────────────────────

export type Skew = {
  /** Out-of-the-money put IV minus out-of-the-money call IV, in IV points. */
  points: number | null;
  putIv: number | null;
  callIv: number | null;
  atmIv: number | null;
  read: string;
};

/** IV as a percentage. Providers send a decimal (0.35); a value above 3 is
 *  already in percent and doubling it would be a 3,500% volatility. */
function ivPct(r: Row): number | null {
  const v = num(r, "impliedVolatility");
  if (v == null || v <= 0) return null;
  return v <= 3 ? v * 100 : v;
}

/** The contract closest to `target` percent away from spot on the given side. */
function otmAt(rows: Row[], spot: number, awayPct: number,
               side: "calls" | "puts"): Row | null {
  const want = side === "calls" ? spot * (1 + awayPct / 100) : spot * (1 - awayPct / 100);
  const eligible = rows.filter((r) => {
    const k = num(r, "strike");
    if (k == null || ivPct(r) == null) return false;
    return side === "calls" ? k > spot : k < spot;
  });
  if (!eligible.length) return null;
  return eligible.reduce((best, r) =>
    Math.abs(num(r, "strike")! - want) < Math.abs(num(best, "strike")! - want) ? r : best);
}

/**
 * How much more the market charges for downside protection than for upside.
 *
 * Equity chains are almost always put-skewed — crashes are faster than rallies
 * and everyone is structurally long — so the interesting reading is not the
 * sign but the size, and a chain skewed the OTHER way is a genuine signal
 * (usually a takeover rumour or a squeeze).
 */
export function ivSkew(calls: Row[], puts: Row[], spot: number,
                       awayPct = 10): Skew {
  const atmRow = byDistance(calls.filter((r) => ivPct(r) != null), spot)[0];
  const atmIv = atmRow ? ivPct(atmRow) : null;
  const putRow = otmAt(puts, spot, awayPct, "puts");
  const callRow = otmAt(calls, spot, awayPct, "calls");
  const putIv = putRow ? ivPct(putRow) : null;
  const callIv = callRow ? ivPct(callRow) : null;

  if (putIv == null || callIv == null) {
    return {
      points: null, putIv, callIv, atmIv,
      read: "Not enough quoted implied volatilities away from the money to "
        + "measure the skew. Free option feeds thin out fast on the wings.",
    };
  }
  const points = putIv - callIv;
  if (points > 8) {
    return { points, putIv, callIv, atmIv,
      read: `Downside protection costs ${points.toFixed(1)} volatility points `
        + `more than the equivalent upside (${putIv.toFixed(1)}% vs `
        + `${callIv.toFixed(1)}%). That is a steep skew: the market is paying up `
        + "for a fall, which is normal for equities but this much of it usually "
        + "means an event is expected." };
  }
  if (points > 2) {
    return { points, putIv, callIv, atmIv,
      read: `Puts are ${points.toFixed(1)} volatility points more expensive than `
        + "calls the same distance away — the ordinary equity skew, and not "
        + "information on its own." };
  }
  if (points < -2) {
    return { points, putIv, callIv, atmIv,
      read: `Calls are ${(-points).toFixed(1)} points MORE expensive than puts, `
        + "which is the wrong way round for an equity. A call-skewed chain "
        + "usually means the market is pricing a bid, a squeeze or a binary "
        + "upside event." };
  }
  return { points, putIv, callIv, atmIv,
    read: `The wings are priced within ${Math.abs(points).toFixed(1)} points of `
      + "each other — an unusually flat skew, which tends to mean the chain is "
      + "thin rather than that risk is symmetric." };
}

// ── where the open interest sits ──────────────────────────────────────────

export type OiProfile = {
  callOi: number;
  putOi: number;
  /** Put OI over call OI. */
  putCallRatio: number | null;
  /** The strike with the most call open interest above spot. */
  callWall: number | null;
  callWallOi: number;
  /** The strike with the most put open interest below spot. */
  putWall: number | null;
  putWallOi: number;
  read: string;
};

/**
 * The strikes with the most contracts outstanding.
 *
 * These matter because dealers hedge them: a large call position overhead gets
 * sold into as price approaches, and a large put position beneath gets bought.
 * It is not a prediction, and the honest framing is that it identifies where
 * flow concentrates, not where price goes.
 */
export function oiProfile(calls: Row[], puts: Row[], spot: number): OiProfile {
  const sum = (rows: Row[]) =>
    rows.reduce((a, r) => a + (num(r, "openInterest") ?? 0), 0);
  const callOi = sum(calls), putOi = sum(puts);

  const peak = (rows: Row[], side: "above" | "below") => {
    let strike: number | null = null, oi = 0;
    for (const r of rows) {
      const k = num(r, "strike"), o = num(r, "openInterest");
      if (k == null || o == null || o <= 0) continue;
      if (side === "above" ? k <= spot : k >= spot) continue;
      if (o > oi) { oi = o; strike = k; }
    }
    return { strike, oi };
  };
  const cw = peak(calls, "above");
  const pw = peak(puts, "below");
  const ratio = callOi > 0 ? putOi / callOi : null;

  const parts: string[] = [];
  if (cw.strike != null && pw.strike != null) {
    parts.push(`The heaviest open interest sits at ${pw.strike} on the put side `
      + `and ${cw.strike} on the call side, which brackets the spot. Dealers `
      + "hedge those positions, so flow tends to concentrate there — that is a "
      + "statement about where trading happens, not about where price goes.");
  } else if (cw.strike != null || pw.strike != null) {
    parts.push("Open interest is concentrated on one side of the spot only, so "
      + "there is no bracket to read.");
  } else {
    parts.push("No meaningful open interest on either side of the spot.");
  }
  if (ratio != null) {
    parts.push(ratio > 1.3
      ? `Put open interest runs ${ratio.toFixed(2)}x calls. That is often read as `
        + "bearish positioning, but a put can as easily be someone hedging a "
        + "long as someone betting on a fall — open interest does not say which "
        + "side initiated it."
      : ratio < 0.7
        ? `Call open interest exceeds puts (${ratio.toFixed(2)}x). Read with the `
          + "same caution: a written call is a covered position, not a bullish bet."
        : `Put and call open interest are roughly balanced (${ratio.toFixed(2)}x).`);
  }
  return {
    callOi, putOi, putCallRatio: ratio,
    callWall: cw.strike, callWallOi: cw.oi,
    putWall: pw.strike, putWallOi: pw.oi,
    read: parts.join(" "),
  };
}

// ── can you actually trade it ─────────────────────────────────────────────

export type Tradability = {
  /** Median bid-ask spread as a percentage of the mid. */
  medianSpreadPct: number | null;
  /** Share of contracts that didn't trade at all, 0–100. */
  untradedPct: number | null;
  quoted: number;
  total: number;
  verdict: "tradable" | "wide" | "illiquid" | "unknown";
  read: string;
};

/**
 * Whether the prices on screen are prices anyone would fill at.
 *
 * The Greeks grid implies a precision the market does not offer. On a chain
 * where the median spread is 20% of the mid, the theoretical value of a
 * contract is beside the point — the round trip costs more than most of the
 * edge being modelled. This says so before the reader builds a position.
 */
export function tradability(rows: Row[]): Tradability {
  const total = rows.length;
  const spreads: number[] = [];
  let untraded = 0, quoted = 0;
  for (const r of rows) {
    const bid = num(r, "bid"), ask = num(r, "ask");
    const vol = num(r, "volume");
    if (vol == null || vol === 0) untraded++;
    if (bid != null && ask != null && ask > 0 && bid > 0 && ask >= bid) {
      quoted++;
      spreads.push(((ask - bid) / ((ask + bid) / 2)) * 100);
    }
  }
  const med = median(spreads);
  if (!total) {
    return { medianSpreadPct: null, untradedPct: null, quoted: 0, total: 0,
      verdict: "unknown", read: "No contracts to assess." };
  }
  const untradedPct = (untraded / total) * 100;
  if (med == null) {
    return { medianSpreadPct: null, untradedPct, quoted, total, verdict: "unknown",
      read: `None of the ${total} contracts carries a two-sided quote, so there `
        + "is no way to tell what any of this would cost to trade. Treat every "
        + "price on the grid as indicative." };
  }
  const verdict = med <= 5 ? "tradable" : med <= 20 ? "wide" : "illiquid";
  const reads = {
    tradable: `The median bid-ask spread is ${med.toFixed(1)}% of the mid, which `
      + "is tight enough that the quoted prices are roughly what you would pay.",
    wide: `The median bid-ask spread is ${med.toFixed(1)}% of the mid. A round `
      + "trip costs more than that in total, which is larger than most of the "
      + "edge a Greeks model would identify.",
    illiquid: `The median bid-ask spread is ${med.toFixed(0)}% of the mid. At `
      + "that width the theoretical value of a contract is beside the point — "
      + "the spread is the trade.",
  } as const;
  return {
    medianSpreadPct: med, untradedPct, quoted, total, verdict,
    read: `${reads[verdict]} ${untradedPct.toFixed(0)}% of contracts did not `
      + "trade at all today; a last price on one of those is history, not a "
      + "quote.",
  };
}

/** The plain-language caveat for the chain as a whole. */
export function chainNote(dte: number | null, t: Tradability): string {
  const parts: string[] = [];
  if (dte != null) {
    parts.push(dte <= 0
      ? "This expiry is today or already past, so the Greeks are degenerate and "
        + "every number on the grid should be ignored."
      : dte <= 7
        ? `${dte} days to expiry. Gamma and theta both dominate this close in, so `
          + "delta moves faster than the grid suggests and the day's decay is a "
          + "material share of the premium."
        : `${dte} days to expiry.`);
  }
  parts.push("Greeks are Black–Scholes on the provider's implied volatility, "
    + "which assumes European exercise, no dividends and constant volatility — "
    + "none of which hold for a listed equity option. They are the right order "
    + "of magnitude and not the exact sensitivity.");
  if (t.verdict === "wide" || t.verdict === "illiquid") {
    parts.push("Given the spreads above, treat any modelled edge smaller than "
      + "the spread as non-existent.");
  }
  return parts.join(" ");
}
