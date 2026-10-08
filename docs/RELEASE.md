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
