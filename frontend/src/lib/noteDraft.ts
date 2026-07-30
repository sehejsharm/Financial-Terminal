/** Keeping a research note.
 *
 *  The notes screen had one save button and no autosave. Typing a thesis and
 *  then clicking to another function — which is what a terminal is for — threw
 *  the text away silently. That is the worst class of bug in a research tool:
 *  it loses the one thing on the screen the user actually made.
 *
 *  So: drafts persist locally the moment they change, the note is saved on a
 *  debounce, and a draft that is newer than the server copy is offered back
 *  rather than overwritten.
 *
 *  Pure functions plus localStorage, both testable. The stamping helper is
 *  here too because a decision log is only worth keeping if the price and date
 *  a view was formed at are recorded with it.
 */

const PREFIX = "mb:note-draft:";

export type Draft = {
  text: string;
  /** Epoch ms the draft was last touched. */
  at: number;
};

function key(ticker: string): string {
  return `${PREFIX}${ticker.toUpperCase()}`;
}

/** Persist a draft. A draft matching the saved copy is cleared instead of
 *  stored, so a clean note never resurfaces as a "recovered" one. */
export function saveDraft(ticker: string, text: string, saved: string,
                          now: number): void {
  try {
    if (text === saved) {
      localStorage.removeItem(key(ticker));
      return;
    }
    localStorage.setItem(key(ticker), JSON.stringify({ text, at: now }));
  } catch {
    // Private browsing, a full quota, or storage disabled. Losing the draft
    // is bad; taking the editor down with it is worse.
  }
}

export function loadDraft(ticker: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(ticker));
    if (!raw) return null;
    const d = JSON.parse(raw) as unknown;
    if (!d || typeof d !== "object") return null;
    const { text, at } = d as Partial<Draft>;
    if (typeof text !== "string" || typeof at !== "number") return null;
    return { text, at };
  } catch {
    return null;
  }
}

export function clearDraft(ticker: string): void {
  try { localStorage.removeItem(key(ticker)); } catch { /* see saveDraft */ }
}

/**
 * Whether a stored draft should be offered back to the user.
 *
 * Only when it differs from the server copy AND is newer than it. A draft older
 * than the saved note is from a session that has since been superseded —
 * offering it invites someone to restore stale text over good text, which is
 * the failure mode that makes recovery prompts untrustworthy.
 */
export function shouldRecover(draft: Draft | null, saved: string,
                              savedAt: string | null): boolean {
  if (!draft || draft.text === saved) return false;
  if (!savedAt) return true;
  const t = Date.parse(savedAt);
  if (!Number.isFinite(t)) return true;
  return draft.at > t;
}

/** Milliseconds of quiet before an autosave fires. Long enough that a
 *  paragraph is one save rather than forty, short enough that a distracted
 *  user loses at most a sentence. */
export const AUTOSAVE_MS = 2500;

export type Counts = { words: number; chars: number; lines: number };

export function counts(text: string): Counts {
  const trimmed = text.trim();
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    chars: text.length,
    lines: text ? text.split("\n").length : 0,
  };
}

/**
 * A dated, priced heading to write under.
 *
 * A research note whose entries aren't stamped is unreadable six months later:
 * "expensive here" means nothing without the price it was said at. This makes
 * the note a decision log rather than a scratchpad, and costs one click.
 */
export function stamp(text: string, opts: {
  date: string;
  price: number | null;
  currency: string;
}): string {
  const priced = opts.price != null && Number.isFinite(opts.price)
    ? ` · ${opts.currency}${opts.price.toLocaleString(undefined, {
        minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
  const heading = `## ${opts.date}${priced}`;
  // New entries go on top: the most recent view is the one being looked for,
  // and scrolling to the bottom of a year of notes to find it is friction.
  return text.trim() ? `${heading}\n\n\n${text}` : `${heading}\n\n`;
}
