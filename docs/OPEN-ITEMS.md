# Open items after Phases 0–10

Audited against the repo on 2026-10-09, not reconstructed from memory — several
things I had previously flagged as open were closed in later phases, and two
things nobody had flagged turned out to be open.

Ordered by what I think the risk actually is, which is not the order the phases
ran in.

---

## STATUS, 2026-10-13 — what has since been closed

§A, §B and most of §G are done. The sections below are kept as written rather
than deleted, because the reasoning in them is the record of why each thing
mattered, and a closed item with its argument intact is more useful than a
missing one. **Where a section is now wrong, it says so inline.**

| | |
|---|---|
| **§A — all six numeric defects** | Fixed. `tests/invariants` is 36 passed, **zero xfails** — the whole ledger is cleared. Beta is now computed here (`lib/beta.py`, OLS against ^NSEI/^BSESN, refusing rather than guessing) instead of taken from a vendor regressing an NSE listing against the S&P. |
| **§B1 — the NaN 500** | Fixed centrally, not per router: `SafeJSONResponse` as the app's `default_response_class`, so a route *cannot* emit NaN. The five routers that were missing the guard are why it is central. |
| **§B2 — the a11y violation in the degraded state** | Fixed, and it was **five** violations, not one. One was Next's dev overlay being scanned by axe (a false positive causing a real red build); four were real and only appeared when data loaded — a critical unnamed `<select>` on /news, contrast failures on /quant and /sharks measured at 2.39:1 and 2.92:1 against a 4.5:1 requirement, and a horizontally-scrolling financials panel a keyboard could not scroll. |
| **§G — the e2e suite's "three provider-dependent specs"** | **That diagnosis was wrong.** The CI log said 196 passed / 2 failed / 2 flaky, and not one of the four was a provider outage. All 28 spec files signed in as the *same* account, so they shared one user's portfolios, workspaces and alerts. Per-spec accounts now, derived from the filename, with no spec file changed. CI went to 200 passed / 0 flaky. |
| **§G — unlocked user-store writes** | Fixed. Measured first: 8 of 8 concurrent `create_user` calls returned "created" and **1 account survived**. `tests/test_user_store_concurrency.py` fails without the lock. |
| **§G — no backup** | `deploy/backup.sh` + `restore.sh`, 29 tests in CI, a daily timer, and an install-time self-test that proves the round trip on the host. Mutation-checked: with the checksum gate removed, restoring a *truncated* archive exits 0 and replaces live data with a partial payload. **Off-host is still one env var away — see §D.** |
| **§G — the unthrottled WebSocket handshake** | Fixed. `BaseHTTPMiddleware` never sees a WS upgrade, so the handshake asks for its own ceiling before the token is decoded. |
| **§G — CSP `script-src` report-only** | See §H below. The claimed enforcement path is **ruled out, measured** — and the report-only posture turned out to be reporting to nobody, which is now fixed. |

Still open and unchanged: **§C in full** (the SEBI question, the grievance
address, the legal review, GST), **§D** (one command on the VM, plus exercising
the rollback), **§E** (vendor decisions), **§F** (claims needing a real
deployment, a real phone or a real person with a screen reader).

`docs/HANDOFF-TO-YOU.md` is the list of what needs you rather than me, with a
Claude-in-Chrome prompt for each browser task and a shell runbook for each VM
one.

---

## A. Correctness defects in displayed financial figures

> **CLOSED, 2026-10-13.** All six are fixed and every `xfail` is gone. Kept
> below because the mechanisms are worth remembering — particularly #11, where
> six NIFTY constituents reading as uncorrelated with their own market was the
> tell that the regression was against the wrong index.

**These were the surprise.** They live in the `xfail` ledger in
`tests/invariants/` — strict markers, so each one is a test that documents a
real defect and will fail loudly if someone "fixes" it by accident. They
predate the ten-phase brief and **were never in its scope**, so nine phases of
security, billing and release work went past them.

They are, on the merits, more serious than most of what those phases fixed: a
wrong number on a screen is the thing this product exists to get right.

Run `pytest tests/invariants -rxX` to see them.

| # | Defect | Where |
|---|---|---|
| 11 | **Beta is a provider passthrough regressed against the wrong index.** Observed betas of 0.0, 0.11, 0.15, 0.17 for RELIANCE, TCS, INFY, ITC, HCLTECH, BHARTIARTL — implausible for large-cap Indian equities against the Nifty, which is the tell that the regression is against something else. | `test_inv_risk.py::TestBetaRange` |
| 12 | **`beta or 1.0` turns a beta of exactly 0.0 into 1.0.** A falsy-coercion bug, so the one case where the value is genuinely zero is silently replaced by the market beta. Feeds cost of equity. | `test_inv_risk.py::TestCostOfEquity` |
| 14 | **USD revenue divided by 1e7 and labelled "Cr".** A US reporter's figures get the Indian crore scaling applied and the crore label attached. | `test_inv_units.py::TestCurrencyScale` |
| 14 | **A converted figure does not declare its currency.** So a number that has been through an FX conversion is indistinguishable from one that has not. | `test_inv_units.py::TestCurrencyScale` |
| 14/32 | **Metric rows carry no currency field at all.** The xfail's own comment says "remove this xfail when Phase 1.3 lands" — **Phase 1.3 never landed.** It was part of the earlier hardening plan, not the SaaS brief, and got dropped when the brief changed. | `test_inv_units.py::TestNoBareInheritedSymbol` |
| 15 | **`pct()` multiplies a value that is already a percentage by 100.** Dividend yield is scaled twice, so 1.2% shows as 120%. | `test_inv_units.py::TestPercentUnits` |

**My recommendation: this is the next body of work, ahead of anything else
below.** Defect 15 and defect 14's crore mislabelling are the kind a user
notices and loses trust over; defects 11 and 12 feed WACC and cost-of-equity,
which feed valuation.

---

## B. Real bugs found by CI, not yet fixed

> **CLOSED, 2026-10-13.** Both fixed. §B2 turned out to be five violations
> rather than one, and one of those five was axe scanning Next's own
> development error overlay — a false positive that had been producing a real
> red build and was indistinguishable at a glance from an app defect.

Both surfaced on the first e2e run in CI (`197 passed, 3 failed`) and both pass
locally, which is why they had not been seen.

### B1. A provider gap becomes a 500

```
ValueError: Out of range float values are not JSON compliant: nan
  at starlette/responses.py → json.dumps
```

A route returned `NaN`, so `JSONResponse` raised and the endpoint 500'd.

`backend/serialize.py` **already has the guard** (NaN/inf → `None`, line 29).
It is applied inconsistently:

| Has the guard | Does **not** |
|---|---|
| `deals`, `fundamentals`, `macro`, `options` | **`screens`, `market`, `portfolio`, `value_chain`, `ai`** |

`portfolio` is the one that worries me most: it computes weights and P&L, which
are exactly where a missing price or a zero denominator produces `NaN` — and it
is a core daily surface. The failure also happens precisely when providers are
flaky, which is when a user most needs a graceful answer rather than a 500.

### B2. An accessibility violation in the degraded state

`a11y.spec.ts › every signed-in route has no violations` passes locally, where
data loads, and fails in CI, where pages render error and empty states. That is
arguably the more important case — it is what users see when something is
wrong — and it means the axe gate currently only covers the happy path.

---

## C. Blocks launch, and is yours rather than mine

### C1. SEBI classification (BLOCKING)
Whether this is a Research Analyst or an Investment Adviser decides whether
registration is mandatory. I am not qualified to answer it; `docs/COMPLIANCE.md`
§1.1 sets out both readings. The software takes the conservative position
("not registered") everywhere.

**If the answer is "registration required", the AI panel is the first surface
to re-examine** — gating or restricting it is far cheaper than registering.

### C2. `NEXT_PUBLIC_GRIEVANCE_EMAIL`
Defaults to a `.invalid` address and now governs **three indexed pages**
(`/disclosures`, `/privacy`, `/terms`). A page that says an address is monitored
while it bounces is worse than not offering one.

### C3. Terms and privacy have never been read by a lawyer
Written as engineering documents. DPDP Act 2023 obligations are not
systematically mapped (§1.3).

### C4. Pricing and tax
₹499 is a placeholder; GST registration and inclusive/exclusive treatment are
unresolved, and invoices will need GSTIN, place of supply and HSN/SAC (§1.4).
The landing page deliberately carries **no price** because of this.

---

## D. One command, on the VM

**The Phase 10 deploy safety work is not active.** `install-autodeploy.sh`
*copies* the script to `/usr/local/bin/mb-autodeploy` and systemd runs the
copy; nothing refreshes it. So the health gate, the rollback and the commit-SHA
version stamping are all inert:

```bash
cd ~/Financial-Terminal && sudo bash deploy/install-autodeploy.sh
```

Until then `/version` reports `unstamped` (harmless — `docker-compose.yml` now
reads `APP_VERSION` from the environment and the old script does not set it).

**Before relying on the rollback, exercise it deliberately** — it has never
been executed, because there is no Docker in the environment it was written in.
`docs/RELEASE.md` has the three commands.

---

## E. Deferred by instruction — waiting on a decision, not on work

| Item | State |
|---|---|
| **Market-data vendor** | `backend/feeds/` has the `RealtimeFeed` protocol and an empty registry. `docs/DATA-PLANE.md` is the runbook: one file, one registry line, one env var. The delayed plane and the leak-prevention are built and tested. |
| **Payment provider** | Plans, entitlements and server-side enforcement are done. Checkout is deliberately *absent* rather than stubbed, because its shape differs between Razorpay and Stripe. Plans are set by an admin endpoint, which is how the first paying users get onboarded anyway. |
| **Transactional email** | Resend adapter written behind a swappable interface; default is `console`, which logs the link and sends nothing. **A deploy left on `console` creates accounts whose owners never receive an invite.** |
| **Next 16** | Trialled on `trial/next16` (local, unpushed), written up in `docs/NEXT16-TRIAL.md`. Not merged. Needs the ESLint 9 flat-config migration first (`next lint` is gone in 16 and I never verified linting works there), and the Playwright request-count harness re-run. |
| **Apex vs subdomain** | Landing page is at `/product`; `/` is still the app. Proper launch config is apex = marketing, app on a subdomain or an edge rewrite. Needs a real domain. |

---

## F. Verification owed — claims I could not test from here

| Claim | Why not |
|---|---|
| **Production p50/p95 per endpoint** | `docs/BASELINE.md` §6 still owes these. The sandbox cannot reach the API host. |
| **Phase 1's p95 quote latency < 800 ms** | Same. The Phase 1 win (105→32 requests, 40→1 bulk calls) *is* verified, locally and by unit tests. |
| **`/global` ≥18/20 tiles priced** | Needs real providers. |
| **Lighthouse scores** | Needs a deployed URL. |
| **Screen-reader behaviour** | Everything in `docs/ACCESSIBILITY.md` is Chromium plus axe. NVDA, JAWS and VoiceOver each behave differently and none has seen this app. **The largest accessibility gap, and it needs a person, not another test.** |
| **The deploy rollback** | See §D. |
| **`100vh` → `dvh`** | Correct by reasoning; Playwright has no collapsing browser chrome, so no test here can tell the two apart. Needs a real phone. |

---

## H. CSP: the enforcement path, ruled out with evidence

Added 2026-10-13, replacing §G's claim that this did not need Next 16.

**The claim was: "the pages are statically prerendered, so the `__next_f`
inline scripts are fixed at build time and can be hashed by a post-build step
(~46 hashes)."** It sounds right. `frontend/scripts/csp-hashes.mjs` is now in
the repo and measures it:

> Two **clean builds of identical source** each produced 23 prerendered HTML
> files containing 68 distinct inline scripts — and roughly half the hashes
> differ between the two builds, with not a line of source edited. The
> flight-data payloads embed per-build identifiers.

So a hash list is valid for exactly one build, and every deploy is a fresh
build. Shipping it would give a policy that is correct the day it is generated
and silently blocks the app's own hydration on the next deploy — which is the
worst available failure shape, because it looks like it is working. The
re-check after the Next 16 upgrade is three commands, in `next.config.js`.

**Separately, and worse: report-only was reporting to nobody.** There was no
`report-uri`, no `report-to` and no endpoint anywhere in the repo, so every
violation went to the console of whoever had devtools open. A report-only
policy with no collector is not a weaker control than an enforced one — it is
not a control at all, while still reading as one on an audit checklist.

`backend/routes/csp.py` collects them now (aggregated, capped, query strings
stripped, always 204), and `GET /api/v1/csp-report/summary` (master-admin) is
the list that decides when `CSP_ENFORCE=1` is safe: flip it when every
signature there has been hashed or allowed. That replaces the current
prerequisite, which was a hand-count of 42 violations taken in a browser on one
day against six routes.

---

## I. Getting off JSON files

`docs/DATASTORE-MIGRATION.md`, added 2026-10-13: a concrete Postgres schema,
the cutover, and the hosting trap, written against the stores that actually
exist.

The finding worth repeating here: **`backend/storage/__init__.py` already
defines a `Storage` interface**, so eight of the thirteen stores can move
behind a `PostgresStore` with no caller changes. **Five bypass it** — users,
sessions, invites, usage and grievances — and those five hold authentication,
authorisation and the billing meter. The work is to move those onto the
interface *while they are still JSON*, so the cutover is one implementation
swap rather than six simultaneous rewrites.

Also found while writing it, and not previously recorded:
`entitlements.meter()` reads the counter, decides, and then charges, with no
lock across the pair — so two concurrent requests at the limit boundary are
both allowed. A rounding error at today's limits on a single worker, but it is
the paid-plan meter, and `INSERT … ON CONFLICT … RETURNING n` makes it exact
for free.

---

## G. Smaller, real, and recorded

> **PARTLY CLOSED, 2026-10-13.** The e2e isolation, the unlocked user-store
> writes, the missing backup and the unthrottled WebSocket handshake are all
> done — see the status table at the top. The rest of this list stands.

- **The e2e suite is not blocking in CI.** Three specs depend on live providers
  and fail in CI; they pass in isolation and fail in sequence against a shared
  data directory. Fixing it means a per-spec data directory or a stubbed
  provider layer. Until then an accessibility or behavioural regression is
  *visible* but will not stop a merge.
- **Grievances have no SLA timer, admin queue or ageing reminder.** They land in
  `data/grievances.json` and an email. Somebody has to actually read them;
  nothing enforces the 7-working-day reply the page promises.
- **The WebSocket handshake is unthrottled.** `BaseHTTPMiddleware` never runs for
  a WS upgrade, so the rate limiter does not apply to `/api/v1/stream`. Noted in
  `backend/ratelimit.py`.
- **CSP `script-src` is report-only.** The enforceable path exists and does not
  need Next 16: the pages are statically prerendered, so the `__next_f` inline
  scripts are fixed at build time and *can* be hashed by a post-build step
  (~46 hashes). Real work, not a flag. See `docs/NEXT16-TRIAL.md`.
- **No staging environment.** A push is a deploy, of both halves.
- **No metrics time series, no alerting** beyond the 15-minute healthcheck going
  red, and **no error aggregation unless `SENTRY_DSN` is set.**
- **Charts have a label, not parity.** `role="img"` plus a name; no data-table
  alternative.
- **10 "high" dependency advisories** remain, all dev-tooling transitives
  present on both Next 14 and 16. The audit job is advisory, not blocking.
- **The admin password that appeared in chat early on has still not been
  rotated**, as far as I know.

---

## What I would do next, in order

Rewritten 2026-10-13. Items 1, 2 and 5 of the original list are done; what is
left is almost entirely yours rather than mine, which is the actual headline.

1. **§C2 — set the grievance address.** One env var, two minutes, and it
   governs three *indexed* pages that currently print a `.invalid` address
   while telling the reader it is monitored. Highest value per unit of effort
   on this list by a wide margin. Prompt A1 in `docs/HANDOFF-TO-YOU.md`.
2. **§D — run one command on the VM**, then exercise the rollback once. The
   health gate, the rollback and the version stamping are all written and all
   inert until `install-autodeploy.sh` is re-run, and the first real test of a
   rollback should not be your first genuinely broken deploy. Runbooks B1/B2.
3. **§G — set the off-host backup destination.** One line in
   `/etc/motherboard-backup.env`. Until it is set, every snapshot lives on the
   same volume as the data it protects, so it survives `rm -rf data/` and a bad
   deploy but not losing the instance — which is the failure a backup is for.
4. **§C1 — get the SEBI question answered.** Blocking for launch, and a
   lawyer's call rather than mine. Prompt A3.
5. **§E — the two vendor decisions** (market data, payments). Both are built up
   to the vendor boundary and waiting on a name.
6. **§F — the screen-reader gap.** Everything in `docs/ACCESSIBILITY.md` is
   Chromium plus axe. NVDA, JAWS and VoiceOver each behave differently and none
   has seen this app. It needs a person, not another test — and it is the
   largest remaining accessibility gap.

Then, and only when a business event calls for it rather than because the
diagram looks nicer: **§I**, getting off JSON files. The trigger is the first
of a second process, a customer asking about recovery objectives, or a query
nobody can answer — not a code smell.
