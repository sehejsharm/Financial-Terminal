import { describe, expect, it } from "vitest";

import {
  activeTickers, addPane, addRow, DEFAULT_TICKER, emptyWorkspace, evenOut,
  findPane, LINK_GROUPS, makePane, makeRow, MAX_PANES, MAX_PANES_PER_ROW,
  MAX_ROWS, MIN_WEIGHT, movePane, movePaneToRow, moveRow, newId, normalize,
  paneCount, removePane, removeRow, resizeColumn, resizeRow, setGroupTicker,
  setPane, setPaneLink, setTickerFrom, tickerFor, WS_VERSION,
  type Workspace,
} from "./workspace";
import { DESK_PRESETS, WIDGET_IDS, needsTicker, widget } from "./workspaceWidgets";

const ws = () => emptyWorkspace("Test");
const firstPane = (w: Workspace) => w.rows[0].panes[0];

describe("construction", () => {
  it("starts with one row of two linked panes on a real ticker", () => {
    const w = ws();
    expect(w.version).toBe(WS_VERSION);
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].panes).toHaveLength(2);
    expect(paneCount(w)).toBe(2);
    expect(tickerFor(w, firstPane(w))).toBe(DEFAULT_TICKER);
  });

  it("mints unique ids under rapid creation", () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect(new Set(ids).size).toBe(500);
  });

  it("gives a row one weight per pane", () => {
    const r = makeRow([makePane("chart"), makePane("news"), makePane("ai")]);
    expect(r.split).toEqual([1, 1, 1]);
  });
});

describe("link groups — the point of the whole feature", () => {
  it("retyping the ticker in ONE linked pane moves every pane in that group", () => {
    let w = ws();                       // both panes are group A
    w = setTickerFrom(w, firstPane(w).id, "tcs.ns");
    for (const p of w.rows[0].panes) expect(tickerFor(w, p)).toBe("TCS.NS");
  });

  it("does NOT move panes in a different group", () => {
    let w = ws();
    w = setPaneLink(w, w.rows[0].panes[1].id, "B");
    w = setGroupTicker(w, "B", "INFY.NS");
    w = setTickerFrom(w, firstPane(w).id, "TCS.NS");
    expect(tickerFor(w, w.rows[0].panes[0])).toBe("TCS.NS");
    expect(tickerFor(w, w.rows[0].panes[1])).toBe("INFY.NS");
  });

  it("an UNLINKED pane keeps its own ticker and ignores the group", () => {
    let w = ws();
    const solo = w.rows[0].panes[1].id;
    w = setPaneLink(w, solo, "none");
    w = setTickerFrom(w, solo, "AAPL");
    w = setTickerFrom(w, firstPane(w).id, "TCS.NS");
    expect(tickerFor(w, w.rows[0].panes[0])).toBe("TCS.NS");
    expect(tickerFor(w, w.rows[0].panes[1])).toBe("AAPL");
  });

  it("linking a pane CARRIES its current ticker instead of jumping symbols", () => {
    let w = ws();
    const solo = w.rows[0].panes[1].id;
    w = setPaneLink(w, solo, "none");
    w = setTickerFrom(w, solo, "AAPL");
    // Group C is empty; binding to it should adopt AAPL, not the default.
    w = setPaneLink(w, solo, "C");
    expect(w.groups.C).toBe("AAPL");
    expect(tickerFor(w, w.rows[0].panes[1])).toBe("AAPL");
  });

  it("linking into an OCCUPIED group adopts that group's ticker", () => {
    let w = ws();
    w = setGroupTicker(w, "B", "INFY.NS");
    const p = w.rows[0].panes[1].id;
    w = setPaneLink(w, p, "B");
    expect(tickerFor(w, findPane(w, p)!.pane)).toBe("INFY.NS");
    expect(w.groups.B).toBe("INFY.NS");   // unchanged by the newcomer
  });

  it("unlinking freezes whatever the pane was showing", () => {
    let w = ws();
    w = setTickerFrom(w, firstPane(w).id, "TCS.NS");
    const p = w.rows[0].panes[1].id;
    w = setPaneLink(w, p, "none");
    w = setTickerFrom(w, firstPane(w).id, "WIPRO.NS");
    expect(tickerFor(w, findPane(w, p)!.pane)).toBe("TCS.NS");
  });

  it("ignores blank ticker input rather than blanking the group", () => {
    let w = ws();
    w = setTickerFrom(w, firstPane(w).id, "TCS.NS");
    w = setTickerFrom(w, firstPane(w).id, "   ");
    expect(w.groups.A).toBe("TCS.NS");
    expect(setGroupTicker(w, "none", "X")).toBe(w);
  });

  it("collects each distinct on-screen ticker exactly once", () => {
    let w = ws();
    w = setPaneLink(w, w.rows[0].panes[1].id, "B");
    w = setGroupTicker(w, "B", "INFY.NS");
    const t = activeTickers(w);
    expect(new Set(t).size).toBe(t.length);
    expect(t.sort()).toEqual(["INFY.NS", DEFAULT_TICKER].sort());
  });
});

describe("pane operations", () => {
  it("adds a pane to a row with a matching weight", () => {
    let w = ws();
    w = addPane(w, w.rows[0].id, "ai");
    expect(w.rows[0].panes).toHaveLength(3);
    expect(w.rows[0].split).toHaveLength(3);
  });

  it("refuses to overfill a row or the workspace", () => {
    let w = ws();
    for (let i = 0; i < 10; i++) w = addPane(w, w.rows[0].id, "news");
    expect(w.rows[0].panes.length).toBe(MAX_PANES_PER_ROW);

    let big = ws();
    for (let r = 0; r < MAX_ROWS + 2; r++) big = addRow(big, "news");
    for (const row of big.rows) {
      for (let i = 0; i < MAX_PANES_PER_ROW; i++) big = addPane(big, row.id, "news");
    }
    expect(paneCount(big)).toBeLessThanOrEqual(MAX_PANES);
    expect(big.rows.length).toBeLessThanOrEqual(MAX_ROWS);
  });

  it("removes a pane and its weight together", () => {
    let w = ws();
    const id = firstPane(w).id;
    w = removePane(w, id);
    expect(w.rows[0].panes).toHaveLength(1);
    expect(w.rows[0].split).toHaveLength(1);
    expect(findPane(w, id)).toBeNull();
  });

  it("NEVER removes the last pane — an empty workspace renders nothing", () => {
    let w = ws();
    w = removePane(w, w.rows[0].panes[1].id);
    const only = firstPane(w).id;
    expect(removePane(w, only)).toBe(w);
    expect(paneCount(w)).toBe(1);
  });

  it("drops a row that loses its last pane rather than leaving a gap", () => {
    let w = ws();
    w = addRow(w, "ai");
    expect(w.rows).toHaveLength(2);
    w = removePane(w, w.rows[1].panes[0].id);
    expect(w.rows).toHaveLength(1);
  });

  it("changes a pane's widget without changing its identity", () => {
    let w = ws();
    const id = firstPane(w).id;
    w = setPane(w, id, { widget: "volcone" });
    expect(firstPane(w).widget).toBe("volcone");
    expect(firstPane(w).id).toBe(id);
  });

  it("cannot have its id overwritten through setPane", () => {
    let w = ws();
    const id = firstPane(w).id;
    w = setPane(w, id, { id: "hacked" } as never);
    expect(firstPane(w).id).toBe(id);
  });

  it("reorders within a row, carrying the weight along", () => {
    let w = ws();
    w = setPane(w, w.rows[0].panes[0].id, { widget: "chart" });
    w = resizeColumn(w, w.rows[0].id, 0, 0.2);
    const [a, b] = w.rows[0].panes.map((p) => p.id);
    const wA = w.rows[0].split[0];
    w = movePane(w, a, 1);
    expect(w.rows[0].panes.map((p) => p.id)).toEqual([b, a]);
    expect(w.rows[0].split[1]).toBeCloseTo(wA, 10);
  });

  it("no-ops moving a pane past either end", () => {
    const w = ws();
    expect(movePane(w, w.rows[0].panes[0].id, -1)).toBe(w);
    expect(movePane(w, w.rows[0].panes[1].id, 1)).toBe(w);
  });
});

describe("rows", () => {
  it("adds and removes rows, keeping at least one", () => {
    let w = ws();
    w = addRow(w, "movers");
    expect(w.rows).toHaveLength(2);
    w = removeRow(w, w.rows[1].id);
    expect(w.rows).toHaveLength(1);
    expect(removeRow(w, w.rows[0].id)).toBe(w);
  });

  it("reorders rows and stops at the ends", () => {
    let w = ws();
    w = addRow(w, "movers");
    const [a, b] = w.rows.map((r) => r.id);
    expect(moveRow(w, a, 1).rows.map((r) => r.id)).toEqual([b, a]);
    expect(moveRow(w, a, -1)).toBe(w);
    expect(moveRow(w, b, 1)).toBe(w);
  });

  it("moves a pane between rows", () => {
    let w = ws();
    w = addRow(w, "movers");
    const p = firstPane(w).id;
    const target = w.rows[1].id;
    w = movePaneToRow(w, p, target);
    expect(w.rows[1].panes.some((x) => x.id === p)).toBe(true);
    expect(w.rows[0].panes.some((x) => x.id === p)).toBe(false);
    expect(w.rows[1].split).toHaveLength(w.rows[1].panes.length);
  });

  it("refuses to move a pane into a full row, or onto itself", () => {
    let w = ws();
    w = addRow(w, "movers");
    const target = w.rows[1].id;
    for (let i = 0; i < MAX_PANES_PER_ROW; i++) w = addPane(w, target, "news");
    const p = firstPane(w).id;
    expect(movePaneToRow(w, p, target)).toBe(w);
    expect(movePaneToRow(w, p, w.rows[0].id)).toBe(w);
  });
});

describe("resizing", () => {
  it("trades weight between neighbours, leaving the rest untouched", () => {
    let w = ws();
    w = addPane(w, w.rows[0].id, "ai");
    const before = w.rows[0].split.reduce((a, b) => a + b, 0);
    const third = w.rows[0].split[2];
    w = resizeColumn(w, w.rows[0].id, 0, 0.1);
    expect(w.rows[0].split.reduce((a, b) => a + b, 0)).toBeCloseTo(before, 10);
    expect(w.rows[0].split[2]).toBeCloseTo(third, 10);
    expect(w.rows[0].split[0]).toBeGreaterThan(1);
  });

  it("clamps so a pane can never be crushed to nothing", () => {
    let w = ws();
    for (const d of [-99, 99, -5, 5]) w = resizeColumn(w, w.rows[0].id, 0, d);
    const total = w.rows[0].split.reduce((a, b) => a + b, 0);
    for (const s of w.rows[0].split) {
      expect(s).toBeGreaterThanOrEqual(total * MIN_WEIGHT - 1e-9);
    }
  });

  it("ignores a non-finite delta rather than producing NaN widths", () => {
    const w = ws();
    const out = resizeColumn(w, w.rows[0].id, 0, NaN);
    expect(out.rows[0].split.every(Number.isFinite)).toBe(true);
  });

  it("no-ops on an out-of-range divider index", () => {
    const w = ws();
    expect(resizeColumn(w, w.rows[0].id, 5, 0.1)).toBe(w);
    expect(resizeColumn(w, "nope", 0, 0.1).rows[0].split).toEqual(w.rows[0].split);
    expect(resizeRow(w, 0, 0.1)).toBe(w);      // only one row
  });

  it("resizes rows the same way", () => {
    let w = ws();
    w = addRow(w, "movers");
    const before = w.rows.reduce((a, r) => a + r.height, 0);
    w = resizeRow(w, 0, 0.2);
    expect(w.rows.reduce((a, r) => a + r.height, 0)).toBeCloseTo(before, 10);
    expect(w.rows[0].height).toBeGreaterThan(w.rows[1].height);
  });

  it("evenOut resets every weight", () => {
    let w = ws();
    w = addRow(w, "movers");
    w = resizeColumn(w, w.rows[0].id, 0, 0.3);
    w = resizeRow(w, 0, 0.3);
    w = evenOut(w);
    expect(w.rows.every((r) => r.height === 1)).toBe(true);
    expect(w.rows.every((r) => r.split.every((s) => s === 1))).toBe(true);
  });
});

describe("normalize — hostile and legacy input", () => {
  it("round-trips a real workspace", () => {
    let w = ws();
    w = addRow(w, "movers");
    w = setTickerFrom(w, firstPane(w).id, "TCS.NS");
    const out = normalize(JSON.parse(JSON.stringify(w)))!;
    expect(out.rows).toHaveLength(2);
    expect(out.groups.A).toBe("TCS.NS");
    expect(out.rows[0].panes.map((p) => p.widget))
      .toEqual(w.rows[0].panes.map((p) => p.widget));
  });

  it("returns null on junk instead of throwing", () => {
    for (const junk of [null, undefined, 0, "", "x", [], {}, { rows: "no" }]) {
      expect(() => normalize(junk)).not.toThrow();
      expect(normalize(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("MIGRATES a v1 flat layout into a single linked row", () => {
    // The old shape: no rows, no ids, no link groups.
    const legacy = {
      id: "1", name: "Old desk",
      panes: [{ widget: "chart", ticker: "TCS.NS" }, { widget: "news", ticker: "TCS.NS" }],
      split: [2, 1],
    };
    const out = normalize(legacy)!;
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].panes).toHaveLength(2);
    expect(out.rows[0].split).toEqual([2, 1]);
    expect(out.name).toBe("Old desk");
    // Everything lands on group A, reproducing the old "all panes follow" feel,
    // seeded with the ticker the user actually saved.
    expect(out.rows[0].panes.every((p) => p.link === "A")).toBe(true);
    expect(out.groups.A).toBe("TCS.NS");
  });

  it("migrates a v1 layout AS THE SERVER RETURNS IT (rows: [] present)", () => {
    // The regression that broke restoring saved desks: the backend's Pydantic
    // model defaults rows to [], so the wire shape of a v1 document has BOTH
    // an empty rows array and the legacy panes. Testing only the hand-written
    // shape (no rows key at all) missed it entirely.
    const fromServer = {
      id: "old", name: "Old desk", version: null,
      rows: [], groups: {},
      panes: [{ widget: "chart", ticker: "TCS.NS", link: null, id: null },
              { widget: "news", ticker: "TCS.NS", link: null, id: null }],
      split: [2, 1],
    };
    const out = normalize(fromServer, WIDGET_IDS);
    expect(out, "a saved v1 desk must not be discarded").not.toBeNull();
    expect(out!.name).toBe("Old desk");
    expect(out!.rows).toHaveLength(1);
    expect(out!.rows[0].panes.map((p) => p.widget)).toEqual(["chart", "news"]);
    expect(out!.rows[0].split).toEqual([2, 1]);
    expect(out!.groups.A).toBe("TCS.NS");
  });

  it("still returns null when BOTH rows and panes are empty", () => {
    expect(normalize({ id: "x", name: "X", rows: [], panes: [], groups: {} })).toBeNull();
  });

  it("drops panes whose widget this build no longer ships", () => {
    const out = normalize({
      rows: [{ panes: [{ widget: "chart" }, { widget: "removed_widget" }] }],
    }, WIDGET_IDS)!;
    expect(out.rows[0].panes).toHaveLength(1);
    expect(out.rows[0].panes[0].widget).toBe("chart");
  });

  it("returns null when EVERY widget is unknown, so the caller can reset", () => {
    expect(normalize({ rows: [{ panes: [{ widget: "gone" }] }] }, WIDGET_IDS)).toBeNull();
  });

  it("repairs bad weights, bad links and duplicate ids", () => {
    const out = normalize({
      rows: [{
        id: "dup",
        panes: [
          { id: "same", widget: "chart", link: "Z" },
          { id: "same", widget: "news", link: 42 },
        ],
        split: ["x", -3],
        height: "tall",
      }, { id: "dup", panes: [{ widget: "ai" }] }],
    })!;
    expect(out.rows[0].panes[0].id).not.toBe(out.rows[0].panes[1].id);
    expect(out.rows[0].id).not.toBe(out.rows[1].id);
    expect(out.rows[0].split).toEqual([1, 1]);
    expect(out.rows[0].height).toBe(1);
    for (const p of out.rows.flatMap((r) => r.panes)) {
      expect(LINK_GROUPS).toContain(p.link);
    }
  });

  it("caps runaway rows and panes", () => {
    const out = normalize({
      rows: Array.from({ length: 40 }, () => ({
        panes: Array.from({ length: 40 }, () => ({ widget: "news" })),
      })),
    })!;
    expect(out.rows.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(paneCount(out)).toBeLessThanOrEqual(MAX_PANES);
    for (const r of out.rows) expect(r.panes.length).toBeLessThanOrEqual(MAX_PANES_PER_ROW);
  });

  it("skips empty rows and malformed panes", () => {
    const out = normalize({
      rows: [
        { panes: [] },
        null,
        { panes: [null, "x", { notAWidget: 1 }, { widget: "chart" }] },
      ],
    })!;
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].panes).toHaveLength(1);
  });

  it("always yields a group A ticker so panes have something to render", () => {
    const out = normalize({ rows: [{ panes: [{ widget: "movers" }] }] })!;
    expect(out.groups.A).toBeTruthy();
  });
});

describe("widget catalogue", () => {
  it("has unique ids and coherent metadata", () => {
    const ids = [...WIDGET_IDS];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const d = widget(id)!;
      expect(d.label.length, id).toBeGreaterThan(0);
      expect(d.blurb.length, id).toBeGreaterThan(0);
      expect(d.minHeight, id).toBeGreaterThan(100);
    }
  });

  it("marks the market-wide widgets as NOT needing a ticker", () => {
    expect(needsTicker("movers")).toBe(false);
    expect(needsTicker("watchlist")).toBe(false);
    expect(needsTicker("chart")).toBe(true);
    expect(needsTicker("nonexistent")).toBe(false);
  });

  it("every desk preset references real widgets, real groups and fits the caps", () => {
    for (const p of DESK_PRESETS) {
      expect(p.rows.length, p.id).toBeLessThanOrEqual(MAX_ROWS);
      let total = 0;
      for (const row of p.rows) {
        expect(row.length, p.id).toBeLessThanOrEqual(MAX_PANES_PER_ROW);
        total += row.length;
        for (const [wid, link] of row) {
          expect(WIDGET_IDS.has(wid), `${p.id}: ${wid}`).toBe(true);
          expect(LINK_GROUPS, `${p.id}: ${link}`).toContain(link);
          // A market-wide widget bound to a link group would be misleading.
          if (!needsTicker(wid)) expect(link, `${p.id}: ${wid}`).toBe("none");
        }
      }
      expect(total, p.id).toBeLessThanOrEqual(MAX_PANES);
    }
  });
});
