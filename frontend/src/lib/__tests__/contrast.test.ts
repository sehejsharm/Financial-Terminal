/** Muted text must stay above the AA contrast threshold.
 *
 *  WHY THIS IS A UNIT TEST AND NOT LEFT TO AXE. The e2e axe gate found three
 *  of these — `serious color-contrast` on /quant and /sharks — but only in CI,
 *  and only there because the runner happened to fetch enough market data for
 *  the affected tables to render. On a machine with no providers the rows do
 *  not exist, so the gate cannot see them, and which rows render on any given
 *  CI run depends on what the upstream API felt like answering.
 *
 *  That makes axe the wrong instrument for this particular defect: it can only
 *  judge pixels that happened to be painted. The rule being broken, though, is
 *  a property of the SOURCE — an opacity modifier on a colour token — and can
 *  be checked exhaustively, deterministically, on every push, with no browser
 *  and no data.
 *
 *  So this computes the real WCAG ratio from the real palette tokens and fails
 *  on any usage below the threshold. It covers files the e2e routes never
 *  reach, which is most of them.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const CSS = join(SRC, "styles", "globals.css");

// ── WCAG 2.1 relative luminance and contrast ratio ────────────────────────
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: number[]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(fg: number[], bg: number[]): number {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/** `fg` at `alpha` composited over an opaque `bg` — what an opacity modifier
 *  actually produces, and the step that makes these ratios non-obvious. */
function over(fg: number[], alpha: number, bg: number[]): number[] {
  return fg.map((f, i) => alpha * f + (1 - alpha) * bg[i]);
}

/** Read an `--c-NAME: r g b;` token out of globals.css.
 *
 *  From the stylesheet rather than duplicated here, so the test is measuring
 *  the palette the app actually ships. A hardcoded copy would keep passing
 *  after someone darkened a token.
 */
function token(name: string, which = 0): number[] {
  const css = readFileSync(CSS, "utf8");
  const all = [...css.matchAll(
    new RegExp(`--c-${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, "g"))];
  if (!all.length) throw new Error(`--c-${name} not found in globals.css`);
  const m = all[Math.min(which, all.length - 1)];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// The first declaration of each is the DARK theme, which is the default and
// the one every e2e violation was reported against.
const MUT = token("mut");
const PANEL = token("panel");

// AA for text below 18.66px / not bold. Every site using these tokens is a
// table cell or a hint at 9.5-12px, so the large-text allowance of 3:1 never
// applies here.
const AA_NORMAL = 4.5;

function tsxFiles(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      out = out.concat(tsxFiles(p));
    } else if (p.endsWith(".tsx") || p.endsWith(".ts") || p.endsWith(".css")) {
      out.push(p);
    }
  }
  return out;
}

describe("muted-text contrast", () => {
  it("the palette's own numbers are what this test thinks they are", () => {
    // Guards the guard. If globals.css is restructured and the regex silently
    // matches nothing useful, every assertion below would pass vacuously.
    expect(MUT).toHaveLength(3);
    expect(PANEL).toHaveLength(3);
    expect(ratio(MUT, PANEL)).toBeGreaterThan(AA_NORMAL);
  });

  it("records where the threshold actually falls", () => {
    // The measurement, asserted so it is not just a comment someone has to
    // trust: 50/60/70/80 all fail, and 85 is the first passing step. This is
    // why the fix was "use the full token", not "nudge the opacity".
    const at = (a: number) => ratio(over(MUT, a, PANEL), PANEL);
    expect(at(0.5)).toBeLessThan(AA_NORMAL);
    expect(at(0.6)).toBeLessThan(AA_NORMAL);
    expect(at(0.7)).toBeLessThan(AA_NORMAL);
    expect(at(0.8)).toBeLessThan(AA_NORMAL);
    expect(at(0.85)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(at(1)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("no source file uses a muted opacity that fails AA", () => {
    // The actual gate. Scans for Tailwind's muted-opacity utility (and its
    // placeholder: variant) and computes each occurrence.
    //
    // A plain text scan, not a parse. That means it also matches the pattern
    // inside a COMMENT, and that is the direction to be wrong in: it can
    // never miss a real usage, and the cost of a false positive is rewording
    // a comment. Parsing TSX to find class strings would be a far larger
    // thing to maintain than the rule it protects.
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/text-mut\/(\d{1,3})\b/g)) {
        const alpha = Number(m[1]) / 100;
        const got = ratio(over(MUT, alpha, PANEL), PANEL);
        if (got < AA_NORMAL) {
          offenders.push(`${file.slice(SRC.length + 1)}: text-mut/${m[1]}`
            + ` is ${got.toFixed(2)}:1, needs ${AA_NORMAL}:1`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the dimmed/undimmed distinction survives being made legible", () => {
    // The thing worth protecting. These sites dim a figure to mean "too small
    // to call" or "the two sides nearly cancel", and that meaning is carried
    // by the CONTRAST BETWEEN the two states, not by the dim one being hard to
    // read. Full mut against text-txt is still better than a 2x luminance
    // gap, so nothing was lost by fixing the contrast.
    const TXT = token("txt");
    expect(ratio(TXT, PANEL) / ratio(MUT, PANEL)).toBeGreaterThan(2);
  });
});
