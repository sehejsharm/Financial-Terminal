// @vitest-environment jsdom

/** The two bits of display logic in the plan and session UI that can be wrong
 *  in a way a reader would not notice.
 *
 *  Both are pure functions deliberately exported for this: a device label that
 *  misreads a user agent, or an "unlimited" that renders as -1, is the kind of
 *  defect that looks like a typo in a screenshot and never gets reported.
 */

import { describe, expect, it } from "vitest";

import { describeDevice, planValue, relativeTime } from "@/lib/planDisplay";

const UNLIMITED = -1;

describe("entitlement values", () => {
  it("renders the unlimited sentinel as a word, never as -1", () => {
    // The thing a user must never see on a billing screen.
    expect(planValue(UNLIMITED, UNLIMITED)).toBe("Unlimited");
  });

  it("renders a real ceiling as the number", () => {
    expect(planValue(25, UNLIMITED)).toBe("25");
  });

  it("renders booleans as included or not", () => {
    expect(planValue(true, UNLIMITED)).toBe("Included");
    expect(planValue(false, UNLIMITED)).toBe("Not included");
  });

  it("does not mistake zero for unlimited", () => {
    // 0 and -1 are both falsy. A plan that grants none of something must not
    // read as granting infinite.
    expect(planValue(0, UNLIMITED)).toBe("0");
  });
});

describe("device labels", () => {
  it("names a desktop browser and its OS", () => {
    expect(describeDevice(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    )).toBe("Chrome on macOS");
  });

  it("identifies an iPhone", () => {
    expect(describeDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 "
      + "Safari/604.1",
    )).toBe("Safari on iOS");
  });

  it("identifies Android", () => {
    expect(describeDevice(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    )).toBe("Chrome on Android");
  });

  it("does not call Chrome 'Safari' because of the UA suffix", () => {
    // Every Chrome UA contains the word Safari. Order of checks is the whole
    // correctness of this function, and getting it wrong would label most
    // users' devices as the wrong browser on a security screen.
    const label = describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    );
    expect(label).toBe("Chrome on Windows");
  });

  it("does not call Edge 'Chrome'", () => {
    expect(describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
    )).toBe("Edge on Windows");
  });

  it("falls back to the raw string rather than guessing", () => {
    // A curl or a script is a real session someone may need to recognise.
    expect(describeDevice("curl/8.5.0")).toBe("curl/8.5.0");
  });

  it("handles an absent user agent", () => {
    expect(describeDevice("")).toBe("Unknown device");
  });
});

describe("relative times", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("says 'just now' for a session in use", () => {
    expect(relativeTime(now())).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(relativeTime(now() - 600)).toBe("10 min ago");
    expect(relativeTime(now() - 7200)).toBe("2 h ago");
    expect(relativeTime(now() - 86_400 * 3)).toBe("3 days ago");
  });

  it("says yesterday rather than '1 days ago'", () => {
    expect(relativeTime(now() - 86_400)).toBe("yesterday");
  });

  it("never shows a negative age for a clock slightly ahead", () => {
    // Server and browser clocks disagree by seconds routinely; "-3 min ago"
    // on a security screen reads as a bug in the product.
    expect(relativeTime(now() + 30)).toBe("just now");
  });
});
