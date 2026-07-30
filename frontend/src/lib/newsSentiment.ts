/** Reading a ticker's news feed honestly.
 *
 *  Two things were wrong with CN.
 *
 *  The backend spent real effort deciding which stories are about THIS company
 *  — the fix for RELIANCE.NS returning news about Reliance Steel — and reports
 *  what it kept, what it dropped and which name it matched against. The screen
 *  threw all of that away and showed a short list, so a reader with four
 *  headlines couldn't tell whether the company is quiet or whether twelve
 *  stories about a namesake were filtered out. The difference matters.
 *
 *  And the AI sentiment score was a number with "(AI-tagged)" beside it in
 *  9px type. A model-derived number gets the same plain-language treatment as
 *  every other one on this app: what it is, what it isn't, and why a headline
 *  count is not a view.
 *
 *  Pure. The title matching in particular needs to be testable, because it is
 *  where the sentiment tags silently fail to line up with the stories.
 */

export type MatchStrength = "exact" | "name" | "weak" | null | undefined;

/**
 * Titles compared the way a human would: case, punctuation and whitespace
 * ignored.
 *
 * The sentiment pass keys its results by title, so an exact string comparison
 * loses a tag the moment the feed re-encodes an apostrophe or collapses a
 * double space — and a lost tag renders as an untagged story rather than an
 * error, which is why it went unnoticed.
 */
export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
}

/** Index sentiment results by normalised title for lookup. */
export function sentimentIndex<T extends { title: string; sentiment: string }>(
    items: T[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of items) {
    const k = normTitle(it.title);
    // First writer wins: a duplicate title is the same story, and the second
    // tag is not more authoritative than the first.
    if (k && !m.has(k)) m.set(k, it.sentiment);
  }
  return m;
}

export type SentimentSummary = {
  bull: number;
  bear: number;
  neutral: number;
  tagged: number;
  total: number;
  /** Mean of +1/−1/0 across tagged items, or null with nothing tagged. */
  score: number | null;
  /** Share of items the model actually tagged, 0–100. */
  coveragePct: number | null;
};

export function summarise(items: { title: string }[],
                         index: Map<string, string>): SentimentSummary {
  let bull = 0, bear = 0, neutral = 0;
  for (const it of items) {
    switch (index.get(normTitle(it.title))) {
      case "bull": bull++; break;
      case "bear": bear++; break;
      case "neutral": neutral++; break;
    }
  }
  const tagged = bull + bear + neutral;
  return {
    bull, bear, neutral, tagged, total: items.length,
    score: tagged ? (bull - bear) / tagged : null,
    coveragePct: items.length ? (tagged / items.length) * 100 : null,
  };
}

/**
 * What the sentiment number does and does not mean.
 *
 * A headline count is not a view. Coverage of a company is driven by how much
 * gets written about it, which correlates with what already happened to the
 * price — so a bearish tally after a fall is usually the fall being reported
 * rather than a signal about what comes next.
 */
export function sentimentNote(s: SentimentSummary): string {
  if (!s.tagged) {
    return "No headlines have been tagged yet. Sentiment is a separate model "
      + "pass — run it from the button above.";
  }
  const parts = [
    `A language model read ${s.tagged} of ${s.total} headlines and tagged `
      + `${s.bull} bullish, ${s.bear} bearish and ${s.neutral} neutral. The `
      + "score is the average of those tags, nothing more sophisticated.",
  ];
  if (s.coveragePct != null && s.coveragePct < 80) {
    parts.push(`Only ${s.coveragePct.toFixed(0)}% of the list carries a tag, so `
      + "the score describes a subset of what is on screen.");
  }
  parts.push("It reads TONE, not importance: a hundred neutral reprints of a "
    + "press release outweigh one genuinely bad story. Coverage volume also "
    + "follows the price, so a bearish tally after a fall is usually the fall "
    + "being reported rather than a signal about what happens next. Two runs "
    + "can disagree, and none of it is a recommendation.");
  return parts.join(" ");
}

// ── the entity filter ─────────────────────────────────────────────────────

export type FilterOutcome = {
  entity: string | null;
  matched: number | null;
  dropped: number | null;
  strict: boolean;
};

/**
 * What the entity filter did, said out loud.
 *
 * This is the visible half of the RELIANCE.NS / Reliance Steel fix. Without it
 * the filter's work is invisible and its failures are unfalsifiable: a short
 * list looks the same whether the company is quiet or the matching is broken.
 */
export function filterNote(o: FilterOutcome): string {
  if (!o.strict) {
    return "Entity filtering is OFF, so this is the raw feed: stories about "
      + "other companies with similar names are included. Useful for checking "
      + "what the filter is excluding, and not much else.";
  }
  const who = o.entity ? `“${o.entity}”` : "this company";
  const parts = [
    `Headlines are filtered to ${who} — a story qualifies on an `
      + "exchange-qualified symbol, an ISIN, or every distinctive word of the "
      + "legal name.",
  ];
  if (o.dropped != null && o.dropped > 0) {
    parts.push(`${o.dropped} ${o.dropped === 1 ? "story was" : "stories were"} `
      + "dropped as being about a different company of a similar name. That is "
      + "why this list can be shorter than a plain search.");
  } else if (o.dropped === 0) {
    parts.push("Nothing was dropped as a namesake this time.");
  }
  parts.push("The filter errs towards excluding: a partial name match is not "
    + "enough, so a genuine story that only refers to the company loosely can "
    + "be missed. Turn the filter off to see the raw feed.");
  return parts.join(" ");
}

/** Label and tooltip for a match badge. */
export function matchLabel(m: MatchStrength): { label: string; hint: string } | null {
  switch (m) {
    case "exact":
      return { label: "symbol",
        hint: "Matched on an exchange-qualified symbol or an ISIN — the story "
          + "names this listing specifically." };
    case "name":
      return { label: "name",
        hint: "Matched on every distinctive word of the legal company name." };
    case "weak":
      return { label: "loose",
        hint: "A partial match only. Included because filtering is off; it may "
          + "be about a different company." };
    default:
      return null;
  }
}
