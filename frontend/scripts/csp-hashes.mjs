#!/usr/bin/env node
/**
 * Collect the SHA-256 of every inline <script> in the prerendered HTML.
 *
 * WHY THIS EXISTS. script-src ships report-only because Next's App Router
 * emits RSC flight-data scripts inline — `self.__next_f.push([1,"0:[\"$\"...` —
 * and next.config.js records that there is "no stable hash for them". The
 * counter-claim in docs/OPEN-ITEMS.md §G is that because every page here is
 * statically prerendered, those scripts ARE fixed at build time and can
 * therefore be hashed by a post-build step.
 *
 * Exactly one of those is true, and the difference decides whether CSP can be
 * enforced on Next 14 at all. This script is the measurement: run it after a
 * build to get the hash set, build again, and compare. If the sets match, the
 * hashes are stable and enforcement is reachable. If they drift, they are not,
 * whatever the HTML looks like at a glance.
 *
 *   node scripts/csp-hashes.mjs            # print the hashes
 *   node scripts/csp-hashes.mjs --json     # machine-readable, for comparing
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// Prerendered output lives under .next/server/app. Next also writes HTML for
// error pages at the top of .next/server/pages.
const SEARCH = [".next/server/app", ".next/server/pages"];

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;                       // directory absent: nothing prerendered
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith(".html")) out.push(p);
  }
  return out;
}

// Deliberately a non-greedy match on a script tag with NO src attribute. A
// tag with src is an external script and is covered by 'self'; only inline
// bodies need a hash.
const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const files = SEARCH.flatMap((d) => walk(path.join(ROOT, d)));
const hashes = new Map();             // hash -> { count, sample, files:Set }

for (const f of files) {
  const html = readFileSync(f, "utf8");
  for (const m of html.matchAll(INLINE)) {
    const body = m[1];
    if (!body) continue;              // <script></script> needs no hash
    const h = "sha256-" + createHash("sha256").update(body, "utf8").digest("base64");
    const rec = hashes.get(h) || {
      count: 0, sample: body.replace(/\s+/g, " ").slice(0, 90), files: new Set(),
    };
    rec.count += 1;
    rec.files.add(path.relative(ROOT, f));
    hashes.set(h, rec);
  }
}

const sorted = [...hashes.entries()].sort(([a], [b]) => a.localeCompare(b));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    htmlFiles: files.length,
    distinctHashes: sorted.length,
    hashes: sorted.map(([h]) => h),
  }, null, 2));
} else {
  console.log(`${files.length} prerendered HTML file(s), `
    + `${sorted.length} distinct inline script(s)\n`);
  for (const [h, rec] of sorted) {
    console.log(`${h}  x${rec.count}`);
    console.log(`    ${rec.sample}`);
  }
}
