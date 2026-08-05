import { describe, expect, it } from "vitest";

import {
  initBadge, MIN_DWELL_MS, msUntilChange, SHOW_DELAY_MS, stepBadge,
  type BadgeState, type StreamStatus,
} from "./streamBadge";

/** Drive the reducer through a scripted timeline: [ms, status] pairs. */
function play(start: StreamStatus, steps: [number, StreamStatus][]): BadgeState {
  let t = 0;
  let s = initBadge(start, t);
  for (const [dt, status] of steps) { t += dt; s = stepBadge(s, status, t); }
  return s;
}

describe("flap suppression", () => {
  it("does NOT show RECONNECTING for a blip during navigation", () => {
    // The reported bug: a route change tears down and reopens the socket, and
    // every intermediate state was painted.
    const s = play("live", [
      [100, "reconnecting"], [150, "connecting"], [200, "live"],
    ]);
    expect(s.shown).toBe("live");
  });

  it("DOES show RECONNECTING once the socket is genuinely down", () => {
    const s = play("live", [
      [100, "reconnecting"], [3000, "reconnecting"],
    ]);
    expect(s.shown).toBe("reconnecting");
  });

  it("makes trouble slower to claim than recovery", () => {
    // Asymmetry is the point: waiting to report an outage is conservative,
    // waiting to report recovery is just wrong.
    expect(SHOW_DELAY_MS.reconnecting).toBeGreaterThan(SHOW_DELAY_MS.live);
    expect(SHOW_DELAY_MS.stale).toBeGreaterThan(SHOW_DELAY_MS.reconnecting);
  });

  it("shows recovery within the dwell floor, not the outage delay", () => {
    // Recovery is bounded by MIN_DWELL (1.2s), not by the 2.5s it takes to
    // admit an outage. A user must never wait the long delay to learn they
    // are back.
    const down = play("live", [[100, "reconnecting"], [3000, "reconnecting"]]);
    expect(down.shown).toBe("reconnecting");
    let up = stepBadge(down, "live", 3200);           // socket recovers
    expect(up.shown).toBe("reconnecting");            // not yet held
    up = stepBadge(up, "live", 3100 + MIN_DWELL_MS);  // timer fires
    expect(up.shown).toBe("live");
  });

  it("restarts the clock when the socket changes its mind", () => {
    // 2s reconnecting then 2s connecting is not 4s of either, so neither is
    // shown — the delay is per-state, not cumulative.
    const s = play("live", [[2000, "reconnecting"], [2000, "connecting"]]);
    expect(s.shown).toBe("live");
  });

  it("survives a long alternating flap without ever repainting", () => {
    const steps: [number, StreamStatus][] = [];
    for (let i = 0; i < 40; i++) steps.push([200, i % 2 ? "reconnecting" : "live"]);
    expect(play("live", steps).shown).toBe("live");
  });
});

describe("dwell floor", () => {
  it("will not repaint faster than the dwell floor", () => {
    // Arrival sets the candidate; a later call promotes it once the delay has
    // elapsed. That two-step is how the hook drives it (state change, then a
    // scheduled timer), so the test drives it the same way.
    let s = initBadge("live", 0);
    s = stepBadge(s, "reconnecting", 1000);            // candidate starts
    s = stepBadge(s, "reconnecting", 1000 + SHOW_DELAY_MS.reconnecting);
    expect(s.shown).toBe("reconnecting");              // shown at t=3500

    s = stepBadge(s, "live", 3600);                    // socket recovers
    s = stepBadge(s, "live", 3600 + SHOW_DELAY_MS.live);
    expect(s.shown).toBe("reconnecting");              // dwell floor blocks it

    s = stepBadge(s, "live", 3500 + MIN_DWELL_MS);
    expect(s.shown).toBe("live");
  });

  it("keeps the dwell clock running through a flap away and back", () => {
    let s = initBadge("live", 0);
    s = stepBadge(s, "reconnecting", 100);
    s = stepBadge(s, "live", 200);
    expect(s.shown).toBe("live");
    expect(s.shownSince).toBe(0);
  });
});

describe("steady states", () => {
  it("settles on CLOSED when the market is shut", () => {
    expect(play("live", [[100, "closed"], [2000, "closed"]]).shown).toBe("closed");
  });

  it("holds STALE off until the feed has really gone quiet", () => {
    expect(play("live", [[100, "stale"], [2000, "stale"]]).shown).toBe("live");
    expect(play("live", [[100, "stale"], [5000, "stale"]]).shown).toBe("stale");
  });
});

describe("msUntilChange", () => {
  it("is null when the badge already matches the socket", () => {
    expect(msUntilChange(initBadge("live", 0), 0)).toBeNull();
  });

  it("reports the wait, so a caller can schedule one timer", () => {
    // Without this a status that stops updating leaves the badge stuck,
    // because the reducer only runs when something calls it.
    const s = stepBadge(initBadge("live", 0), "reconnecting", 0);
    expect(msUntilChange(s, 0)).toBe(SHOW_DELAY_MS.reconnecting);
    expect(msUntilChange(s, 1000)).toBe(SHOW_DELAY_MS.reconnecting - 1000);
  });

  it("never reports a negative wait", () => {
    const s = stepBadge(initBadge("live", 0), "reconnecting", 0);
    expect(msUntilChange(s, 99_999)).toBe(0);
  });
});
