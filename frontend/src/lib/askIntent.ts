/** Does palette input read as a question for the AI, or as a ticker lookup?
 *
 *  Kept pure and separate from the component so it can be unit-tested: this
 *  predicate decides whether Enter searches or asks, and being too eager is
 *  the expensive failure — it hijacks the palette's primary job. So the rule
 *  is deliberately narrow: an explicit "ask " prefix, a trailing "?", or a
 *  multi-word phrase opening with a question word. Nothing else counts.
 */

const QUESTION_WORDS = new Set([
  "what", "why", "how", "which", "when", "where", "who", "is", "are", "do",
  "does", "should", "can", "am", "will", "would",
]);

export function looksLikeQuestion(q: string): boolean {
  const s = (q || "").trim();
  if (s.length < 6) return false;
  if (/^ask\s+/i.test(s)) return true;
  if (s.endsWith("?")) return true;
  const words = s.split(/\s+/);
  return words.length >= 3 && QUESTION_WORDS.has(words[0].toLowerCase());
}

/** Strip a leading "ask " so the model never sees the command word. */
export function stripAskPrefix(q: string): string {
  return (q || "").trim().replace(/^ask\s+/i, "").trim();
}
