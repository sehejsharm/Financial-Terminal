# Getting off JSON files

A concrete design for replacing the JSON-file datastore with Postgres, written
against what is actually in the repo today rather than against a generic
"add a database" plan.

`docs/enterprise-migration-plan.md` is the strategic document and still reads
well, but it predates the app it describes: its Phase 1 ("stand up FastAPI…
add Postgres; move users off users.json") and Phase 2 ("Next.js app") are one
bullet each, and Phases 0–2 are otherwise complete. This is the missing detail
under one of those bullets.

**Nothing here is implemented.** It is a design, and the single most important
thing in it is §1 — the seam already exists for half the data and does not
exist for the half that is hardest.

---

## 0. Why, and why not yet

The whole database is `deploy/data/`, bind-mounted into one container. What
that costs today:

| | |
|---|---|
| **Concurrency** | Every mutator is read-whole-file → mutate → write-whole-file. `lib/auth.py` now serializes that with an in-process lock, and the comment on `_lock` states the limit plainly: it protects ONE process, and is sufficient only because `backend/Dockerfile`'s uvicorn CMD passes no `--workers`. The day a second worker or a second container appears, writes start getting lost again, silently. |
| **Horizontal scale** | Therefore impossible. Not "slow" — incorrect. |
| **Queries** | None. "Which accounts are on pro and have not logged in for 30 days" means loading every record into Python. Fine at hundreds of accounts, not at tens of thousands. |
| **Backup** | Now exists (`deploy/backup.sh`) and proves a quiet window rather than a transaction, because there is no transaction to borrow. §3 of `docs/RELEASE.md` is honest about the difference. |
| **Point-in-time recovery** | None. Daily snapshots, so up to 24h of writes at risk. |

And what it does NOT cost, which is why this has not been urgent: reads are a
file parse, writes are atomic per file (`lib/atomic.py` + `os.replace`), a
corrupt file falls back to a `.bak` sibling, and at the current scale the whole
dataset fits in a few hundred kilobytes. **It is the right datastore for one
VM serving hundreds of accounts.** It becomes wrong at the first of: a second
process, a paying customer who asks about recovery objectives, or a query
nobody can answer.

So the trigger for this work is a business event, not a code smell. Do not
start it because the architecture diagram looks nicer afterwards.

---

## 1. The seam, and the half of the data that is outside it

`backend/storage/__init__.py` already defines a `Storage` interface with
`JSONStore` as the implementation:

```python
class Storage:
    def watchlists_for(self, username) -> list[dict]: ...
    def upsert_watchlist(self, username, wl) -> dict: ...
    def delete_watchlist(self, username, wl_id) -> bool: ...
    def append_audit(self, event) -> None: ...
    def recent_audit(self, limit=200) -> list[dict]: ...
    def user_doc(self, kind, username, default=None) -> Any: ...
    def save_user_doc(self, kind, username, doc) -> None: ...
    def all_user_docs(self, kind) -> dict[str, Any]: ...
```

`get_storage()` returns the singleton. **A `PostgresStore` can be written
against this and swapped in with no caller changes.** That is a genuinely good
piece of earlier work and it covers:

`alerts`, `api_tokens`, `notes`, `portfolios`, `screens`, `workspaces`,
`watchlists`, and the audit log.

**Five stores bypass it entirely**, each doing its own file handling:

| Store | Module | Why it bypassed the seam |
|---|---|---|
| `users.json` | `lib/auth.py` | Predates `Storage`, and is imported by the Streamlit app as well as the API |
| `sessions.json` | `backend/sessions.py` | Needs expiry and refresh-token rotation, which `user_doc` cannot express |
| `invites.json` | `backend/invites.py` | Single-use tokens with revocation |
| `usage.json` | `backend/usage.py` | Per-IST-day counters that must increment atomically |
| `grievances.json` | `backend/routes/support.py` | Added late, under a deadline |

This is the actual shape of the work. The eight stores inside the seam are a
day's work behind an interface that already exists and already has tests. The
five outside it are where the design decisions are, and **they are not
incidental** — they hold authentication, authorisation and the billing meter.

Corollary worth stating: **do not start by writing `PostgresStore`.** Start by
moving the five outside stores onto the interface *while they are still JSON*,
so the cutover is one implementation swap rather than six simultaneous
rewrites. Each move is independently shippable and independently revertible,
and the existing suites (`test_sessions.py`, `test_invites.py`,
`test_entitlements.py`, `test_auth_flow.py`, `test_grievances.py`,
`test_user_store_concurrency.py`) already pin the behaviour that must not
change.

---

## 2. Schema

Postgres, and the reasoning is unexciting: it is the one choice where
everything below is a built-in rather than a thing to build. `ON CONFLICT` for
the upsert that every `save_user_doc` is, real transactions for the
cross-store consistency `backup.sh` currently has to *prove* instead of
*assume*, `jsonb` so the documents that genuinely are documents do not need a
column each, and partial indexes for the expiry sweeps.

### 2.1 Accounts

```sql
CREATE TABLE users (
  username      text PRIMARY KEY,          -- already lowercased by lib/auth
  display       text NOT NULL,
  email         text,
  salt          text NOT NULL,
  hash          text NOT NULL,
  role          text NOT NULL DEFAULT 'user',
  plan          text NOT NULL DEFAULT 'free',
  plan_since    timestamptz,
  active        boolean NOT NULL DEFAULT true,
  pending       boolean NOT NULL DEFAULT false,
  created       timestamptz NOT NULL DEFAULT now()
);
-- Partial, because find_by_email only ever looks for a non-null one, and
-- email is nullable here (accounts created before invites existed have none).
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;
```

`username` stays the primary key rather than gaining a surrogate `id`. A
surrogate would be tidier and would cost a rewrite of every `user_doc(kind,
username)` call site, every audit record and every session row, for no benefit
the app can currently use. Revisit it the day a username needs to change.

`lower(email)` is a UNIQUE index and `find_by_email` currently scans without
one — so this migration closes a latent duplicate-email bug rather than
preserving it. Expect the migration to **fail** on existing data if two
accounts share an email; that is the index doing its job, and §4 says to run it
in dry-run first for exactly this reason.

### 2.2 Sessions

```sql
CREATE TABLE sessions (
  id          text PRIMARY KEY,            -- the opaque session id
  username    text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  hash        text NOT NULL,               -- SHA-256 of the current refresh token
  prev_hash   text,                        -- the rotation grace window
  created     timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz NOT NULL DEFAULT now(),
  expires     timestamptz NOT NULL,
  user_agent  text,
  ip          text
);
CREATE INDEX sessions_username_idx ON sessions (username, last_used DESC);
CREATE INDEX sessions_expiry_idx   ON sessions (expires) WHERE expires > now();
```

`ON DELETE CASCADE` is the point of doing this at all: `deactivate` in
`backend/routes/admin.py` currently has to remember to call
`sessions.revoke_all` and `invites.revoke_for`, and the comment there explains
that forgetting either leaves a way back into a disabled account. A foreign key
makes that structural instead of remembered.

`MAX_SESSIONS_PER_USER = 10` with LRU eviction becomes
`DELETE … WHERE id IN (SELECT id … ORDER BY last_used DESC OFFSET 10)` inside
the same transaction as the insert — which closes the race the current
in-process version has between counting and inserting.

### 2.3 The metered counters

```sql
CREATE TABLE usage (
  username  text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  day       date NOT NULL,                 -- IST day; see below
  feature   text NOT NULL,                 -- whatever meter() was given
  n         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day, feature)
);
```

Column named `feature` to match `usage.used(username, feature)` and
`usage.record(username, feature)` exactly. The values are the strings each
router passes to `entitlements.meter(feature, counter)` — not the entitlement
keys (`screens_per_day`, `ai_per_day`), which are a separate namespace. Keeping
the two apart in the schema is worth the pedantry: conflating them is a silent
mis-meter, which is a billing bug.

This is the table where the current implementation is most exposed and the
migration most clearly worth it. The increment becomes:

```sql
INSERT INTO usage (username, day, feature, n) VALUES ($1, $2, $3, 1)
ON CONFLICT (username, day, feature) DO UPDATE SET n = usage.n + 1
RETURNING n;
```

One statement, atomic, returning the post-increment value — so the limit check
and the charge cannot interleave.

**Today they can, and the gap is visible in the code.**
`backend/entitlements.meter` does:

```python
spent = usage.used(user["username"], feature)
if spent >= limit: raise HTTPException(402, ...)
usage.record(user["username"], feature)
```

Two calls with a decision between them, and no lock across the pair. Two
concurrent requests from the same account at the limit boundary both read
`spent == limit - 1`, both pass, and both are charged — so the ceiling is
exceeded by one per concurrent request. At a 50/day screener limit on a
single-worker deploy this is a rounding error and nobody has noticed. It is
still the paid-plan meter, and `RETURNING n` makes it exact for free: check the
returned value and refund by decrementing if it exceeded, or restructure to
charge-then-check.

**The IST day boundary is computed in the application, not by the database**,
and this must not be "simplified" later. The quota resets at midnight
Asia/Kolkata because that is what the product promises, and a `date` derived
from a server-side `now()` would reset at whatever the container's timezone
is. Pass the day in. `backend/usage.py` already has the helper.

### 2.4 Invites and grievances

```sql
CREATE TABLE invites (
  token     text PRIMARY KEY,              -- hashed, as now
  username  text NOT NULL,
  email     text NOT NULL,
  created   timestamptz NOT NULL DEFAULT now(),
  expires   timestamptz NOT NULL,
  used_at   timestamptz,                   -- NULL = unused; single-use
  revoked   boolean NOT NULL DEFAULT false
);
CREATE INDEX invites_username_idx ON invites (username) WHERE used_at IS NULL AND NOT revoked;

CREATE TABLE grievances (
  id        bigserial PRIMARY KEY,
  received  timestamptz NOT NULL DEFAULT now(),
  email     text,
  subject   text,
  body      text NOT NULL,
  status    text NOT NULL DEFAULT 'open',
  closed_at timestamptz
);
```

Note what `invites` does NOT have: a foreign key to `users`. An invite is
created *for* a username that may not exist yet, which is the whole point of an
invite. Adding the FK would be the obvious move and would break the feature.

`grievances` gains `status` and `closed_at` because the page promises a reply
within 7 working days and nothing currently tracks that —
`docs/OPEN-ITEMS.md` §G records it as "no SLA timer, admin queue or ageing
reminder". Two columns make the query answerable; the reminder is still work.

### 2.5 The documents that are genuinely documents

```sql
CREATE TABLE user_docs (
  username  text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  kind      text NOT NULL,   -- portfolios | notes | workspaces | alerts | screens | api_tokens
  doc       jsonb NOT NULL,
  updated   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, kind)
);

CREATE TABLE audit (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  username text,
  action   text NOT NULL,
  target   text,
  detail   text
);
CREATE INDEX audit_ts_idx ON audit (ts DESC);
```

**`jsonb`, deliberately, and this is the one choice here likely to be argued
with.** A workspace is a tiling layout of panes with per-pane widget config; a
portfolio is a list of positions with user-chosen columns. Normalising those
into relational tables means a schema migration every time a widget gains an
option — and the app already reads them as whole documents through
`user_doc(kind, username)`, validates them in Pydantic, and has an explicit
fallback for a corrupt one (`workspace.spec.ts` pins that a corrupt saved desk
falls back rather than white-screening). A one-row-per-(user, kind) jsonb table
is the same access pattern the code already has, which makes `PostgresStore` a
thin translation rather than a rewrite.

The trade is real and should be taken knowingly: **you cannot query inside
these.** "How many users hold RELIANCE.NS" needs either a jsonb index
(`CREATE INDEX … USING gin (doc jsonb_path_ops)`) or normalisation. Normalise
`portfolios` first if that question ever matters commercially — it is the one
with real analytical value — and leave the rest as documents.

`audit` is the opposite case and gets real columns: it is append-only, it is
queried by time and by actor, and it is the table a compliance request will
land on.

---

## 3. What the application layer needs

Only four things, which is the payoff for the seam already existing:

1. **`PostgresStore(Storage)`** — the eight in-seam stores. Mechanical.
2. **Four new interfaces**, extracted first while still JSON (§1): `UserStore`,
   `SessionStore`, `InviteStore`, `UsageStore`. Grievances can go through
   `Storage` as a ninth method.
3. **A connection pool**, sized against the thread pool, not guessed.
   `backend/reliability.configure_thread_pool()` already caps AnyIO's pool
   because forty concurrent provider calls OOM'd the container. The DB pool
   must be ≥ that cap or sync endpoints will queue on connections instead of
   on threads — the same symptom, a different resource, and much harder to
   read in a trace.
4. **Migrations**, Alembic, committed. Not `CREATE TABLE IF NOT EXISTS` at
   startup: `deploy/autodeploy.sh` redeploys every four minutes, so a
   startup-time schema step runs ~360 times a day and the day one of them is
   half-applied is the day there is no record of what ran.

Explicitly NOT needed: an ORM. Every query above is hand-writable, the
`Storage` interface is already the abstraction an ORM would be providing, and
SQLAlchemy's session lifecycle is a second concurrency model to get wrong
alongside the thread pool. `psycopg` with explicit SQL.

---

## 4. Cutover

The constraint that shapes all of this: **a push is a deploy** (there is no
staging — `docs/RELEASE.md` records it), and `autodeploy.sh` redeploys every
four minutes. So the cutover cannot be "deploy the new code and hope".

```
1. Ship the four interface extractions, still backed by JSON. Each one is a
   normal deploy with no data change and the existing suites as the gate.
2. Stand up Postgres. Alembic to head. Nothing reads it yet.
3. migrate.py --dry-run: read every JSON store, build every row, insert into a
   TRANSACTION, report counts per table, ROLL BACK. Expect this to fail the
   first time on the duplicate-email index (§2.1) and on any record with a
   field the schema does not allow. That failure is the deliverable of this
   step.
4. Fix what step 3 found, in the JSON data, through the running app. Repeat
   until the dry run is clean.
5. Take a backup and VERIFY IT RESTORES (`deploy/backup.sh --self-test`, then
   restore the real archive into a scratch dir). This is the rollback.
6. Stop the backend. Run migrate.py for real. Point MB_STORE=postgres. Start.
   ~2 minutes of downtime, which at this scale is cheaper than any dual-write
   scheme and far cheaper than reasoning about one.
7. Leave the JSON files in place, untouched, read by nothing, for a fortnight.
   They are the real rollback: MB_STORE=json and a restart.
```

**Not dual-write, and not a read-through shim.** Both are the textbook answer
for a zero-downtime migration and both are wrong here: they double the number
of places a write can be lost during exactly the window when the data is most
at risk, to buy two minutes of uptime on a service with no SLA and no staging
environment in which to test the shim. Take the downtime.

Step 7 is what makes step 6 safe, and it only works if nothing deletes the
files. Say so in the runbook.

---

## 5. Hosting, and the thing that will actually bite

Managed Postgres, not a container on the same VM. A database sharing a 1GB
instance and one boot volume with the app it serves fails at the same moment
the app does, which removes most of the reason for having moved to it.

The real decision is **where**. The app is on Vercel (US/global edge), the API
is on an Oracle free-tier VM, and the users are in India. A managed Postgres in
`us-east` puts ~200ms of round-trip into every query, and endpoints here make
several. That turns a migration intended to improve reliability into a
latency regression users will notice on the one page that is currently fast —
and `docs/BASELINE.md` has the request-count work that would be undone.

So: **the database goes in the same region as the API VM, and the API VM stays
near the users.** Check this before choosing a provider, not after. It is the
mistake this migration is most likely to make, because it is invisible in
every test that runs on one machine.

---

## 6. What this does not solve

Being explicit, because "we moved to Postgres" tends to get written down as if
it closed the whole enterprise gap in `docs/OPEN-ITEMS.md`:

- **It is not horizontal scale.** It removes the datastore as the blocker.
  Everything else in-process — the rate limiter's `_hits` dict, the cache, the
  stream hub's connection registry, the CSP report aggregate — is still
  per-process and still needs Redis or equivalent before a second worker helps.
- **It is not SSO, RBAC beyond one admin role, audit export, a DPA or an uptime
  SLA.** Those are separately listed and separately real.
- **It is not point-in-time recovery** until WAL archiving or the provider's
  PITR is turned on AND a restore has been performed once. A PITR feature
  nobody has exercised is the same belief that `deploy/backup.sh --self-test`
  exists to replace.
