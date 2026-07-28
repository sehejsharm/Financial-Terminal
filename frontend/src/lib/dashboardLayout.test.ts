import { describe, expect, it } from "vitest";

import {
  addBoardSection, addCustomSection, addPresetSection, addSymbol, allSymbols,
  availablePresets, defaultLayout, LAYOUT_VERSION, MAX_SECTIONS,
  MAX_SYMBOLS_PER_SECTION, moveSection, moveSymbol, newSectionId, normalize,
  removeSection, removeSymbol, renameSection, toggleCollapsed,
  type Layout,
} from "./dashboardLayout";
import { REGIONS, SECTION_PRESETS } from "./instruments";

const base = () => defaultLayout("IN");

describe("defaultLayout", () => {
  it("builds a board for every declared region", () => {
    for (const r of REGIONS) {
      const l = defaultLayout(r.id);
      expect(l.regionId, r.id).toBe(r.id);
      expect(l.sections.length, r.id).toBeGreaterThan(2);
      expect(l.version).toBe(LAYOUT_VERSION);
    }
  });

  it("puts the market tiles first and gainers/losers + watchlists BELOW them", () => {
    // This is the requested ordering: you scroll down to reach the lists.
    const l = base();
    const kinds = l.sections.map((s) => s.kind);
    const firstNonTile = kinds.findIndex((k) => k !== "tiles");
    expect(firstNonTile).toBeGreaterThan(0);
    expect(kinds.slice(firstNonTile)).toEqual(["movers", "watchlists"]);
  });

  it("leads with the home market — India first for IN, US first for US", () => {
    expect(base().sections[0].title).toContain("India");
    expect(defaultLayout("US").sections[0].title).toContain("United States");
    expect(defaultLayout("JP").sections[0].title).toContain("Asia");
  });

  it("gives every section a unique id", () => {
    const l = base();
    expect(new Set(l.sections.map((s) => s.id)).size).toBe(l.sections.length);
  });

  it("mints ids that don't collide even when called in a tight loop", () => {
    const ids = Array.from({ length: 500 }, () => newSectionId());
    expect(new Set(ids).size).toBe(500);
  });
});

describe("normalize — hostile input", () => {
  it("round-trips a valid layout", () => {
    const l = base();
    const out = normalize(JSON.parse(JSON.stringify(l)))!;
    expect(out.sections.map((s) => s.title)).toEqual(l.sections.map((s) => s.title));
    expect(out.regionId).toBe("IN");
  });

  it("returns null for junk rather than throwing", () => {
    for (const junk of [null, undefined, 0, "", "nope", [], {}, { version: "x" }]) {
      expect(() => normalize(junk)).not.toThrow();
      expect(normalize(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("refuses a layout from a FUTURE version instead of guessing at it", () => {
    const l = { ...base(), version: LAYOUT_VERSION + 1 };
    expect(normalize(l)).toBeNull();
  });

  it("drops malformed sections but keeps the good ones", () => {
    const out = normalize({
      version: 1, regionId: "IN",
      sections: [
        null,
        { kind: "nonsense", title: "bad", symbols: ["^NSEI"] },
        { kind: "tiles", title: "Good", symbols: ["^NSEI", "^BSESN"] },
        "not an object",
        { kind: "movers", title: "Movers", symbols: [] },
      ],
    })!;
    expect(out.sections).toHaveLength(2);
    expect(out.sections[0].title).toBe("Good");
    expect(out.sections[1].kind).toBe("movers");
  });

  it("drops an EMPTY tile section — a header over nothing is not a section", () => {
    const out = normalize({
      version: 1, regionId: "IN",
      sections: [
        { kind: "tiles", title: "Empty", symbols: [] },
        { kind: "tiles", title: "Real", symbols: ["^NSEI"] },
      ],
    })!;
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].title).toBe("Real");
  });

  it("re-mints duplicate ids so React keys and reorders stay unambiguous", () => {
    const out = normalize({
      version: 1, regionId: "IN",
      sections: [
        { id: "same", kind: "tiles", title: "A", symbols: ["^NSEI"] },
        { id: "same", kind: "tiles", title: "B", symbols: ["^BSESN"] },
      ],
    })!;
    expect(out.sections).toHaveLength(2);
    expect(out.sections[0].id).not.toBe(out.sections[1].id);
  });

  it("cleans symbol lists: uppercases, dedupes, drops non-strings", () => {
    const out = normalize({
      version: 1, regionId: "IN",
      sections: [{ kind: "tiles", title: "X", symbols: ["^nsei", "^NSEI", 42, null, " tcs.ns "] }],
    })!;
    expect(out.sections[0].symbols).toEqual(["^NSEI", "TCS.NS"]);
  });

  it("caps runaway section and symbol counts", () => {
    const out = normalize({
      version: 1, regionId: "IN",
      sections: Array.from({ length: 200 }, (_, i) => ({
        kind: "tiles", title: `S${i}`,
        symbols: Array.from({ length: 500 }, (_, j) => `T${j}`),
      })),
    })!;
    expect(out.sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
    expect(out.sections[0].symbols.length).toBeLessThanOrEqual(MAX_SYMBOLS_PER_SECTION);
  });

  it("falls back to the default region for an unknown region code", () => {
    const out = normalize({
      version: 1, regionId: "ATLANTIS",
      sections: [{ kind: "tiles", title: "X", symbols: ["^NSEI"] }],
    })!;
    expect(REGIONS.some((r) => r.id === out.regionId)).toBe(true);
  });

  it("returns null when nothing at all survives, so callers use a default", () => {
    expect(normalize({ version: 1, sections: [{ kind: "tiles", symbols: [] }] })).toBeNull();
  });
});

describe("moveSection", () => {
  it("swaps with the neighbour in the given direction", () => {
    const l = base();
    const [a, b] = [l.sections[0].id, l.sections[1].id];
    const moved = moveSection(l, a, 1);
    expect(moved.sections[0].id).toBe(b);
    expect(moved.sections[1].id).toBe(a);
  });

  it("is a no-op at either end rather than wrapping around", () => {
    const l = base();
    const first = l.sections[0].id;
    const last = l.sections[l.sections.length - 1].id;
    expect(moveSection(l, first, -1)).toBe(l);
    expect(moveSection(l, last, 1)).toBe(l);
  });

  it("ignores an unknown id", () => {
    const l = base();
    expect(moveSection(l, "ghost", 1)).toBe(l);
  });

  it("never mutates the input", () => {
    const l = base();
    const before = l.sections.map((s) => s.id);
    moveSection(l, l.sections[0].id, 1);
    expect(l.sections.map((s) => s.id)).toEqual(before);
  });
});

describe("section add / remove / rename", () => {
  it("removes by id and no-ops on an unknown one", () => {
    const l = base();
    const id = l.sections[0].id;
    expect(removeSection(l, id).sections).toHaveLength(l.sections.length - 1);
    expect(removeSection(l, "ghost")).toBe(l);
  });

  it("inserts a preset ABOVE the movers/watchlist tail", () => {
    let l = base();
    l = removeSection(l, l.sections.find((s) => s.title.includes("Europe"))!.id);
    const out = addPresetSection(l, "eu_indices");
    const idx = out.sections.findIndex((s) => s.title.includes("Europe"));
    const tail = out.sections.findIndex((s) => s.kind !== "tiles");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(tail);
  });

  it("ignores an unknown preset id", () => {
    const l = base();
    expect(addPresetSection(l, "does_not_exist")).toBe(l);
  });

  it("creates a custom board that SURVIVES a save/load round trip", () => {
    // A section seeded with no symbols would be dropped by normalize() on the
    // next reload, so the user's new board would vanish.
    const l = addCustomSection(base(), "My board");
    const back = normalize(JSON.parse(JSON.stringify(l)))!;
    expect(back.sections.some((s) => s.title === "My board")).toBe(true);
  });

  it("re-adds a removed movers board, but never duplicates it", () => {
    let l = base();
    const movers = l.sections.find((s) => s.kind === "movers")!;
    l = removeSection(l, movers.id);
    expect(l.sections.some((s) => s.kind === "movers")).toBe(false);
    l = addBoardSection(l, "movers", "Gainers & losers");
    expect(l.sections.filter((s) => s.kind === "movers")).toHaveLength(1);
    expect(addBoardSection(l, "movers", "again")).toBe(l);
  });

  it("renames, ignoring an all-whitespace title", () => {
    const l = base();
    const id = l.sections[0].id;
    expect(renameSection(l, id, "Home").sections[0].title).toBe("Home");
    expect(renameSection(l, id, "   ")).toBe(l);
  });

  it("toggles collapse", () => {
    const l = base();
    const id = l.sections[0].id;
    const once = toggleCollapsed(l, id);
    expect(once.sections[0].collapsed).toBe(true);
    expect(toggleCollapsed(once, id).sections[0].collapsed).toBe(false);
  });

  it("refuses to grow past the section cap", () => {
    let l = base();
    for (let i = 0; i < MAX_SECTIONS + 5; i++) l = addCustomSection(l, `B${i}`);
    expect(l.sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
  });
});

describe("symbol editing", () => {
  const sid = (l: Layout) => l.sections[0].id;

  it("adds, uppercases and refuses duplicates", () => {
    let l = base();
    l = addSymbol(l, sid(l), "aapl");
    expect(l.sections[0].symbols).toContain("AAPL");
    const n = l.sections[0].symbols.length;
    l = addSymbol(l, sid(l), "AAPL");
    expect(l.sections[0].symbols).toHaveLength(n);
  });

  it("ignores blank input", () => {
    const l = base();
    expect(addSymbol(l, sid(l), "   ").sections[0].symbols)
      .toEqual(l.sections[0].symbols);
  });

  it("removes a symbol", () => {
    const l = base();
    const sym = l.sections[0].symbols[0];
    expect(removeSymbol(l, sid(l), sym).sections[0].symbols).not.toContain(sym);
  });

  it("reorders within a section and stops at the ends", () => {
    const l = base();
    const [a, b] = l.sections[0].symbols;
    expect(moveSymbol(l, sid(l), a, 1).sections[0].symbols[0]).toBe(b);
    expect(moveSymbol(l, sid(l), a, -1).sections[0].symbols[0]).toBe(a);
  });

  it("does not touch a non-tiles section", () => {
    const l = base();
    const movers = l.sections.find((s) => s.kind === "movers")!;
    expect(addSymbol(l, movers.id, "AAPL").sections.find((s) => s.id === movers.id)!.symbols)
      .toEqual([]);
  });

  it("caps symbols per section", () => {
    let l = base();
    for (let i = 0; i < MAX_SYMBOLS_PER_SECTION + 10; i++) l = addSymbol(l, sid(l), `T${i}`);
    expect(l.sections[0].symbols.length).toBe(MAX_SYMBOLS_PER_SECTION);
  });
});

describe("allSymbols / availablePresets", () => {
  it("collects every tile symbol exactly once for one bulk subscription", () => {
    const l = base();
    const syms = allSymbols(l);
    expect(new Set(syms).size).toBe(syms.length);
    expect(syms).toContain("^NSEI");
    // Movers and watchlists contribute nothing — they fetch their own data.
    expect(syms.length).toBe(
      new Set(l.sections.filter((s) => s.kind === "tiles").flatMap((s) => s.symbols)).size);
  });

  it("offers only presets not already on the board", () => {
    const l = base();
    const avail = availablePresets(l);
    const titles = new Set(l.sections.map((s) => s.title));
    for (const id of avail) {
      const p = SECTION_PRESETS.find((x) => x.id === id)!;
      expect(titles.has(p.title)).toBe(false);
    }
  });
});
