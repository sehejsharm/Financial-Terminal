/** Reading a cross-asset board.
 *
 *  The Global page renders forty-odd tiles tinted by the size of the day's
 *  move. That is a good display and it answers nothing on its own: the reader
 *  still has to scan every tile to work out whether this is a broad risk-off
 *  day or two indices doing something while everything else sits still.
 *
 *  Worse, the page had no idea how much of itself was actually working. Free
 *  providers rate-limit and get blocked from cloud hosts, so tiles legitimately
 *  render unpriced — and a board where half the tiles never priced looks
 *  remarkably like a calm market. The footnote mentioned it; nothing counted it.
 *
 *  Two honest additions, then: breadth (how many up, how many down, how many
 *  unknown) and a risk tone that is stated as a description of today's tape
 *  rather than a signal, with the reasons it can be wrong attached.
 */

export type Tile = {
  sym: string;
  /** Day change in percent, or null when the tile never priced. */
  changePct: number | null;
};

export type Group = { title: string; tiles: Tile[] };

export type Breadth = {
  up: number;
  down: number;
  flat: number;
  unpriced: number;
  total: number;
  /** Share of tiles that priced at all, 0–100. */
  coveragePct: number | null;
  /** Advancing as a share of PRICED tiles, 0–100. */
  advancePct: number | null;
  /** Mean move across priced tiles, in percent. */
  averagePct: number | null;
};

/** Moves smaller than this are not a direction, they are the spread. */
export const FLAT_PCT = 0.1;

export function breadth(tiles: Tile[]): Breadth {
  let up = 0, down = 0, flat = 0, unpriced = 0, sum = 0;
  for (const t of tiles) {
    if (t.changePct == null || !Number.isFinite(t.changePct)) { unpriced++; continue; }
    sum += t.changePct;
    if (t.changePct > FLAT_PCT) up++;
    else if (t.changePct < -FLAT_PCT) down++;
    else flat++;
  }
  const priced = up + down + flat;
  return {
    up, down, flat, unpriced, total: tiles.length,
    coveragePct: tiles.length ? (priced / tiles.length) * 100 : null,
    // Against PRICED tiles, not the total: an advance share diluted by tiles
    // that never loaded is a statement about the data feed.
    advancePct: priced ? (up / priced) * 100 : null,
    averagePct: priced ? sum / priced : null,
  };
}

export function groupBreadth(groups: Group[]): { title: string; breadth: Breadth }[] {
  return groups.map((g) => ({ title: g.title, breadth: breadth(g.tiles) }));
}

export type Tone = "risk-on" | "risk-off" | "mixed" | "unknown";

export type RiskRead = {
  tone: Tone;
  equityAvgPct: number | null;
  volAvgPct: number | null;
  read: string;
};

/**
 * Whether the tape looks risk-on or risk-off.
 *
 * Equities and volatility, which is the only pairing on this board that says
 * anything reliable: equities up with volatility down is the textbook risk-on
 * tape, and the reverse is risk-off. Commodities are deliberately left out —
 * oil rising is risk-on in a demand story and risk-off in a supply shock, and
 * a board cannot tell which.
 *
 * The verdict is a description of today, explicitly not a signal, and it is
 * withheld entirely when coverage is too thin to support it.
 */
export const MIN_COVERAGE_PCT = 60;

export function riskTone(equities: Tile[], vol: Tile[]): RiskRead {
  const eq = breadth(equities);
  const vx = breadth(vol);

  if (eq.coveragePct == null || eq.coveragePct < MIN_COVERAGE_PCT
      || eq.averagePct == null) {
    return {
      tone: "unknown", equityAvgPct: eq.averagePct, volAvgPct: vx.averagePct,
      read: `Only ${eq.coveragePct == null ? 0 : eq.coveragePct.toFixed(0)}% of the `
        + "equity tiles priced, which is too little to characterise the tape. "
        + "A board with most of its tiles unpriced looks very like a calm "
        + "market, and this is the difference.",
    };
  }

  const e = eq.averagePct;
  const v = vx.averagePct;
  const eqUp = e > 0.15, eqDown = e < -0.15;
  const volUp = v != null && v > 1, volDown = v != null && v < -1;

  if (eqUp && !volUp) {
    return { tone: "risk-on", equityAvgPct: e, volAvgPct: v,
      read: `Equity indices average ${e >= 0 ? "+" : ""}${e.toFixed(2)}%`
        + (v != null ? ` with volatility ${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "")
        + " — the ordinary risk-on shape. It describes today's tape and "
        + "forecasts nothing." };
  }
  if (eqDown && !volDown) {
    return { tone: "risk-off", equityAvgPct: e, volAvgPct: v,
      read: `Equity indices average ${e.toFixed(2)}%`
        + (v != null ? ` with volatility ${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "")
        + " — a risk-off tape. Correlations rise on days like this, so the "
        + "diversification implied by holding several of these is smaller than "
        + "it looks." };
  }
  return { tone: "mixed", equityAvgPct: e, volAvgPct: v,
    read: `Equities average ${e >= 0 ? "+" : ""}${e.toFixed(2)}%`
      + (v != null ? ` and volatility ${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "")
      + " — the two are not pointing the same way, so there is no clean "
      + "risk-on or risk-off read. That is common and unremarkable." };
}

export function boardNote(all: Breadth, risk: RiskRead): string {
  const parts: string[] = [];

  if (all.coveragePct != null && all.coveragePct < 100) {
    parts.push(`${all.total - all.unpriced} of ${all.total} tiles priced`
      + (all.unpriced
        ? `; ${all.unpriced} never loaded. Free providers rate-limit and are `
          + "sometimes blocked from cloud hosts, and a board with unpriced "
          + "tiles looks very like a quiet one — which is why the count is "
          + "here rather than in a footnote."
        : "."));
  }
  if (all.advancePct != null) {
    parts.push(`${all.up} advancing, ${all.down} declining, ${all.flat} flat `
      + `(${all.advancePct.toFixed(0)}% of PRICED tiles up — measured against `
      + "what priced, because a share diluted by tiles that never loaded is a "
      + "statement about the feed).");
  }
  parts.push(risk.read);
  parts.push("Commodities are excluded from the risk read on purpose: oil "
    + "rising is risk-on in a demand story and risk-off in a supply shock, and "
    + "nothing on this board can tell those apart. Moves are also measured "
    + "against each venue's own previous close, so markets in different "
    + "sessions are not measuring the same period.");
  return parts.join(" ");
}
