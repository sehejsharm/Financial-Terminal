/** The CSP script hash must match the inline theme-boot script.
 *
 *  next.config.js allows exactly one inline script, by SHA-256 of its bytes.
 *  If someone edits THEME_BOOT in src/app/layout.tsx and does not recompute
 *  the hash, the browser silently refuses to run it — and the only symptom is
 *  a theme flash on every page load, which looks like a CSS bug and gets
 *  chased in entirely the wrong place.
 *
 *  So the two are pinned together here. This test failing means: recompute the
 *  hash, do not weaken the policy.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

function themeBootBody(): string {
  const src = readFileSync(join(ROOT, "src", "app", "layout.tsx"), "utf8");
  const m = src.match(/const THEME_BOOT = `(.*?)`;/s);
  if (!m) throw new Error("THEME_BOOT not found in layout.tsx");
  return m[1];
}

function configuredHash(): string {
  const cfg = readFileSync(join(ROOT, "next.config.js"), "utf8");
  const m = cfg.match(/'sha256-([A-Za-z0-9+/=]+)'/);
  if (!m) throw new Error("no sha256 hash found in next.config.js");
  return m[1];
}

describe("CSP inline-script hash", () => {
  it("matches the theme-boot script byte for byte", () => {
    const actual = createHash("sha256").update(themeBootBody()).digest("base64");
    expect(actual).toBe(configuredHash());
  });

  it("the policy does not allow unsafe-inline for scripts", () => {
    // The hash exists precisely so this never has to be true. Inline style is
    // allowed and is a different matter — style cannot execute.
    const cfg = readFileSync(join(ROOT, "next.config.js"), "utf8");
    const scriptSrc = cfg.match(/"script-src[^"]*"/)?.[0] ?? "";
    expect(scriptSrc).not.toMatch(/unsafe-inline/);
    expect(scriptSrc).not.toMatch(/unsafe-eval/);
  });

  it("connect-src includes the API host and its websocket origin", () => {
    // Getting this wrong does not degrade the app, it stops it: every quote,
    // every panel and the live socket all go to that origin.
    const cfg = readFileSync(join(ROOT, "next.config.js"), "utf8");
    expect(cfg).toMatch(/connect-src 'self' \$\{API\} \$\{WS\}/);
    expect(cfg).toMatch(/const WS = API\.replace\(\/\^http\/, "ws"\)/);
  });

  it("ships report-only until CSP_ENFORCE is set", () => {
    // A CSP that blocks something the app needs looks, to a user, exactly
    // like the app being broken.
    const cfg = readFileSync(join(ROOT, "next.config.js"), "utf8");
    expect(cfg).toMatch(/Content-Security-Policy-Report-Only/);
    expect(cfg).toMatch(/CSP_ENFORCE/);
  });
});
