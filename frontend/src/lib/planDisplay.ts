/** Display helpers for the plan and session screens.
 *
 *  In their own module, not inline in the components, because they are pure
 *  and worth testing: a device label that misreads a user agent, or an
 *  "unlimited" that renders as -1, looks like a typo in a screenshot and never
 *  gets reported as a bug.
 */

/** An entitlement value, in words.
 *
 *  `unlimited` is passed in rather than hardcoded as -1 so this cannot
 *  disagree with the server about which sentinel means "no ceiling".
 */
export function planValue(value: boolean | number, unlimited: number): string {
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  // Compared explicitly, not by falsiness: 0 and -1 are both falsy, and a
  // plan granting NONE of something must not read as granting infinite.
  return value === unlimited ? "Unlimited" : String(value);
}

/** "Chrome on Windows" from a user-agent string.
 *
 *  Crude on purpose: the goal is recognition, not accuracy. Someone needs to
 *  tell their own laptop from a device they have never used, and a full UA
 *  string is unreadable while a parsing library is tens of kilobytes to render
 *  two words.
 *
 *  CHECK ORDER IS THE CORRECTNESS. Every Chrome UA contains "Safari", and
 *  every Edge UA contains "Chrome", so the specific brands must be tested
 *  before the generic ones — otherwise most users' devices get the wrong
 *  browser printed next to them on a security screen.
 */
export function describeDevice(ua: string): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) && /Version\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : null;
  const os =
    /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  // A curl or a script is a real session someone may need to recognise, so
  // show what we have rather than inventing a label for it.
  return ua.slice(0, 40);
}

/** "10 min ago". Clamped at zero: server and browser clocks disagree by
 *  seconds routinely, and "-3 min ago" on a security screen reads as a bug in
 *  the product rather than in the clock. */
export function relativeTime(epochSeconds: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 90) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The one-phrase description of where a price came from.
 *
 *  Mirrors backend/dataplane.label, and deliberately makes no claim the
 *  server would not: public data is never called "real-time" because nobody
 *  knows NSE's or Twelve Data's actual lag, and a delay is only named when
 *  one was actually applied.
 *
 *  Returns null when there is nothing honest to say — the stream's compact
 *  deltas carry no provenance, and a label that defaulted to "Live" on absent
 *  data would be the one claim most worth getting right.
 */
export function dataSourceLabel(q: {
  tier?: string;
  source_class?: string;
  delayed_by_seconds?: number;
}): string | null {
  if (!q.source_class) return null;
  if (q.delayed_by_seconds) {
    const mins = Math.max(1, Math.round(q.delayed_by_seconds / 60));
    return `Delayed ${mins} min`;
  }
  if (q.source_class === "licensed") {
    return q.tier === "realtime" ? "Live" : "Delayed";
  }
  return "Public data";
}
