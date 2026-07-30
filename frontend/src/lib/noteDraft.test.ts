import { beforeEach, describe, expect, it } from "vitest";

import {
  AUTOSAVE_MS, clearDraft, counts, loadDraft, saveDraft, shouldRecover, stamp,
} from "./noteDraft";

/** A localStorage good enough to test against, including a failing one. */
function fakeStorage(fail = false) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (fail ? (() => { throw new Error("nope"); })() : map.get(k) ?? null),
    setItem: (k: string, v: string) => {
      if (fail) throw new Error("quota");
      map.set(k, v);
    },
    removeItem: (k: string) => { if (fail) throw new Error("nope"); map.delete(k); },
    clear: () => map.clear(),
    key: () => null, length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = fakeStorage();
});

describe("saveDraft / loadDraft", () => {
  it("round-trips a draft with its timestamp", () => {
    saveDraft("RELIANCE.NS", "thesis in progress", "", 1000);
    expect(loadDraft("RELIANCE.NS")).toEqual({ text: "thesis in progress", at: 1000 });
  });

  it("is keyed per ticker, case-insensitively", () => {
    saveDraft("aapl", "apple note", "", 1000);
    expect(loadDraft("AAPL")?.text).toBe("apple note");
    expect(loadDraft("MSFT")).toBeNull();
  });

  it("CLEARS the draft when the text matches what's saved", () => {
    // A clean note must never come back as a "recovered" one.
    saveDraft("AAPL", "same", "", 1000);
    saveDraft("AAPL", "same", "same", 2000);
    expect(loadDraft("AAPL")).toBeNull();
  });

  it("survives storage being unavailable rather than taking the editor down", () => {
    (globalThis as { localStorage: Storage }).localStorage = fakeStorage(true);
    expect(() => saveDraft("AAPL", "x", "", 1)).not.toThrow();
    expect(loadDraft("AAPL")).toBeNull();
    expect(() => clearDraft("AAPL")).not.toThrow();
  });

  it("ignores a corrupted or foreign entry", () => {
    localStorage.setItem("mb:note-draft:AAPL", "not json");
    expect(loadDraft("AAPL")).toBeNull();
    localStorage.setItem("mb:note-draft:AAPL", JSON.stringify({ text: 5 }));
    expect(loadDraft("AAPL")).toBeNull();
  });
});

describe("shouldRecover", () => {
  const savedAt = "2026-06-01T10:00:00Z";
  const at = Date.parse(savedAt);

  it("offers a draft that is different AND newer than the saved note", () => {
    expect(shouldRecover({ text: "newer draft", at: at + 60_000 }, "old", savedAt))
      .toBe(true);
  });

  it("REFUSES a draft older than the saved note", () => {
    // Restoring stale text over good text is what makes recovery prompts
    // untrustworthy, and one bad restore is enough to teach a user to ignore
    // them forever.
    expect(shouldRecover({ text: "stale", at: at - 60_000 }, "current", savedAt))
      .toBe(false);
  });

  it("refuses a draft identical to what's saved", () => {
    expect(shouldRecover({ text: "same", at: at + 60_000 }, "same", savedAt)).toBe(false);
  });

  it("offers a draft when the note was never saved", () => {
    expect(shouldRecover({ text: "draft", at: 1 }, "", null)).toBe(true);
  });

  it("offers a draft rather than trusting an unparseable saved timestamp", () => {
    expect(shouldRecover({ text: "draft", at: 1 }, "other", "whenever")).toBe(true);
  });

  it("has nothing to offer without a draft", () => {
    expect(shouldRecover(null, "", null)).toBe(false);
  });
});

describe("counts", () => {
  it("counts words, characters and lines", () => {
    expect(counts("two words\nand more")).toEqual({ words: 4, chars: 18, lines: 2 });
  });

  it("is zero-word for whitespace, not one", () => {
    expect(counts("   \n  ").words).toBe(0);
    expect(counts("").words).toBe(0);
  });

  it("collapses runs of whitespace instead of counting empty words", () => {
    expect(counts("a     b").words).toBe(2);
  });
});

describe("stamp", () => {
  it("writes a dated, priced heading", () => {
    const out = stamp("", { date: "2026-06-30", price: 1425.6, currency: "₹" });
    expect(out).toMatch(/^## 2026-06-30 · ₹1,425\.60/);
  });

  it("puts a new entry ON TOP of the existing note", () => {
    // The most recent view is the one being looked for; scrolling past a year
    // of notes to reach it is friction with no upside.
    const out = stamp("older thinking", { date: "2026-06-30", price: 100, currency: "$" });
    expect(out.indexOf("2026-06-30")).toBeLessThan(out.indexOf("older thinking"));
  });

  it("omits the price rather than inventing one", () => {
    for (const p of [null, NaN]) {
      const out = stamp("", { date: "2026-06-30", price: p, currency: "$" });
      expect(out).toBe("## 2026-06-30\n\n");
    }
  });

  it("keeps every character of the existing note", () => {
    const body = "line one\nline two\n";
    expect(stamp(body, { date: "2026-06-30", price: null, currency: "$" }))
      .toContain("line one\nline two");
  });
});

describe("AUTOSAVE_MS", () => {
  it("is long enough to be one save per paragraph, short enough to lose a sentence at most", () => {
    expect(AUTOSAVE_MS).toBeGreaterThanOrEqual(1000);
    expect(AUTOSAVE_MS).toBeLessThanOrEqual(5000);
  });
});
