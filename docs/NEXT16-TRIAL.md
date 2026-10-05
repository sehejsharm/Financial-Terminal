# Next.js 16 upgrade trial

Run on a throwaway branch (`trial/next16`, commit `68cb797`, not pushed) and
reverted. Nothing in this trial has been merged.

**Bottom line: UPGRADE WITH TWO FIXES.** It is low risk — the app code needed
no changes at all — but it does *not* buy what we most wanted from it
(enforceable CSP), and it leaves two loose ends listed at the bottom. Since
both audit "criticals" were already measured as inapplicable to this app, there
is no urgency: this should land on its own, between phases, not mid-phase.

## Versions

| | Before | After |
|---|---|---|
| next | 14.2.35 | 16.3.8 |
| react | 18.3.1 | 19.3.0 |
| react-dom | 18.3.1 | 19.3.0 |
| eslint-config-next | 14.2.35 | 16.3.8 |
| eslint | 8.57.1 | 9.39.5 |

ESLint 9 is **forced**, not optional: `eslint-config-next@16` declares
`peer eslint@">=9.0.0"`, and the install fails outright without it. That makes
this a two-major upgrade, not one.

## What broke: nothing in the application

`npm run build` succeeded on the first attempt with **zero changes to any file
under `src/`**. The complete diff is three files:

- `package.json`, `package-lock.json` — versions.
- `tsconfig.json` — Next rewrote it itself on first build. One change is
  load-bearing (`"jsx": "preserve"` → `"react-jsx"`, which Next reports as
  mandatory); the rest is an added `.next/dev/types` include and reformatting.

`npx vitest run`: **1215 passed, 1 expected fail, 47 files — identical to the
baseline.** No test needed touching.

That includes the two suites that pin the Phase 1 performance work, which is
the result I was least confident about going in:

- `quoteStoreCoalesce.test.ts` — the 50 ms seed-coalescing window that turns
  41 tile subscriptions into one batched REST call.
- `useLiveTimeout.test.ts` — the poller deadline.

The Phase 1 fix depends on a subtle React behaviour (child effects commit
before parent effects). **It still holds under React 19.** Had it changed, the
request fan-out would have come back silently, and these tests are the only
thing that would have said so.

All 22 routes still build as `○ (Static)`.

## Dependency audit: the critical does clear

Measured with `npm audit --package-lock-only` against each lockfile, so this
is a like-for-like comparison:

| | 14.2.35 | 16.3.8 |
|---|---|---|
| critical | **1** | **0** |
| high | 13 | 10 |
| moderate | 3 | 3 |
| total | 17 | 13 |

The critical is `next` itself and it goes away. (Note for precision: npm
reports **one** critical advisory entry against `next`, not two — the two CVEs
we triaged are grouped under it.) Three highs also clear: `glob`, `js-yaml`,
`postcss`.

The **10 remaining highs are pre-existing and present on both versions** —
`braces`, `micromatch`, `fast-glob`, `brace-expansion`, `chokidar`,
`browserslist`, `nanoid`, `tailwindcss`, `@next/eslint-plugin-next`,
`eslint-config-next`. They are dev-tooling transitives, not shipped to the
browser. The upgrade does not make them worse and does not fix them.

## CSP: Next 16 does NOT unlock an enforced script-src

This was the main reason to want the upgrade, so it was tested directly rather
than reasoned about.

**The inline-script surface does shrink**, measured by grepping the built HTML:

| | inline `<script>` tags per page |
|---|---|
| 14.2.35 | 7 — our theme-boot + **6** `self.__next_f.push(...)` |
| 16.3.8 | 3 — our theme-boot + **2** `self.__next_f.push(...)` |

But the remaining two are still RSC flight-data whose contents vary per page,
so there is still no stable hash for them.

**The nonce experiment, and its result.** The blocker on 14 was that nonces
require middleware, which was understood to force every route to render
dynamically. On Next 16 that specific cost is gone — a `src/middleware.ts`
setting a per-request nonce built cleanly and **every route stayed `○
(Static)`**, with the middleware listed separately as `ƒ Proxy (Middleware)`.

That looked like the answer. It is not, and the reason is worth writing down:

```
$ curl -sI /login | grep -i content-security
content-security-policy: script-src 'self' 'nonce-ZDhjNTNkZDEt...' 'strict-dynamic'

$ curl -s /login | grep -c 'nonce='
0
```

The header carries a fresh nonce on every request. **The HTML contains no
nonce at all** — because what is served is the build-time static prerender,
and a file written at build time cannot contain a per-request value. So an
enforcing policy would match nothing and block all three inline scripts,
including our theme-boot. The app would break.

The trade-off is therefore unchanged in substance: nonces still require giving
up static prerendering. Next 16 moved where the cost shows up, not whether
there is one.

### The path that does exist (and is not Next-16-specific)

Worth recording because the nonce experiment surfaced it: **because these pages
are statically prerendered, the inline script contents are fixed at build
time.** They are not per-request at all. So the two `__next_f` scripts *can* be
hashed — just not in `next.config.js`, which runs before the build produces
them.

A post-build step could hash every inline script across all 23 prerendered
pages (~46 hashes; CSP accepts a list) and emit them into the served policy via
`vercel.json`. That would make `script-src` fully enforceable **with no
`unsafe-inline`, no nonce, and no loss of static rendering** — and it would
work on 14.2.35 today, without this upgrade. It is real engineering (a build
step plus a check that the hash list cannot silently go stale), not a
config flag, so I have not built it. But it is the route to an enforced CSP,
and it does not depend on this decision.

## Bundle size

Next 16 **removed the per-route "Size / First Load JS" table** from build
output, so the like-for-like comparison the baseline recorded is not available
from the build any more:

| | chunk files | total `static/chunks` |
|---|---|---|
| 14.2.35 | 56 | 1,869,918 bytes (`du -sh`: 2.1M) |
| 16.3.8 | 36 | `du -sh`: 2.0M |

I did not capture byte-exact totals for 16 before reverting, and `du -sh`
rounds while block overhead differs with file count. **So the honest reading is
that total shipped JS is unchanged within the precision of what I measured** —
not a win, not a regression. Claiming either would be reading more into those
two numbers than they support. Reproducing the per-route figures needs
`@next/bundle-analyzer` or equivalent.

Next 16 also **builds with Turbopack by default** (the served HTML references
`turbopack-*.js` chunks). That is a different bundler, not a tuned webpack, and
it is the single biggest unquantified change in this upgrade.

## Loose ends — what I did not finish

1. **`next lint` is gone.** On 14 the build ran ESLint and printed warnings; on
   16 it does not. The `"lint": "next lint"` script and `.eslintrc.json` need
   migrating to ESLint 9 flat config (`eslint.config.js`) with the ESLint CLI.
   I did not do this, and **I did not verify linting works at all on 16.**
2. **The Playwright request-count harness was not re-run.** The Phase 1
   acceptance numbers (6 requests to the API host, 1 call carrying 41 symbols,
   2 RSC prefetches, 41 tiles rendering) are verified here only by their unit
   tests, which is weaker evidence than the browser measurement. That harness
   needs the full local stack and should run against 16 before merging.
3. Turbopack output is unvalidated beyond "it builds and the tests pass".

## Recommendation

Merge it, but on its own, and do 1 and 2 above first. The case for it is the
cleared critical and a smaller inline-script surface; the case against urgency
is that both criticals were inapplicable here and the upgrade buys no CSP
improvement. It is not a prerequisite for any remaining phase.
