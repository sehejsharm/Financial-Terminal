/** The public copy may not say certain things.
 *
 *  WHY THIS EXISTS AS A TEST RATHER THAN A STYLE NOTE
 *
 *  Inside the app, honesty about data is ENFORCED in code: backend/dataplane
 *  refuses to label public data "live", never states a delay it did not apply,
 *  and marks a timestamp as estimated when it is our clock. A marketing page
 *  sits entirely outside that machinery — it is prose, and prose is where
 *  "live NSE quotes" reappears.
 *
 *  It already had. The ROOT META DESCRIPTION, shipped on every public page,
 *  claimed "live NSE quotes ... free and in your browser". Both had stopped
 *  being true — prices are public-source with uncontrolled lag, and there is
 *  now a paid tier. Nobody noticed because nobody on a team ever reads their
 *  own meta description.
 *
 *  The banned list is drawn from two places: the claims docs/COMPLIANCE.md
 *  says must be avoided while the SEBI registration question in §1.1 is open,
 *  and the data vocabulary docs/DATA-PLANE.md forbids inside the app.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFLICTS, MARKET_RISK, REGISTRATION_STATUS,
} from "@/lib/compliance";

const SRC = join(__dirname, "..", "..");

const PUBLIC_COPY = [
  "app/product/page.tsx",
  "app/layout.tsx",            // the root meta description
  "app/product/layout.tsx",
  "components/Disclaimer.tsx",
  "lib/compliance.ts",
];

/** Source with comments removed and whitespace flattened.
 *
 *  Comments are stripped because they explain WHY a phrase is banned and
 *  therefore contain it — scanning them would make this test impossible to
 *  document. Whitespace is flattened because JSX wraps prose across lines, so
 *  "not\n  registered" and "not registered" are the same sentence and only
 *  one of them matches a regex. */
function flatten(files: string[]): string {
  return files
    .map((f) => {
      try { return readFileSync(join(SRC, f), "utf8"); } catch { return ""; }
    })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    // Join JS string concatenation back into one sentence. Long copy is
    // written as "...licensed " + "real-time feed...", and leaving the seam in
    // splits a sentence in half — putting the negation in one fragment and the
    // phrase it negates in the other, which reads as an affirmative claim.
    .replace(/"\s*\+\s*"/g, "")
    .replace(/\s+/g, " ");
}

/** Words that turn a banned claim into a required disclosure.
 *
 *  This is the whole difficulty of the test. "We make recommendations" is
 *  forbidden; "we do not make recommendations" is MANDATORY, and both contain
 *  the word. So a banned phrase only counts when the sentence around it does
 *  not negate it.
 *
 *  It is a heuristic and it is a lint, not a lawyer: it would miss a negation
 *  phrased across two sentences, and it would clear "not only do we
 *  recommend". It catches the realistic regression, which is someone adding an
 *  enthusiastic sentence — and the phrases it guards are ones nobody writes
 *  accidentally in the affirmative. */
const NEGATORS = /\b(?:not|no|none|never|without|cannot|neither|nor|rather than)\b/i;

function offendingSentences(text: string, re: RegExp): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => re.test(sentence) && !NEGATORS.test(sentence));
}

/** Phrase -> why it is banned. The reason is in the failure message, because
 *  a bare "banned word found" teaches the next person nothing. */
const BANNED: Array<[RegExp, string]> = [
  // Advice and recommendation vocabulary. The product is not registered as a
  // Research Analyst or Investment Adviser; this is the vocabulary that would
  // most directly imply otherwise.
  [/\brecommendations?\b/i, "implies advice; the product makes none"],
  [/\binvestment advice\b/i, "the product explicitly does not give advice"],
  [/\badvis(?:er|or|ory)\b/i, "implies an advisory relationship"],
  [/\bbuy signal|sell signal|trade signals?\b/i, "alerts are user-configured conditions, not signals"],
  [/\bstock (?:tips?|picks?)\b/i, "implies recommendations"],
  [/\bmultibagger\b/i, "return promise"],
  [/\btarget price\b/i, "implies a recommendation"],
  [/\bbest stocks? to buy\b/i, "implies recommendations"],

  // Assured returns.
  [/\bguaranteed?\b/i, "no outcome is guaranteed"],
  [/\brisk[- ]free\b/i, "nothing here is risk-free"],
  [/\bsure[- ]shot\b/i, "return promise"],
  [/\bbeat the market\b/i, "performance claim"],
  [/\bdouble your money\b/i, "return promise"],

  // Registration and endorsement. docs/COMPLIANCE.md §1.1 is explicit that
  // holding ourselves out as registered when we are not is an offence.
  [/\bSEBI[- ](?:registered|approved|compliant)\b/i, "we are not registered"],
  [/\bexchange[- ]approved\b/i, "no such approval exists"],
  [/\bofficial NSE data\b/i, "the data is from NSE's PUBLIC website, not a licence"],
  [/\bpowered by NSE\b/i, "implies a licence we do not have"],
  [/\bNSE partner\b/i, "no such relationship"],

  // Upgrading the data claim. This is the one the app enforces internally and
  // a marketing page cannot.
  // An optional qualifier between the two words, because the phrase that
  // actually shipped in the root meta description was "live NSE quotes" —
  // and a regex demanding "live quotes" adjacently missed it when this test
  // was exercised against a deliberately bad page.
  [/\blive (?:\w+ )?(?:prices?|quotes?|feeds?|data)\b/i,
    "prices are public-source; the app never calls them live"],
  [/\breal[- ]time (?:\w+ )?(?:prices?|quotes?|data|feeds?)\b/i,
    "not a licensed real-time feed"],
  [/\btick[- ]by[- ]tick\b/i, "overstates the feed"],
  [/\bstreaming market data\b/i, "overstates the feed"],
  [/\binstitutional[- ]grade\b/i, "unsubstantiable"],

  // Superlatives and social proof.
  [/\bIndia's #?1\b/i, "unsubstantiable superlative"],
  [/\bmost (?:accurate|comprehensive)\b/i, "unsubstantiable superlative"],
  [/\baward[- ]winning\b/i, "no awards"],
  [/\btrusted by\b/i, "social proof we do not have"],
  [/\bused by (?:professionals|thousands)\b/i, "social proof we do not have"],

  // Comparative claims against named products.
  [/\b(?:unlike|better than|compared to) (?:Bloomberg|TradingView|Screener\.in|Tickertape)\b/i,
    "named-competitor comparison"],
];

describe("public marketing copy", () => {
  it("contains no banned claim", () => {
    const text = flatten(PUBLIC_COPY);
    const hits: string[] = [];
    for (const [re, why] of BANNED) {
      for (const sentence of offendingSentences(text, re)) {
        hits.push(`${why} -> "${sentence.trim().slice(0, 100)}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("states the market-risk warning verbatim", () => {
    // docs/COMPLIANCE.md §2.1: SEBI's wording, unparaphrased. Asserted
    // against the shared constant so a reworded copy fails here rather than
    // in an audit.
    const page = readFileSync(join(SRC, "app/product/page.tsx"), "utf8");
    expect(page).toContain("MARKET_RISK");
    expect(MARKET_RISK).toBe(
      "Investments in securities market are subject to market risks. "
      + "Read all the related documents carefully before investing.");
  });

  it("states the registration position and what the product is not", () => {
    const page = readFileSync(join(SRC, "app/product/page.tsx"), "utf8");
    expect(page).toContain("REGISTRATION_STATUS");
    expect(page).toContain("WHAT_THIS_IS_NOT");
    expect(REGISTRATION_STATUS).toMatch(/not registered/i);
  });

  it("carries no price", () => {
    // docs/COMPLIANCE.md §1.4: the figure is a placeholder with GST treatment
    // unresolved, and a published price is a representation to a consumer.
    expect(flatten(["app/product/page.tsx"]))
      .not.toMatch(/₹\s*\d|Rs\.?\s*\d|\bper month\b/i);
  });

  it("carries no performance figure", () => {
    // Including in alt text. A percentage on a markets landing page reads as
    // a return whatever it actually measures.
    const page = flatten(["app/product/page.tsx"]);
    expect(page).not.toMatch(/\b\d+(?:\.\d+)?\s?%/);
    expect(page).not.toMatch(/\bCAGR|Sharpe|win rate|drawdown of\b/i);
  });

  it("keeps the three statements of regulatory position in sync", () => {
    // The footer, /disclosures and this page all state it. Three copies of a
    // sentence drift, and the one that drifts is the one nobody reads until
    // it matters — so they share a constant, and these assert the other two
    // still agree with it.
    for (const [name, text] of [
      ["Disclaimer", flatten(["components/Disclaimer.tsx"])],
      ["disclosures", flatten(["app/disclosures/page.tsx"])],
    ]) {
      expect(text, `${name} should state the registration position`)
        .toMatch(/not registered with SEBI/i);
    }
    expect(CONFLICTS).toMatch(/subscriptions only/i);
  });
});
