import { describe, expect, it } from "vitest";

import {
  alertsNote, distance, distanceLabel, findDuplicate, health, KINDS, metaFor,
  validate, type Kind, type Op,
} from "./alertCheck";

const draft = (over: Partial<{ kind: Kind; op: Op; value: number; ticker: string }> = {}) =>
  ({ kind: "price" as Kind, op: "<" as Op, value: 1000, ticker: "RELIANCE.NS", ...over });

const texts = (ps: { text: string }[]) => ps.map((p) => p.text).join(" ");

describe("KINDS / metaFor", () => {
  it("knows which conditions need a ticker", () => {
    expect(metaFor("price").needsTicker).toBe(true);
    expect(metaFor("spread_10y2y").needsTicker).toBe(false);
  });

  it("says a volume spike is a MULTIPLE, not a percentage", () => {
    // The mistake this catches: typing 200 meaning "200% of average".
    expect(metaFor("volume_spike").hint).toMatch(/A MULTIPLE, not a percentage/);
    expect(metaFor("volume_spike").sane.max).toBeLessThan(50);
  });

  it("has a unique entry per kind", () => {
    const kinds = KINDS.map((k) => k.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("validate", () => {
  it("REFUSES an alert whose condition is already true", () => {
    // It would fire on the next evaluation and deactivate — consuming the
    // alert at the moment of creation, which reads as success.
    const ps = validate(draft({ op: "<", value: 2000 }), 1425.6);
    expect(ps.some((p) => p.severity === "error")).toBe(true);
    expect(texts(ps)).toMatch(/ALREADY true/);
    expect(texts(ps)).toMatch(/consumes the alert rather than watching/);
  });

  it("catches the already-true case in the other direction too", () => {
    expect(texts(validate(draft({ op: ">", value: 1000 }), 1425.6)))
      .toMatch(/ALREADY true/);
  });

  it("passes a threshold that is genuinely ahead of the price", () => {
    expect(validate(draft({ op: "<", value: 1200 }), 1425.6)
      .filter((p) => p.severity === "error")).toEqual([]);
    expect(validate(draft({ op: ">", value: 1600 }), 1425.6)
      .filter((p) => p.severity === "error")).toEqual([]);
  });

  it("warns about a threshold that no ordinary move will reach", () => {
    const ps = validate(draft({ op: "<", value: 10 }), 1425.6);
    expect(texts(ps)).toMatch(/99% away from the current/);
    expect(texts(ps)).toMatch(/check the number is the one you meant/);
  });

  it("flags a units mistake against the condition's sensible range", () => {
    // 200 meaning "200% of average volume" is 200x, which never happens.
    const ps = validate(draft({ kind: "volume_spike", op: ">", value: 200 }), 1.1);
    expect(texts(ps)).toMatch(/outside the sensible range/);
    expect(texts(ps)).toMatch(/A MULTIPLE, not a percentage/);
  });

  it("requires a ticker where the condition needs one", () => {
    expect(texts(validate(draft({ ticker: "  " }), null)))
      .toMatch(/needs a ticker/);
    // ...and does not demand one where it doesn't.
    expect(texts(validate(draft({ kind: "spread_10y2y", ticker: "" }), null)))
      .not.toMatch(/needs a ticker/);
  });

  it("requires a threshold at all", () => {
    for (const v of [null, NaN]) {
      expect(texts(validate({ ...draft(), value: v }, 1425)))
        .toMatch(/threshold value is required/);
    }
  });

  it("REFUSES to imply approval when it had nothing to check against", () => {
    // Absence of a warning must not read as a positive verdict.
    const ps = validate(draft({ value: 1200 }), null);
    expect(texts(ps)).toMatch(/can't be checked against the threshold/);
    expect(texts(ps)).toMatch(/arming it is a guess either way/);
  });

  it("mentions that a loss-making company has no P/E to evaluate", () => {
    expect(metaFor("pe").hint).toMatch(/loss-making company has no P\/E/);
  });
});

describe("distance", () => {
  it("measures the gap and the percentage move needed", () => {
    const d = distance("<", 1200, 1500)!;
    expect(d.gap).toBeCloseTo(300, 6);
    expect(d.pct).toBeCloseTo(-20, 6);
    expect(d.direction).toBe("down");
  });

  it("takes its direction from the operator, not the sign of the gap", () => {
    expect(distance(">", 1600, 1500)!.direction).toBe("up");
    expect(distance("<", 1400, 1500)!.direction).toBe("down");
  });

  it("returns a null percentage rather than dividing by zero", () => {
    expect(distance(">", 1, 0)!.pct).toBeNull();
  });

  it("uses the magnitude of the current value, so a negative base works", () => {
    // A 10Y-2Y spread of -0.5 heading to 0.5 is a move of 1 point.
    const d = distance(">", 0.5, -0.5)!;
    expect(d.gap).toBeCloseTo(1, 6);
    expect(d.pct).toBeCloseTo(200, 6);
  });

  it("has nothing to say without a current value", () => {
    expect(distance(">", 100, null)).toBeNull();
  });
});

describe("distanceLabel", () => {
  it("says where the value is and how far it has to move", () => {
    expect(distanceLabel("<", 1200, 1425.6, "price"))
      .toMatch(/1426 now — needs to move down 226 \(15\.8%\)/);
  });

  it("carries the condition's unit", () => {
    expect(distanceLabel(">", 3, 1.2, "volume_spike")).toMatch(/1\.20x/);
  });

  it("says so when there is no current value", () => {
    expect(distanceLabel("<", 100, null, "price")).toBe("no current value");
  });
});

describe("findDuplicate", () => {
  const existing = [
    { kind: "price", ticker: "RELIANCE.NS", op: "<", value: 1200, active: true },
    { kind: "pe", ticker: "TCS.NS", op: ">", value: 30, active: false },
  ];

  it("finds an identical alert the user already has", () => {
    // Easy to create: a fired alert sits in the list looking much like an
    // armed one, so the response to "it already fired" is to make another.
    expect(findDuplicate(existing, draft({ value: 1200 }))!.kind).toBe("price");
  });

  it("matches a fired duplicate too, which is the common case", () => {
    expect(findDuplicate(existing,
      { kind: "pe", ticker: "TCS.NS", op: ">", value: 30 })).not.toBeNull();
  });

  it("is case-insensitive on the ticker", () => {
    expect(findDuplicate(existing, draft({ ticker: "reliance.ns", value: 1200 })))
      .not.toBeNull();
  });

  it("does not match a different threshold, ticker or side", () => {
    expect(findDuplicate(existing, draft({ value: 1201 }))).toBeNull();
    expect(findDuplicate(existing, draft({ ticker: "INFY.NS", value: 1200 }))).toBeNull();
    expect(findDuplicate(existing, draft({ op: ">", value: 1200 }))).toBeNull();
  });

  it("treats a tickerless condition as having a null ticker", () => {
    const withSpread = [{ kind: "spread_10y2y", ticker: null, op: "<", value: 0, active: true }];
    expect(findDuplicate(withSpread,
      { kind: "spread_10y2y", ticker: "", op: "<", value: 0 })).not.toBeNull();
  });
});

describe("health / alertsNote", () => {
  const alerts = [{ active: true }, { active: true }, { active: false }];

  it("counts armed against fired", () => {
    expect(health(alerts)).toEqual({ armed: 2, fired: 1, total: 3 });
  });

  it("says an alert is a tripwire, not a standing monitor", () => {
    const note = alertsNote(health(alerts));
    expect(note).toMatch(/fires ONCE and then deactivates/);
    expect(note).toMatch(/a tripwire, not a standing monitor/);
  });

  it("says a move inside the evaluation window is never seen", () => {
    const note = alertsNote(health(alerts));
    expect(note).toMatch(/reverses inside that window is never seen/);
    expect(note).toMatch(/not necessarily one you could have traded at/);
  });

  it("explains the setup when there is nothing yet", () => {
    expect(alertsNote(health([]))).toMatch(/No alerts yet/);
  });
});
