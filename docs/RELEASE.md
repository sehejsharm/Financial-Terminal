# Release and observability

## How a deploy happens

There is no deploy button. A systemd timer on the VM runs
`deploy/autodeploy.sh` every ~4 minutes: it fetches the deploy branch, and if
the remote has moved it resets to it and rebuilds the containers. Vercel
deploys the same branch for the front end on push.

**So a push to the deploy branch IS a production deploy, of both halves,
within about four minutes.** There is no staging environment.

```
git push  ──┬──►  Vercel builds and serves the front end
            └──►  VM timer (≤4 min) rebuilds the backend
```

## The deploy gate, and what it used to miss

`docker compose up -d --build` exits 0 as soon as the container **starts**. A
build that compiles and then dies on an import error, a bad env var or a
failed startup satisfied it completely — the broken container replaced the
working one and nothing noticed. The watchdog did not help either: restarting
a genuinely broken image just loops.

`autodeploy.sh` now waits for Docker's own health verdict on the backend (the
same signal the watchdog uses, so there is one definition of "healthy" rather
than two that can disagree), and **rolls back to the previous commit** if the
new one does not come up within `HEALTH_TIMEOUT_SEC` (180s — comfortably more
than the healthcheck's 60s `start_period` plus its 30s interval, so a
slow-but-fine boot is not rolled back).

Three outcomes, all logged to `/var/log/mb-autodeploy.log`:

| Log line | What happened | What to do |
|---|---|---|
| `deploy OK at <sha> (APP_VERSION=…)` | New commit is live and healthy | Nothing |
| `ROLLED BACK to <sha>` | New commit would not come up; previous one restored | **Fix forward.** The bad commit is still on the branch and will be retried on the next new commit |
| `ROLLBACK ALSO FAILED` | Neither commit starts | Environmental, not the code — disk, Docker, or something the app needs at boot. See `deploy/recover.sh` |

**The rollback is not a revert.** It restores the previous *build*; the bad
commit stays on the branch. That is deliberate — silently rewriting the branch
from a cron job would be worse — but it means a rollback is a signal to fix
forward, not a resolution.

## Knowing what is actually running

`APP_VERSION` was hardcoded to `oracle-1`, so `/version` reported the same
string regardless of what was deployed — on a service that redeploys every
four minutes, including while you are trying to diagnose a bad one.

It is now stamped with the short commit SHA by `autodeploy.sh`.

- `GET /version` — the live commit, plus the cache backend. Public.
- `GET /healthz` — liveness. Public; the compose healthcheck and the watchdog
  both use it.
- `GET /diag` — per-provider reachability. **Master-admin only** (it discloses
  which provider keys are configured and makes four metered calls per hit).
- `GET /api/v1/stream/health` — socket counts, subscribed symbols, feed
  latency, and both data planes. Authenticated.
- `unstamped` as a version means somebody ran `docker compose up` by hand
  rather than deploying through the script.

The scheduled `healthcheck` workflow prints the live version every 15 minutes
and **warns when the branch is ahead of what is deployed** — which is exactly
the state a rollback leaves behind and the one nothing else reports: the push
looked fine, CI was green, and the VM quietly went back.

## Backup and restore

Before this there was none. `deploy/docker-compose.yml` bind-mounts `./data`
into the backend and **that directory is the entire database** — accounts,
sessions, notes, portfolios, watchlists, workspaces, alerts, invites, usage,
grievances, the audit log and the JWT secret. `lib/atomic.py` protects an
individual file from a failed write; nothing protected the directory from being
lost. One bad volume and every account was gone.

| | |
|---|---|
| Take a snapshot | `sudo bash deploy/backup.sh` |
| Prove the round trip works | `sudo bash deploy/backup.sh --self-test` |
| Check a snapshot without restoring | `bash deploy/restore.sh --latest --verify-only` |
| See what a restore would do | `bash deploy/restore.sh --latest --dry-run` |
| Restore | `cd deploy && docker compose stop backend && sudo bash restore.sh --latest && docker compose up -d` |
| Scheduled | `mb-backup.timer`, daily at 03:17 (+ up to 15 min jitter), `Persistent=true` |
| Log | `/var/log/mb-backup.log` |

Snapshots are `/var/backups/motherboard/mb-data-<UTC>.tar.gz` (dir mode 0700 —
the archives hold password hashes and the JWT secret), each with a `.sha256`
and a `.manifest.json` beside it.

### It copies the whole directory, not a list of ten files

A file list only ever fails in one direction: silently missing something.
`.gitignore` already learned this (its comment records that a per-file list
ignored `data/notes.json` but not `data/notes.json.bak`). The directory holds
more than the obvious stores — `.jwt_secret` (**lose it and every signed-in
user is logged out even though `users.json` survived**),
`INITIAL_ADMIN_PASSWORD.txt`, the `vc_*` value-chain stores,
`notify_settings.json`, the writer's `.bak` siblings. Copying the directory
means a feature that adds a store is covered without anyone editing a script.

Two things are deliberately dropped: the atomic writer's in-flight `*.tmp`
files (half-written documents that nothing would ever clean up), and a trailing
partial line in a `.jsonl` (the appends in `storage.append_audit` are not
atomic, so a snapshot can catch one mid-write — the record being written as the
snapshot was taken is dropped rather than restored unparseable).

### On a consistent *set*, and what was concluded

`lib/atomic.py` makes each **file** atomic. It says nothing about the **set**. A
signup writes `users.json` and then appends to `audit.jsonl`; a naive copy taken
between those two writes yields an account with no audit trail. So a copy of
ten files taken over a second is genuinely not a consistent set, and the
question had to be answered rather than assumed.

There is no transaction to borrow, so `backup.sh` proves a **quiet window**: it
fingerprints every file (path, size, mtime) before the copy and again after,
and retries the whole pass if anything moved. A snapshot is only marked
`"quiesced": true` when a pass completed with nothing changing underneath it.

That is weaker than a transaction and the manifest says so. A write could land
and be reverted inside one pass; mtime granularity could hide two writes. For
this workload — a dozen small documents, writes at events-per-minute, no
Postgres — it is the strongest guarantee available without downtime, and the
retry makes an unquiesced result uncommon. When it does happen the snapshot is
**kept** (a possibly-torn snapshot beats none) but marked, and the run exits 3.

For a guaranteed-consistent snapshot, stop the backend first — about 15s of
downtime, and what to do before a risky migration:

```bash
cd deploy && docker compose stop backend && sudo bash backup.sh && docker compose start backend
```

### Every snapshot is verified at the moment it is taken

Not `tar -t`. The archive is extracted to a scratch directory and `diff -r`'d
against what was staged, because the failure that matters is "readable archive,
wrong contents". Every JSON document is parsed as well — which means a store
that is **already** corrupt on disk is reported on the next backup run rather
than discovered during a restore months later.

`restore.sh` verifies the checksum **before** extracting anything, and
validates the payload **before** touching live data. It then **moves the
existing directory aside** to `data.pre-restore-<UTC>` rather than deleting it,
so restoring the wrong snapshot is itself recoverable. Nothing cleans those up
automatically — on purpose; an automatic cleanup there would delete the only
copy of anything the snapshot predates.

| Exit | Means |
|---|---|
| 0 | snapshot taken, verified, quiescent, all JSON parsed |
| 1 | **no snapshot** — bad config, no disk, tar failed, or verification failed |
| 3 | snapshot taken and verified, but no quiet window could be proven |
| 4 | snapshot taken and verified, but a file in it is not valid JSON — **the live data is already damaged** (`deploy/recover.sh`) |
| 5 | snapshot taken and verified locally, but the off-host push failed |

### Retention, on a disk-constrained VM

14 snapshots **and** a 512MB ceiling, whichever bites first — the count alone
bounds nothing if the data grows. Before taking a snapshot the script checks
free space and refuses rather than take the volume below `MIN_FREE_MB` (4096,
the same threshold and the same reasoning as `autodeploy.sh`): below that a
build fails and the backend can no longer write `data/`. **A backup must never
cause the outage it exists to recover from.** It prunes old snapshots first and
re-checks, and it never deletes the last remaining snapshot to make room.

### OFF-HOST IS NOT CONFIGURED, and it is the whole point

A snapshot on the same VM as the data survives `rm -rf data/`, a corrupt write
and a bad deploy. **It does not survive losing the instance or its boot
volume**, which is the failure that actually ends companies. No provider is
chosen in the repo and no credential is invented.

One line, in `/etc/motherboard-backup.env` (created at 0600 by
`install-autodeploy.sh`, read by `mb-backup.service`). The value is a shell
command run with `$1` = archive, `$2` = checksum, `$3` = manifest:

```bash
MB_BACKUP_OFFHOST_CMD='for f in "$1" "$2" "$3"; do rclone copy "$f" remote:motherboard/; done'
# or: scp "$1" "$2" "$3" backup@HOST:/srv/motherboard/
```

Send **all three**, not just the archive. `restore.sh` refuses an archive it
cannot verify, and an archive fetched back without its `.sha256` is exactly
that — silent truncation in transit is what the checksum is there to catch.

Then `systemctl restart mb-backup.service`. It lives in that file rather than
an `Environment=` line because the value usually sits beside a credential and
`systemctl show` is readable by any user — and because `$` in a unit value is
a quoting trap.

Until it is set, `backup.sh` warns **on every run** and the installer warns at
the end. That noise is deliberate: a local-only backup looks exactly like a
working backup right up to the moment the volume is gone.

### What was actually tested, and what was not

There is no Docker in the environment these scripts were written in, so the
container path could not be exercised. **They were tested against scratch
directories**, and the round trip was run for real:

- snapshot a fake data dir → destroy it → restore → `diff -r` **empty**;
  `users.json` still 0600, `.jwt_secret` present, writer `.tmp` files absent
- the same round trip against the repo's **real** `data/` directory (snapshot
  out, restore into a scratch dir, `diff -r` empty, live data untouched)
- `tests/test_backup_restore.py` — **29 tests, in CI on every push**, driving
  both scripts as subprocesses against scratch directories. Most of them cover
  a *refusal*, because a backup that silently produces a bad archive is worse
  than no backup: a truncated archive refused with live data intact, a missing
  checksum refused until `--skip-checksum`, a payload that does not parse
  refused until `--force`, a tarball `backup.sh` did not produce refused, an
  unattended restore without `--yes` refused, both nesting directions refused,
  the disk guard refusing, a concurrent run skipping the tick, retention
  pruning the archive *with* its checksum and manifest and never deleting the
  last snapshot, `--verify-only` and `--dry-run` changing nothing, a restore
  over live data keeping the replaced copy, the off-host hook receiving all
  three paths as arguments, and every field in the manifest checked against
  the archive it describes
- `backup.sh --self-test` does the round trip on the host, and
  `install-autodeploy.sh` runs it at install time — so the install ends with a
  *demonstrated* restore rather than a believed one. The last test in the file
  runs it, so it cannot rot
- the exit-4 and exit-5 paths are forced deliberately (a corrupt store, a
  failing hook). **Exit 3 is not tested:** forcing "no quiet window" needs a
  writer racing `cp` of a few small files, and a test that usually fails the
  right way is still a flaky test

Mutation-checked rather than assumed: each guard was deliberately removed and
the matching test confirmed to fail. That found something worth writing down —
**with the checksum gate removed, restoring a truncated archive exits 0.**
`tar -xzf` extracts what it can from a half-truncated gzip and reports success,
so the restore completes and replaces live data with a partial payload. The
checksum is not a second line of defence here; it is the only one.

**Not verified:** the off-host hook against any real provider (no credentials,
by instruction — only that the hook is invoked with the right arguments and
that a nonzero exit is reported), and anything involving a running container.

**Not built, and worth knowing:** there is no point-in-time recovery — the
granularity is one snapshot a day, so up to 24h of writes can be lost.
`autodeploy.sh` does **not** take a snapshot before it deploys, which would be
the natural place for one; it was out of scope for this change (that file is
owned elsewhere) and is the obvious next improvement.

## What CI runs

| Job | Blocking | Contents |
|---|---|---|
| `test` | yes | ruff, the invariant suite (separately, and first), then the backend tests |
| `frontend` | yes | typecheck, vitest, production build |
| `e2e` | **no** (`continue-on-error`) | Playwright, with artifacts on failure |
| `audit` | no | pip-audit, npm audit |

**The frontend jobs are new. Before this, CI ran ruff and pytest only** — so
1267 vitest tests and the whole Playwright suite were enforced solely by
whoever remembered to run them. Every client-side guarantee added over the
preceding phases (the session model, the request coalescing, the
accessibility gates, the banned-claim check on public copy) was unguarded.

### Why e2e is not blocking yet

Three specs depend on live market-data providers and fail when those are
unreachable, which in CI they always are. They pass in isolation and fail in
sequence against the suite's shared data directory. Making the job blocking
before that coupling is fixed would train people to ignore a red build, which
is worse than not having the job.

The named flakes: `alerts.spec.ts`, `alerts-validation.spec.ts`,
`market-screens.spec.ts` (the DES calendar-window test). Fixing them means
giving each spec its own backend data directory, or stubbing the provider
layer in the e2e environment. **That is the next piece of work on this, and
until it is done the e2e job reports rather than gates.**

## Not verified, and worth saying so

The rollback path **has not been executed**. There is no Docker in the
environment this was written in, so `bring_up`, the health polling and the
rollback branch are reviewed and syntax-checked (`bash -n`) but never run. The
first real test will be the first genuinely broken deploy, which is an
uncomfortable place for a first test.

To exercise it deliberately on the VM, before relying on it:

```bash
# On the VM, with a commit you know is broken (e.g. a syntax error in
# backend/app.py) pushed to a scratch branch:
sudo BRANCH=<scratch-branch> bash deploy/autodeploy.sh --force
sudo tail -40 /var/log/mb-autodeploy.log     # expect ROLLED BACK
curl -fsS https://<domain>/version           # expect the PREVIOUS sha
```

### The Actions jobs have now run, and the first run caught a real bug

Which is the best argument for the jobs existing. The `frontend` job failed on
its first execution: it was pinned to Node 20 while this was developed on Node
22, and three jsdom-environment test files failed to **start** — not to assert,
to start:

```
TypeError: webidl.util.markAsUncloneable is not a function
  at new CacheStorage (undici/lib/web/cache/cachestorage.js)
  at jsdom/lib/api.js
```

`jsdom` pulls in `undici`, which needs a Node 22+ internal. 48 of 51 files
passed, so the result read as flake rather than as a version mismatch — and it
was invisible locally by construction, because locally the Node version was
the right one.

Worth noting how long it took to find: the tests pass on a clean `npm ci` in a
pristine worktree with exit code 0, so reproducing it locally was impossible.
It needed the runner's own log.

The Node version now comes from `frontend/.nvmrc`, read by every job via
`node-version-file`. It had been a literal in three places, which is a thing
that drifts; a file both sides read is not.

## Things this does not have

- **No staging.** A push is a deploy. The deploy gate reduces the blast radius
  of a broken build; it does nothing about a change that starts fine and is
  wrong.
- **No metrics time series.** `/version`, `/healthz`, `/diag` and
  `/stream/health` are point-in-time reads. There is no Prometheus, no
  dashboard, no alerting beyond the 15-minute workflow going red.
- **No error aggregation unless `SENTRY_DSN` is set.** Without it, unhandled
  exceptions are logged to the container journal and nothing else — they are
  findable but not noticed.
- **No release notes or tags.** The deployed version is a commit SHA; the
  history is the changelog.
- **No off-host backup until somebody sets one env var.** `deploy/backup.sh`
  runs daily, verifies itself and restores correctly, but every snapshot is on
  the same volume as the data it protects. See the backup section above.
- **No point-in-time recovery, and no snapshot before a deploy.** Daily
  granularity, so up to 24h of writes are at risk.
