import { describe, expect, it } from "vitest";

import {
  filterNote, matchLabel, normTitle, sentimentIndex, sentimentNote, summarise,
} from "./newsSentiment";

describe("normTitle", () => {
  it("ignores case, punctuation and whitespace", () => {
    // The failure this fixes: the sentiment pass keys results by title, so a
    // re-encoded apostrophe lost the tag — and an untagged story looks like a
    // story the model chose not to tag rather than a bug.
    expect(normTitle("Reliance’s Q1 beats!"))
      .toBe(normTitle("Reliance's  Q1 Beats"));
  });

  it("keeps words distinct rather than mashing them together", () => {
    expect(normTitle("Q1-beats")).toBe("q1 beats");
  });

  it("is empty for a title with nothing in it", () => {
    expect(normTitle("  —  ")).toBe("");
  });
});

describe("sentimentIndex", () => {
  it("looks up a tag despite cosmetic title differences", () => {
    const idx = sentimentIndex([
      { title: "Reliance’s Q1 beats", sentiment: "bull" },
    ]);
    expect(idx.get(normTitle("Reliance's Q1 Beats!"))).toBe("bull");
  });

  it("keeps the first tag for a duplicated title", () => {
    const idx = sentimentIndex([
      { title: "Same story", sentiment: "bull" },
      { title: "same STORY", sentiment: "bear" },
    ]);
    expect(idx.get("same story")).toBe("bull");
  });

  it("skips an empty title rather than indexing it", () => {
    expect(sentimentIndex([{ title: "!!!", sentiment: "bull" }]).size).toBe(0);
  });
});

describe("summarise", () => {
  const tagged = sentimentIndex([
    { title: "A up", sentiment: "bull" },
    { title: "B up", sentiment: "bull" },
    { title: "C down", sentiment: "bear" },
    { title: "D flat", sentiment: "neutral" },
  ]);
  const items = [{ title: "A up" }, { title: "B up" }, { title: "C down" },
                 { title: "D flat" }, { title: "E untagged" }];

  it("counts each bucket and averages to a score", () => {
    const s = summarise(items, tagged);
    expect(s).toMatchObject({ bull: 2, bear: 1, neutral: 1, tagged: 4, total: 5 });
    expect(s.score).toBeCloseTo((2 - 1) / 4, 8);
  });

  it("reports coverage, so a score over a subset is visible as one", () => {
    expect(summarise(items, tagged).coveragePct).toBeCloseTo(80, 6);
  });

  it("returns a null score rather than zero when nothing is tagged", () => {
    // Zero would read as "neutral", which is a claim. Null is the truth.
    const s = summarise(items, new Map());
    expect(s.score).toBeNull();
    expect(s.tagged).toBe(0);
  });

  it("handles an empty list", () => {
    const s = summarise([], new Map());
    expect(s.score).toBeNull();
    expect(s.coveragePct).toBeNull();
  });
});

describe("sentimentNote", () => {
  const s = (over = {}) => ({
    bull: 6, bear: 2, neutral: 2, tagged: 10, total: 10, score: 0.4,
    coveragePct: 100, ...over,
  });

  it("says what the score is: an average of tags, nothing cleverer", () => {
    const note = sentimentNote(s());
    expect(note).toMatch(/A language model read 10 of 10 headlines/);
    expect(note).toMatch(/nothing more sophisticated/);
  });

  it("says it reads tone and not importance", () => {
    const note = sentimentNote(s());
    expect(note).toMatch(/reads TONE, not importance/);
    expect(note).toMatch(/neutral reprints of a press release outweigh/);
  });

  it("warns that coverage follows the price", () => {
    // The trap: a bearish tally after a fall is the fall being reported.
    expect(sentimentNote(s())).toMatch(/the fall being reported rather than a signal/);
  });

  it("flags partial coverage instead of implying the score covers the list", () => {
    expect(sentimentNote(s({ tagged: 5, coveragePct: 50 })))
      .toMatch(/Only 50% of the list carries a tag/);
    expect(sentimentNote(s())).not.toMatch(/carries a tag/);
  });

  it("says nothing has been tagged rather than scoring nothing", () => {
    expect(sentimentNote(s({ tagged: 0, score: null })))
      .toMatch(/No headlines have been tagged yet/);
  });
});

describe("filterNote", () => {
  it("names the entity and how a story qualifies", () => {
    const note = filterNote({
      entity: "Reliance Industries Ltd", matched: 8, dropped: 0, strict: true });
    expect(note).toMatch(/Reliance Industries Ltd/);
    expect(note).toMatch(/exchange-qualified symbol, an ISIN, or every distinctive word/);
  });

  it("says how many namesake stories were dropped, which is the point", () => {
    // A reader with four headlines can't otherwise tell whether the company is
    // quiet or twelve stories about a different Reliance were filtered out.
    const note = filterNote({
      entity: "Reliance Industries Ltd", matched: 4, dropped: 12, strict: true });
    expect(note).toMatch(/12 stories were dropped/);
    expect(note).toMatch(/shorter than a plain search/);
  });

  it("gets the grammar right for a single dropped story", () => {
    expect(filterNote({ entity: "X", matched: 1, dropped: 1, strict: true }))
      .toMatch(/1 story was dropped/);
  });

  it("admits the filter can exclude a genuine story", () => {
    expect(filterNote({ entity: "X", matched: 5, dropped: 0, strict: true }))
      .toMatch(/errs towards excluding/);
  });

  it("says plainly when filtering is off", () => {
    const note = filterNote({ entity: "X", matched: null, dropped: null, strict: false });
    expect(note).toMatch(/Entity filtering is OFF/);
    expect(note).toMatch(/similar names are included/);
  });

  it("works without a resolved entity name", () => {
    expect(filterNote({ entity: null, matched: 3, dropped: 1, strict: true }))
      .toMatch(/this company/);
  });
});

describe("matchLabel", () => {
  it("distinguishes a symbol match from a name match", () => {
    expect(matchLabel("exact")!.label).toBe("symbol");
    expect(matchLabel("exact")!.hint).toMatch(/names this listing specifically/);
    expect(matchLabel("name")!.label).toBe("name");
  });

  it("marks a loose match as possibly the wrong company", () => {
    expect(matchLabel("weak")!.hint).toMatch(/may be about a different company/);
  });

  it("has nothing to show for an unlabelled item", () => {
    expect(matchLabel(null)).toBeNull();
    expect(matchLabel(undefined)).toBeNull();
  });
});
