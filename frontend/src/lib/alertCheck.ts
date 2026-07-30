/** Checking an alert before it is armed.
 *
 *  The alert form accepted any number for any condition and told you nothing.
 *  Two failures follow from that, and both are silent.
 *
 *  Set "Price < 100" on a stock trading at 1,425 and the alert is armed,
 *  looks identical to a good one, and will never fire. The user finds out by
 *  not being told about a move they cared about.
 *
 *  Set "Price < 2,000" on the same stock and the condition is ALREADY true, so
 *  it fires on the next evaluation and immediately deactivates — a
 *  single-shot alert consumed at the moment of creation, which reads as "it
 *  worked" and is the opposite of what was wanted.
 *
 *  Neither needs anything the page doesn't already have: the live quote is on
 *  screen. The rest of this module is the arithmetic for saying how far a
 *  threshold is from being hit, and the per-condition ranges that catch a
 *  volume-spike alert set to 18× when 1.8× was meant.
 */

export type Kind = "price" | "pe" | "move" | "volume_spike" | "spread_10y2y";
export type Op = ">" | "<";

export type KindMeta = {
  kind: Kind;
  label: string;
  unit: string;
  needsTicker: boolean;
  /** Values outside this are almost certainly a units mistake. */
  sane: { min: number; max: number };
  hint: string;
};

export const KINDS: readonly KindMeta[] = [
  { kind: "price", label: "Price", unit: "", needsTicker: true,
    sane: { min: 0, max: 1e7 },
    hint: "The last traded price, in the listing's own currency." },
  { kind: "pe", label: "Trailing P/E", unit: "x", needsTicker: true,
    sane: { min: 0, max: 500 },
    hint: "Trailing twelve-month P/E from the provider. A loss-making company "
      + "has no P/E, so an alert on one never evaluates." },
  { kind: "move", label: "Absolute day move", unit: "%", needsTicker: true,
    sane: { min: 0, max: 50 },
    hint: "The absolute size of the day's move, so it catches a fall as well "
      + "as a rise. 2–5% is an eventful day for a large cap." },
  { kind: "volume_spike", label: "Volume vs 30-day average", unit: "x",
    needsTicker: true, sane: { min: 0.1, max: 20 },
    hint: "A MULTIPLE, not a percentage: 2 means twice the 30-day average "
      + "volume. 1.5–3 is the useful range." },
  { kind: "spread_10y2y", label: "US 10Y–2Y spread", unit: "%",
    needsTicker: false, sane: { min: -5, max: 5 },
    hint: "In percentage points. Negative is an inverted curve." },
];

export function metaFor(kind: Kind): KindMeta {
  return KINDS.find((k) => k.kind === kind) ?? KINDS[0];
}

export type Problem = {
  severity: "error" | "warn" | "note";
  text: string;
};

/**
 * What is wrong with this alert, before it is armed.
 *
 * `current` is the live value of whatever the condition measures, or null when
 * the page hasn't got one — in which case the value-dependent checks are
 * skipped rather than guessed at. Absence of a warning must never be taken as
 * a positive verdict when there was nothing to check against.
 */
export function validate(draft: { kind: Kind; op: Op; value: number | null; ticker: string },
                         current: number | null): Problem[] {
  const meta = metaFor(draft.kind);
  const out: Problem[] = [];

  if (draft.value == null || !Number.isFinite(draft.value)) {
    out.push({ severity: "error", text: "A threshold value is required." });
    return out;
  }
  if (meta.needsTicker && !draft.ticker.trim()) {
    out.push({ severity: "error", text: "This condition needs a ticker." });
  }
  if (draft.value < meta.sane.min || draft.value > meta.sane.max) {
    out.push({
      severity: "warn",
      text: `${draft.value}${meta.unit} is outside the sensible range for `
        + `${meta.label.toLowerCase()} (${meta.sane.min}–${meta.sane.max}${meta.unit}). `
        + meta.hint,
    });
  }

  if (current == null || !Number.isFinite(current)) {
    out.push({
      severity: "note",
      text: "No current value is loaded for this condition, so it can't be "
        + "checked against the threshold. It may already be true, or may be "
        + "unreachable — arming it is a guess either way.",
    });
    return out;
  }

  const alreadyTrue = draft.op === ">" ? current > draft.value : current < draft.value;
  if (alreadyTrue) {
    out.push({
      severity: "error",
      text: `This is ALREADY true — the current value is ${fmt(current, meta)} `
        + `and you asked for ${draft.op} ${fmt(draft.value, meta)}. It will fire `
        + "on the next evaluation and deactivate, which consumes the alert "
        + "rather than watching for anything.",
    });
    return out;
  }

  const d = distance(draft.op, draft.value, current);
  if (d != null && d.pct != null && Math.abs(d.pct) > 90 && draft.kind === "price") {
    out.push({
      severity: "warn",
      text: `The threshold is ${Math.abs(d.pct).toFixed(0)}% away from the `
        + `current ${fmt(current, meta)}. That is reachable in principle and `
        + "will not fire on any ordinary move — check the number is the one "
        + "you meant.",
    });
  }
  return out;
}

function fmt(v: number, meta: KindMeta): string {
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  return `${n}${meta.unit}`;
}

export type Distance = {
  /** Absolute gap between the current value and the threshold. */
  gap: number;
  /** Gap as a percentage of the current value, where that means anything. */
  pct: number | null;
  /** Which way the value has to move. */
  direction: "up" | "down";
};

/** How far the current value is from tripping the condition. */
export function distance(op: Op, threshold: number,
                         current: number | null): Distance | null {
  if (current == null || !Number.isFinite(current)) return null;
  return {
    gap: Math.abs(threshold - current),
    // A percentage of zero is not a number, and a percentage of a spread that
    // can legitimately be negative is misleading rather than useful.
    pct: current !== 0 ? ((threshold - current) / Math.abs(current)) * 100 : null,
    direction: op === ">" ? "up" : "down",
  };
}

/** An armed alert's status line. */
export function distanceLabel(op: Op, threshold: number, current: number | null,
                              kind: Kind): string {
  const meta = metaFor(kind);
  const d = distance(op, threshold, current);
  if (!d || current == null) return "no current value";
  const pct = d.pct != null ? ` (${Math.abs(d.pct).toFixed(1)}%)` : "";
  return `${fmt(current, meta)} now — needs to move ${d.direction} `
    + `${fmt(d.gap, meta)}${pct}`;
}

/**
 * Is this the same alert the user already has?
 *
 * Duplicates are easy to create because a fired alert stays in the list
 * looking much like an armed one, so the natural response to "it already
 * fired" is to make another identical one.
 */
export function findDuplicate<T extends { kind: string; ticker: string | null; op: string; value: number }>(
    existing: T[], draft: { kind: Kind; ticker: string; op: Op; value: number }): T | null {
  const t = draft.ticker.trim().toUpperCase() || null;
  return existing.find((a) =>
    a.kind === draft.kind
    && (a.ticker ?? null) === t
    && a.op === draft.op
    && Math.abs(a.value - draft.value) < 1e-9) ?? null;
}

export type Health = {
  armed: number;
  fired: number;
  total: number;
};

export function health<T extends { active: boolean }>(alerts: T[]): Health {
  const armed = alerts.filter((a) => a.active).length;
  return { armed, fired: alerts.length - armed, total: alerts.length };
}

export function alertsNote(h: Health): string {
  if (!h.total) {
    return "No alerts yet. Conditions are checked server-side roughly every "
      + "minute against the same provider data the rest of the app uses.";
  }
  const parts = [
    `${h.armed} armed, ${h.fired} already fired.`,
  ];
  parts.push("An alert fires ONCE and then deactivates — it is a tripwire, not "
    + "a standing monitor, so a fired alert will not tell you about the next "
    + "move. Delete and recreate it to re-arm.");
  parts.push("Evaluation runs about once a minute against provider data, so a "
    + "move that reverses inside that window is never seen, and the price that "
    + "triggered an alert is not necessarily one you could have traded at. "
    + "Delivery to email or Telegram adds its own delay.");
  return parts.join(" ");
}
