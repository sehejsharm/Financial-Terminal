/** Smoothing for the header connectivity badge.
 *
 *  The badge rendered the socket's state directly, and the socket legitimately
 *  churns during ordinary navigation: a route change tears down subscriptions
 *  and opens new ones, so the underlying state can go live → connecting →
 *  reconnecting → live inside a second. Every one of those was painted. The
 *  result read as an unstable connection at exactly the moment nothing was
 *  wrong, which is worse than showing nothing — a user who learns the badge
 *  cries wolf stops reading it when it matters.
 *
 *  Two rules fix it, and they are deliberately asymmetric.
 *
 *  A DEGRADED state has to persist before it is shown. A reconnect that
 *  resolves in 300ms was never worth reporting, so RECONNECTING waits — the
 *  badge only claims trouble once there has actually been trouble for a while.
 *
 *  RECOVERY is shown quickly. Making a user wait to learn they are back online
 *  is the one direction where lag is not conservative, it is just wrong.
 *
 *  On top of both, nothing is repainted more often than MIN_DWELL_MS, so the
 *  badge cannot strobe even if the socket does.
 */

export type StreamStatus =
  | "idle" | "connecting" | "live" | "reconnecting" | "stale" | "closed";

/**
 * How long a state must hold before the badge will show it.
 *
 * The reconnect delay is the important one: it has to outlast an ordinary
 * route change, which is where the flapping was coming from.
 */
export const SHOW_DELAY_MS: Record<StreamStatus, number> = {
  live: 250,
  closed: 1000,
  idle: 1000,
  connecting: 2500,
  reconnecting: 2500,
  // A feed can be quiet for a few seconds in thin trading without being
  // broken, so STALE is the slowest claim of all to make.
  stale: 4000,
};

/** Floor on how often the badge may change at all. */
export const MIN_DWELL_MS = 1200;

export type BadgeState = {
  /** What the badge is displaying. */
  shown: StreamStatus;
  shownSince: number;
  /** What the socket is currently reporting, once it stopped changing. */
  candidate: StreamStatus;
  candidateSince: number;
};

export function initBadge(status: StreamStatus, now: number): BadgeState {
  return { shown: status, shownSince: now, candidate: status, candidateSince: now };
}

/**
 * Advance the badge one tick.
 *
 * Pure and clock-injected so the timing rules can be tested without waiting
 * in real time — the whole point of this module is behaviour over seconds,
 * which is untestable if it reads the clock itself.
 */
export function stepBadge(prev: BadgeState, incoming: StreamStatus,
                          now: number): BadgeState {
  // The socket changed its mind: restart the clock on the new candidate.
  const candidateChanged = incoming !== prev.candidate;
  const candidateSince = candidateChanged ? now : prev.candidateSince;
  const next: BadgeState = { ...prev, candidate: incoming, candidateSince };

  // Already showing it — nothing to promote, and the dwell clock keeps running
  // so a flap away and back does not count as two changes.
  if (incoming === prev.shown) return next;

  const held = now - candidateSince;
  const dwelled = now - prev.shownSince;
  if (held >= SHOW_DELAY_MS[incoming] && dwelled >= MIN_DWELL_MS) {
    return { shown: incoming, shownSince: now, candidate: incoming, candidateSince };
  }
  return next;
}

/**
 * Milliseconds until this state could change on its own, or null if it cannot.
 *
 * Lets a caller schedule one timer instead of polling — without it, a status
 * that stops updating would leave the badge stuck on the old value forever,
 * because `stepBadge` only runs when something calls it.
 */
export function msUntilChange(state: BadgeState, now: number): number | null {
  if (state.candidate === state.shown) return null;
  const waitForHold = SHOW_DELAY_MS[state.candidate] - (now - state.candidateSince);
  const waitForDwell = MIN_DWELL_MS - (now - state.shownSince);
  return Math.max(0, waitForHold, waitForDwell);
}
