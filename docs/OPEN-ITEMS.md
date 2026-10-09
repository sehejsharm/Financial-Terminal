# Open items after Phases 0–10

Audited against the repo on 2026-10-09, not reconstructed from memory — several
things I had previously flagged as open were closed in later phases, and two
things nobody had flagged turned out to be open.

Ordered by what I think the risk actually is, which is not the order the phases
ran in.

---

## A. Correctness defects in displayed financial figures

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

## G. Smaller, real, and recorded

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

1. **§A — the numeric defects.** Six documented bugs in figures users read.
2. **§B1 — apply the NaN guard** to the five routers missing it. Small, and it
   removes a live 500.
3. **§D — reinstall autodeploy** and exercise the rollback once.
4. **§C2 — set the grievance address.** One env var, three indexed pages.
5. **§B2 — extend the axe gate** to cover degraded states properly.
6. Then the vendor decisions in §E, which are yours rather than work.
