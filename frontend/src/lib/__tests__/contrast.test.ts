/** Text must stay above the AA contrast threshold, on every theme.
 *
 *  WHY THIS IS A UNIT TEST AND NOT LEFT TO AXE. The e2e axe gate found four of
 *  these — `serious color-contrast` on /quant, /sharks and inside a workspace
 *  widget — but only in CI, and only there because the runner happened to
 *  fetch enough market data for the affected tables to render at all. On a
 *  machine with no providers the rows do not exist, so the gate cannot see
 *  them, and which rows render on any given CI run depends on what the
 *  upstream API felt like answering.
 *
 *  That makes axe the wrong instrument for this particular defect. It can only
 *  judge pixels that happened to be painted, and it only ever paints the
 *  DEFAULT theme — nothing in the suite exercises `html.light` or `html.cb`.
 *  The rule being broken, though, is a property of the SOURCE: an opacity
 *  modifier on a colour token. That can be checked exhaustively, on every
 *  push, with no browser and no data, across every file and every theme.
 *
 *  THE FIRST VERSION OF THIS TEST ONLY CHECKED `text-mut`, and CI immediately
 *  found a dimmed red it could not see. Hence the rewrite: every token,
 *  every theme, worst surface.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const CSS = readFileSync(join(SRC, "styles", "globals.css"), "utf8");

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

// ── the palettes, read out of the stylesheet that ships ───────────────────
//
// Parsed per selector block rather than by grepping the whole file, because
// `html.cb` redefines only green and red and must therefore be layered over a
// base rather than treated as a palette of its own. Read from globals.css
// rather than duplicated here so the test measures what ships: a hardcoded
// copy would keep passing after someone darkened a token.
function block(selector: string): Record<string, number[]> {
  const re = new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`);
  const m = CSS.match(re);
  if (!m) throw new Error(`no ${selector} block in globals.css`);
  const out: Record<string, number[]> = {};
  for (const d of m[1].matchAll(/--c-([a-z0-9]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    out[d[1]] = [Number(d[2]), Number(d[3]), Number(d[4])];
  }
  return out;
}

const DARK = block(":root");
const LIGHT = { ...DARK, ...block("html.light") };
const THEMES: Record<string, Record<string, number[]>> = {
  dark: DARK,
  light: LIGHT,
  // html.cb swaps the gain/loss pair on top of whichever theme is active.
  "dark+cb": { ...DARK, ...block("html.cb") },
  "light+cb": { ...LIGHT, ...block("html.light.cb") },
};

// Both panel surfaces, because text sits on both and which one is the WORSE
// case flips between themes: on dark, panel2 is the lighter of the two and so
// the lower contrast for light text; on light it is the darker one and so the
// lower contrast for dark text. Checking both removes the need to reason about
// it. `bg`/`bg2` are strictly kinder than panel2 on every theme here.
const SURFACES = ["panel", "panel2"];

// AA for text below 18.66px / not bold. Every site using these tokens is a
// table cell, a chip or a hint at 9.5-12px, so the large-text allowance of
// 3:1 never applies.
const AA_NORMAL = 4.5;

/** The worst ratio this token-at-this-opacity reaches on any theme/surface. */
function worst(tokenName: string, alpha: number): { r: number; where: string } {
  let r = Infinity, where = "";
  for (const [themeName, palette] of Object.entries(THEMES)) {
    const fg = palette[tokenName];
    if (!fg) continue;                    // not a palette token; skip
    for (const surface of SURFACES) {
      const bg = palette[surface];
      if (!bg) continue;
      const got = ratio(over(fg, alpha, bg), bg);
      if (got < r) { r = got; where = `${themeName}/${surface}`; }
    }
  }
  return { r, where };
}

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      out = out.concat(sourceFiles(p));
    } else if (/\.(tsx?|css)$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

describe("text contrast", () => {
  it("the palettes parsed out of globals.css are real", () => {
    // Guards the guard. If globals.css is restructured and a regex silently
    // matches nothing useful, every assertion below would pass vacuously.
    for (const [name, palette] of Object.entries(THEMES)) {
      for (const token of ["txt", "mut", "red", "green", "panel", "panel2"]) {
        expect(palette[token], `${name} is missing --c-${token}`)
          .toHaveLength(3);
      }
      // Body text at full strength must pass on every theme, or something is
      // wrong with the parse rather than with the app.
      expect(worst("txt", 1).r).toBeGreaterThan(AA_NORMAL);
    }
  });

  it("records where each token's threshold falls", () => {
    // The measurement, asserted rather than left as a comment to trust. These
    // are why the fixes were "use the full token" and not "nudge the opacity":
    // for red and mut there is NO passing value below 90%.
    expect(worst("mut", 0.8).r).toBeLessThan(AA_NORMAL);
    expect(worst("red", 0.8).r).toBeLessThan(AA_NORMAL);
    expect(worst("mut", 1).r).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(worst("red", 1).r).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("no source file uses an opacity that fails AA on any theme", () => {
    // The actual gate. Finds every `text-<token>/<NN>` utility (including the
    // placeholder: and dark: variants, which share the suffix) and computes
    // the worst case across all four themes and both panel surfaces.
    //
    // A plain text scan, not a parse. That means it also matches the pattern
    // inside a COMMENT, and that is the direction to be wrong in: it can never
    // miss a real usage, and the cost of a false positive is rewording a
    // comment. Parsing TSX to find class strings would be a far larger thing
    // to maintain than the rule it protects.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/text-([a-z0-9]+)\/(\d{1,3})\b/g)) {
        const [, tokenName, pct] = m;
        if (!DARK[tokenName] && !LIGHT[tokenName]) continue;  // not a palette token
        const { r, where } = worst(tokenName, Number(pct) / 100);
        if (r < AA_NORMAL) {
          offenders.push(`${file.slice(SRC.length + 1)}: text-${tokenName}/${pct}`
            + ` is ${r.toFixed(2)}:1 on ${where}, needs ${AA_NORMAL}:1`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the dimmed/undimmed distinction survives being made legible", () => {
    // The thing worth protecting. Several sites dim a figure to mean "too
    // small to call" or "the fit is too weak to support this slope", and that
    // meaning is carried by the CONTRAST BETWEEN the two states — not by the
    // dim one being hard to read. Full mut against full txt is still better
    // than a 2x luminance gap, so nothing was lost by fixing the contrast.
    expect(ratio(DARK.txt, DARK.panel) / ratio(DARK.mut, DARK.panel))
      .toBeGreaterThan(2);
  });
});
