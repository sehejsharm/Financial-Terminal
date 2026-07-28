import { describe, expect, it } from "vitest";

import { looksLikeQuestion, stripAskPrefix } from "./askIntent";

/**
 * This predicate decides whether Enter in the palette runs a ticker lookup or
 * an AI question. Getting it wrong in the "too eager" direction is the
 * expensive one — it hijacks the palette's primary job — so these tests weigh
 * heavily towards NOT treating things as questions.
 */
describe("looksLikeQuestion", () => {
  it("treats real questions as questions", () => {
    for (const q of [
      "what is my biggest position?",
      "How concentrated is my portfolio?",
      "why is the yield curve inverted?",
      "should I be worried about my energy exposure",
      "ask what my top holding is",
      "Ask about my alerts",
      "which sector am I most exposed to?",
    ]) expect(looksLikeQuestion(q), q).toBe(true);
  });

  it("NEVER hijacks a ticker lookup", () => {
    for (const q of [
      "RELIANCE.NS", "AAPL", "TCS", "^NSEI", "BRK.B", "RELIANCE.NS DES",
      "RELIANCE TCS INFY CF", "MSFT OMON", "screeners", "portfolio",
      "hdfcbank.ns",
    ]) expect(looksLikeQuestion(q), q).toBe(false);
  });

  it("does not fire on a short or empty input", () => {
    for (const q of ["", "  ", "a", "is", "why", "how?"]) {
      expect(looksLikeQuestion(q), JSON.stringify(q)).toBe(false);
    }
  });

  it("needs three words before a leading question word counts", () => {
    expect(looksLikeQuestion("what next")).toBe(false);
    expect(looksLikeQuestion("what is happening")).toBe(true);
  });

  it("accepts a trailing question mark regardless of phrasing", () => {
    expect(looksLikeQuestion("my energy exposure?")).toBe(true);
  });

  it("is case insensitive on the ask prefix", () => {
    expect(looksLikeQuestion("ASK me something")).toBe(true);
    expect(looksLikeQuestion("Ask me something")).toBe(true);
  });

  it("does not treat a company starting with a question word as a question", () => {
    // Single token, so the multi-word rule protects it.
    expect(looksLikeQuestion("CANFINHOME.NS")).toBe(false);
  });
});

describe("stripAskPrefix", () => {
  it("removes the command word so the model doesn't see it", () => {
    expect(stripAskPrefix("ask what do I hold")).toBe("what do I hold");
    expect(stripAskPrefix("ASK   what do I hold")).toBe("what do I hold");
  });
  it("leaves a question without the prefix alone", () => {
    expect(stripAskPrefix("what do I hold?")).toBe("what do I hold?");
  });
  it("does not strip 'ask' from the middle of a sentence", () => {
    expect(stripAskPrefix("what should I ask about this")).toBe("what should I ask about this");
  });
});
