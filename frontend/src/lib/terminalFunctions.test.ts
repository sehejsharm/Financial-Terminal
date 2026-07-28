import { describe, expect, it } from "vitest";

import { FN_CODES } from "./commands";
import {
  FN_LABELS, GROUP_ORDER, TERMINAL_FUNCTIONS, fnByCode, fnByLabel,
  functionsInRailOrder, groupedFunctions, isFnLabel, parseEntry, resolveFn,
  stepFn,
} from "./terminalFunctions";

describe("the registry itself", () => {
  it("has unique labels and unique codes", () => {
    const labels = TERMINAL_FUNCTIONS.map((f) => f.label);
    const codes = TERMINAL_FUNCTIONS.map((f) => f.code);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("uses uppercase mnemonics and non-empty hints", () => {
    for (const f of TERMINAL_FUNCTIONS) {
      expect(f.code, f.label).toBe(f.code.toUpperCase());
      expect(f.code.length, f.label).toBeGreaterThanOrEqual(2);
      expect(f.hint.length, f.label).toBeGreaterThan(10);
      expect(GROUP_ORDER, f.label).toContain(f.group);
    }
  });

  it("STAYS COMPATIBLE with the ⌘K command table", () => {
    // Both drive the same navigation; a code that means one thing in the
    // palette and another in the terminal would be a nasty little trap.
    for (const [code, label] of Object.entries(FN_CODES)) {
      const f = fnByCode(code);
      expect(f, `⌘K knows ${code} but the terminal doesn't`).toBeTruthy();
      expect(f!.label, `${code} disagrees between palette and terminal`).toBe(label);
    }
  });

  it("every grouped function appears exactly once in rail order", () => {
    const rail = functionsInRailOrder();
    expect(rail).toHaveLength(TERMINAL_FUNCTIONS.length);
    expect(new Set(rail.map((f) => f.label)).size).toBe(rail.length);
  });

  it("groups render in the declared order and none is empty", () => {
    const groups = groupedFunctions();
    expect(groups.map(([g]) => g)).toEqual(
      GROUP_ORDER.filter((g) => TERMINAL_FUNCTIONS.some((f) => f.group === g)));
    for (const [, list] of groups) expect(list.length).toBeGreaterThan(0);
  });
});

describe("lookup", () => {
  it("finds by label and by code, case-insensitively for codes", () => {
    expect(fnByLabel("Snapshot")!.code).toBe("DES");
    expect(fnByCode("des")!.label).toBe("Snapshot");
    expect(fnByCode("  fa  ")!.label).toBe("Financials");
    expect(fnByCode("nope")).toBeUndefined();
    expect(fnByLabel("Nope")).toBeUndefined();
  });

  it("isFnLabel gates what the URL is allowed to set", () => {
    expect(isFnLabel("Snapshot")).toBe(true);
    expect(isFnLabel("snapshot")).toBe(false);   // labels are exact
    expect(isFnLabel("<script>")).toBe(false);
    expect(FN_LABELS).toContain("Financials");
  });
});

describe("resolveFn", () => {
  it("accepts a full label or a mnemonic", () => {
    expect(resolveFn("Snapshot")).toBe("Snapshot");
    expect(resolveFn("DES")).toBe("Snapshot");
    expect(resolveFn("omon")).toBe("Options & Greeks");
  });

  it("returns null for junk so the caller keeps the current view", () => {
    for (const junk of [null, undefined, "", "  ", "NOTAFUNCTION", "../etc"]) {
      expect(resolveFn(junk as string), String(junk)).toBeNull();
    }
  });
});

describe("stepFn", () => {
  it("moves forward and back through rail order", () => {
    const rail = functionsInRailOrder().map((f) => f.label);
    expect(stepFn(rail[0], 1)).toBe(rail[1]);
    expect(stepFn(rail[1], -1)).toBe(rail[0]);
  });

  it("wraps at both ends rather than dead-ending", () => {
    const rail = functionsInRailOrder().map((f) => f.label);
    expect(stepFn(rail[rail.length - 1], 1)).toBe(rail[0]);
    expect(stepFn(rail[0], -1)).toBe(rail[rail.length - 1]);
  });

  it("recovers to the first function from an unknown current value", () => {
    const rail = functionsInRailOrder().map((f) => f.label);
    expect(stepFn("garbage", 1)).toBe(rail[0]);
  });

  it("visits every function exactly once in a full cycle", () => {
    const rail = functionsInRailOrder().map((f) => f.label);
    const seen: string[] = [];
    let cur = rail[0];
    for (let i = 0; i < rail.length; i++) { seen.push(cur); cur = stepFn(cur, 1); }
    expect(new Set(seen).size).toBe(rail.length);
    expect(cur).toBe(rail[0]);            // back to the start
  });
});

describe("parseEntry — the command line", () => {
  it("treats a plain symbol as navigation", () => {
    expect(parseEntry("RELIANCE.NS")).toEqual({ kind: "symbol", symbol: "RELIANCE.NS" });
    expect(parseEntry(" aapl ")).toEqual({ kind: "symbol", symbol: "AAPL" });
    expect(parseEntry("^NSEI")).toEqual({ kind: "symbol", symbol: "^NSEI" });
  });

  it("treats a bare mnemonic as a function jump on the current name", () => {
    expect(parseEntry("FA")).toEqual({ kind: "function", fn: "Financials" });
    expect(parseEntry("des")).toEqual({ kind: "function", fn: "Snapshot" });
  });

  it("handles TICKER + CODE together", () => {
    expect(parseEntry("TCS.NS FA"))
      .toEqual({ kind: "both", symbol: "TCS.NS", fn: "Financials" });
    expect(parseEntry("  aapl   omon  "))
      .toEqual({ kind: "both", symbol: "AAPL", fn: "Options & Greeks" });
  });

  it("falls back to the first token when the trailing word isn't a mnemonic", () => {
    expect(parseEntry("TCS.NS SOMETHING"))
      .toEqual({ kind: "symbol", symbol: "TCS.NS" });
  });

  it("reports empty input rather than navigating somewhere arbitrary", () => {
    expect(parseEntry("")).toEqual({ kind: "empty" });
    expect(parseEntry("    ")).toEqual({ kind: "empty" });
  });

  it("only reads a bare token as a function on an EXACT mnemonic match", () => {
    // "CSX" is a real ticker and must not be swallowed by the "CS" mnemonic.
    expect(parseEntry("CSX")).toEqual({ kind: "symbol", symbol: "CSX" });
    expect(parseEntry("CS")).toEqual({ kind: "function", fn: "Capital structure" });
  });
});
