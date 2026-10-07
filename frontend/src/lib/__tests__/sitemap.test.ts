/** The sitemap must only advertise pages a crawler can actually read.
 *
 *  Measured before this existed: every route in the sitemap is an auth-gated
 *  client-rendered app page, and the prerendered HTML a crawler receives is
 *  the app CHROME — nav labels and a tooltip. "/" served 1396 characters of
 *  indexable text and none of it described the product; /terminal served 31.
 *
 *  So the sitemap was telling Google to index a dashboard shell as the
 *  product's front door, and robots.ts claimed "only the public marketing
 *  surface is crawlable" while no marketing surface existed at all.
 *
 *  The rule this encodes: a route belongs in the sitemap only if it renders
 *  real content without a session. That is checkable statically — a page that
 *  imports Shell is behind the auth gate — and it is the check that would have
 *  caught the original mistake.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..", "..", "app");

function sitemapRoutes(): string[] {
  const src = readFileSync(join(APP, "sitemap.ts"), "utf8");
  const block = src.match(/const ROUTES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("ROUTES array not found in sitemap.ts");
  return [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** A page behind the auth gate renders the Shell, which redirects without a
 *  session — so a crawler gets chrome and nothing else. */
function isAuthGated(route: string): boolean {
  const file = join(APP, route.replace(/^\//, ""), "page.tsx");
  const root = join(APP, "page.tsx");
  const path = route === "" ? root : file;
  if (!existsSync(path)) return false;
  return /from "@\/components\/Shell"/.test(readFileSync(path, "utf8"));
}

describe("sitemap", () => {
  it("lists no auth-gated routes", () => {
    // The defect: advertising app routes that render only chrome to a
    // crawler. Worse than omitting them, because the indexed description
    // becomes whatever tooltip prose happens to be in the shell.
    const gated = sitemapRoutes().filter(isAuthGated);
    expect(gated).toEqual([]);
  });

  it("lists every route that exists and is public", () => {
    // The other direction: a public page missing from the sitemap is a page
    // nobody finds. Checked so adding a public route forces a decision rather
    // than being silently unlisted.
    const listed = new Set(sitemapRoutes());
    const PUBLIC_BUT_INTENTIONALLY_UNLISTED = new Set([
      // Reached only from a one-time emailed link, and noindex for that
      // reason — indexing it would leak the token and burn its single use.
      "/set-password",
      // Needs a ticker in the query string to render anything.
      "/tearsheet",
    ]);
    const missing: string[] = [];
    for (const route of ["/login", "/privacy", "/terms", "/disclosures"]) {
      if (!listed.has(route) && !PUBLIC_BUT_INTENTIONALLY_UNLISTED.has(route)) {
        missing.push(route);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every listed route resolves to a real page", () => {
    // A sitemap entry for a route that does not exist is a 404 served to a
    // crawler on our own recommendation.
    const broken = sitemapRoutes().filter((r) => {
      const path = r === "" ? join(APP, "page.tsx")
        : join(APP, r.replace(/^\//, ""), "page.tsx");
      return !existsSync(path);
    });
    expect(broken).toEqual([]);
  });
});
