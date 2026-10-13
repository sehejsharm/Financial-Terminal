# Things only you can do

Two kinds of item here. The first set can be done in a browser, so each one has
a **Claude in Chrome prompt** you can paste. The second set needs SSH to the VM,
which Chrome cannot do — those are plain shell runbooks.

**Before you start:** Claude in Chrome acts in your real browser with your real
logins. None of the prompts below should ever enter card details, complete a
purchase, or change a billing plan. Each one says so. If one starts heading
that way, stop it.

---

## A. Browser work — Claude in Chrome prompts

### A1. Set the grievance address (DO THIS FIRST — 2 minutes)

This is the highest-value thing on the list. Three **indexed** public pages
(`/disclosures`, `/privacy`, `/terms`) currently print a `.invalid` address
while telling the reader it is monitored.

```
Open vercel.com and go to my "financial-terminal" project, then Settings →
Environment Variables.

Add a variable named NEXT_PUBLIC_GRIEVANCE_EMAIL for the Production and Preview
environments. I will tell you the value — do not guess one and do not use a
placeholder.

Then confirm back to me: the exact variable name you created, which
environments it applies to, and whether an existing variable of that name was
already there (if so, tell me its value before changing anything).

Do not redeploy, do not change any other variable, and do not touch billing or
plan settings. After it is saved, just tell me it needs a redeploy to take
effect.
```

Then trigger a redeploy (or wait for my next push, which will do it).

### A2. Set up Resend so invites actually send

Right now `MAIL_PROVIDER` defaults to `console`, which logs the invite link and
**sends nothing**. Any account you create this way belongs to someone who never
receives an invite.

```
Go to resend.com and sign in (or create an account — free tier is fine, do NOT
enter payment details or upgrade any plan).

I need three things done:
1. Add and verify a sending domain. Walk me through exactly which DNS records I
   need to add (type, name, value) and tell me where to add them. Do not try to
   edit DNS yourself.
2. Create an API key with send-only permission. Show it to me once so I can
   copy it — then confirm you have not stored it anywhere.
3. Tell me the exact "from" address I should use, given the domain I verified.

Report back: the domain status (verified or pending), the DNS records I still
need to add, and the from-address format. Do not send any test emails to real
addresses.
```

Once verified, these go in **Vercel** (frontend) and **`deploy/.env` on the VM**
(backend — see §B):

| Variable | Value |
|---|---|
| `MAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | the key from step 2 |
| `MAIL_FROM` | e.g. `Motherboard <noreply@yourdomain.com>` — must be on the verified domain |
| `APP_BASE_URL` | the front end's origin, because invite links point at it |

### A3. Get the SEBI question answered (BLOCKING for launch)

This is a lawyer's call, not mine and not Chrome's. But Chrome can do the
legwork of finding the right lawyer and preparing the brief.

```
I need to find an Indian securities lawyer or a SEBI compliance consultant to
answer one specific question about a product I have built.

First, help me draft a one-page brief containing exactly this and nothing more:

  - The product is a markets research terminal for Indian and global equities.
  - It displays data, runs screeners the user configures, computes statistics
    (betas, ratios, options payoffs), and runs backtests of rules the user
    defines.
  - It makes no recommendations, gives no personalised advice, manages no
    money, and executes no trades.
  - It has ONE feature that worries me: an AI panel that generates prose — a
    bull case, a bear case, a scenario — about a named, tradeable security, on
    demand, for a subscription fee.
  - THE QUESTION: does this make me a Research Analyst or an Investment Adviser
    under SEBI regulations, and is registration mandatory?
  - Secondary question: if the answer is yes, would gating or removing that AI
    panel change it?

Then search for Indian law firms or consultants who specialise in SEBI
intermediary registration, and give me 3-5 options with contact details and
roughly what this kind of opinion costs.

Do not send any emails on my behalf. Do not sign up for anything. Just draft
the brief and give me the shortlist.
```

**Why this matters:** `docs/COMPLIANCE.md` §1.1 has the full argument both ways.
The software currently takes the conservative position ("not registered") in
every place it appears. If the answer comes back "registration required", the AI
panel is the first thing to re-examine — gating it is far cheaper than
registering.

### A4. Terms and privacy review (also a lawyer)

```
I have a Terms of Service and a Privacy Policy that were written by an engineer,
not a lawyer, for an Indian consumer fintech product. They have never been
reviewed.

Help me prepare a review request. The specific things I need checked are:
  - Compliance with the DPDP Act 2023: consent notice, grievance officer,
    breach notification, data principal rights, retention limits.
  - Whether the liability limitation and governing-law clauses are enforceable
    under Indian consumer law, which limits how far they can go.
  - Whether anything in them contradicts a "not registered with SEBI" position.

Find me 3-5 Indian lawyers or firms who do consumer-tech / data-protection work
and give me contact details and indicative cost. Do not contact anyone.
```

### A5. Decide the payment provider

Everything except the live vendor is built — plans, entitlements, server-side
enforcement. Checkout is deliberately absent because its shape differs between
providers.

```
Compare Razorpay and Stripe for an Indian SaaS selling a monthly subscription
to Indian retail customers. I need to decide which to integrate.

Tell me, for each:
  - What they need from me to activate (documents, business entity type, bank
    account, timeline to approval).
  - Pricing: per-transaction fees, any monthly or setup fee, settlement period.
  - Whether they handle GST invoicing and e-mandate / recurring UPI for Indian
    customers, since this is a monthly subscription.
  - Whether they support the subscription model natively or whether I have to
    build billing cycles myself.

Do NOT create an account, do NOT start an application, and do NOT enter any
business or bank details. Just the comparison and a recommendation.
```

### A6. Domain, and the apex-vs-subdomain decision

The landing page is at `/product` because moving the app off `/` would have
touched the nav, the bottom tabs, 189 e2e tests and the live app. The proper
configuration is apex = marketing, app on a subdomain.

```
I need a domain for an Indian markets research product called "Motherboard
Terminal". Check availability for a shortlist of sensible .com and .in options
and tell me rough annual cost per registrar.

Then explain the DNS setup I would need for: apex domain pointing at a Vercel
project (marketing), and an "app." subdomain also on Vercel, and an "api."
subdomain pointing at my own VM's IP which already runs Caddy for TLS.

Do NOT purchase anything and do NOT enter payment details. I will buy it myself
once I have decided.
```

### A7. GST

```
I am about to start charging Indian customers a monthly subscription for a
software product, roughly Rs 500/month. Explain, for an Indian context:
  - At what revenue threshold GST registration becomes mandatory for a SaaS
    product, and whether it differs for digital services.
  - Whether I should display the price inclusive or exclusive of GST to
    consumers, and what the law requires.
  - What fields a compliant invoice needs (GSTIN, place of supply, HSN/SAC).
  - Whether I need to register before taking the first payment.

Then find me 3 chartered accountants who work with Indian SaaS startups. Do not
contact anyone and do not file anything.
```

---

## B. VM work — needs SSH, Chrome cannot do this

### B1. Activate the deploy safety work (5 minutes)

The health gate, the automatic rollback and the commit-SHA version stamping are
all written but **inert**. `install-autodeploy.sh` *copies* the script to
`/usr/local/bin/mb-autodeploy` and systemd runs the copy; nothing refreshes it.

```bash
ssh <your-vm>
cd ~/Financial-Terminal
git pull
sudo bash deploy/install-autodeploy.sh

# Confirm it took:
sudo tail -20 /var/log/mb-autodeploy.log
curl -fsS https://sehejmotherboard.duckdns.org/version   # should show a commit SHA, not "unstamped"
```

### B2. Exercise the rollback ONCE before trusting it

It has never been executed — there is no Docker in the environment it was
written in. The first real test should not be your first genuinely broken
deploy.

```bash
# On the VM. Push a deliberately broken commit to a scratch branch first
# (e.g. a syntax error in backend/app.py), then:
sudo BRANCH=<scratch-branch> bash deploy/autodeploy.sh --force

sudo tail -40 /var/log/mb-autodeploy.log     # expect "ROLLED BACK to <sha>"
curl -fsS https://<domain>/version           # expect the PREVIOUS sha
```

If it does not roll back, tell me and I will fix it before you rely on it.

### B3. Backend environment variables

These live in `deploy/.env` on the VM, not in Vercel:

```bash
ssh <your-vm>
cd ~/Financial-Terminal/deploy
sudo nano .env
```

Add / set:

```
MAIL_PROVIDER=resend
RESEND_API_KEY=re_...
MAIL_FROM=Motherboard <noreply@yourdomain.com>
APP_BASE_URL=https://<your-frontend-origin>

# Only set these TWO TOGETHER, never one alone — with MOTHERBOARD_ENV=production
# the app REFUSES TO BOOT unless WEBAUTHN_RP_ID is also set. That is deliberate:
# the RP ID is baked into every enrolled passkey, so deriving it means a
# reordered CORS list silently invalidates all of them.
#MOTHERBOARD_ENV=production
#WEBAUTHN_RP_ID=<your api domain>
```

Then `sudo docker compose up -d` and check `/healthz`.

### B4. Set the off-host backup destination (NEW — and it is the point of backups)

There were no backups at all; there are now. `deploy/backup.sh` runs daily,
verifies every archive by extracting it and diffing, proves a quiet window, and
restores correctly — `install-autodeploy.sh` runs a full snapshot → destroy →
restore round trip at install time so you end the install with a *demonstrated*
restore rather than a believed one.

**But every snapshot is on the same volume as the data it protects.** That
survives `rm -rf data/`, a corrupt write and a bad deploy. It does not survive
losing the instance or its boot volume, which is the failure a backup is
actually for.

One line fixes it. The file is created for you at mode 0600, with examples in
it:

```bash
ssh <your-vm>
sudo nano /etc/motherboard-backup.env
```

Uncomment and fill in ONE of these (keep the single quotes — `$1` must reach
the command, not be expanded by the editor):

```
MB_BACKUP_OFFHOST_CMD='for f in "$1" "$2" "$3"; do rclone copy "$f" remote:motherboard/; done'
# or
MB_BACKUP_OFFHOST_CMD='scp "$1" "$2" "$3" backup@HOST:/srv/motherboard/'
```

Send **all three** files, not just the archive. `restore.sh` refuses an archive
it cannot verify, and an archive fetched back without its `.sha256` is exactly
that — I measured this, and it matters: with the checksum gate removed,
restoring a *truncated* archive exits 0 and replaces your live data with a
partial payload. The checksum is not a second line of defence, it is the only
one.

Then:

```bash
sudo systemctl restart mb-backup.service
sudo tail -30 /var/log/mb-backup.log        # expect "off-host push OK"
```

And prove it round-trips once — fetch an archive back from wherever you sent it
and run:

```bash
bash ~/Financial-Terminal/deploy/restore.sh /path/to/fetched.tar.gz --verify-only
```

Until this is set, `backup.sh` warns on every single run and the installer
warns at the end. That noise is deliberate: a local-only backup looks exactly
like a working backup right up to the moment the volume is gone.

If you would rather not pick a provider yet, say so and I will add a step to
`autodeploy.sh` that at least copies the newest snapshot off the boot volume —
better than nothing, still not off-host.

### B5. Rotate the admin password

It appeared in chat early in this project and as far as I know has never been
rotated.

```bash
ssh <your-vm>
cd ~/Financial-Terminal/deploy
sudo nano .env          # change MOTHERBOARD_ADMIN_PASSWORD
sudo docker compose up -d --force-recreate backend
```

`deploy/.env` is the source of truth for the master-admin credentials and is
re-synced on every boot, so a change plus a restart is the whole procedure.

---

## C. Not a task — a decision

**Who are you selling to?** This is the fork that determines everything else.

- **Individual retail users:** the gap is now **A1 (the grievance address), B1,
  B4 and the SEBI answer**, and nothing else I can see. The numeric defects and
  the NaN 500 are fixed, the user store no longer loses writes, backups exist
  and have been proven to restore, and the security model would survive
  scrutiny today.
- **Institutions:** the gap is still large, but two of the three things I called
  out last time are closed. **Backups exist** (`deploy/backup.sh`, 29 tests in
  CI, a demonstrated restore) and **the user store is no longer doing unlocked
  read-modify-write** — that one was worth measuring: eight concurrent account
  creations all reported success and one account survived. What is left is a
  real database (`docs/DATASTORE-MIGRATION.md` is now a concrete design, not a
  gesture), horizontal scale, staging, SSO/SAML, audit export, RBAC beyond one
  admin role, a DPA, an uptime SLA, and someone on call.

Answer C before spending money on A5 or A6.

One correction to my earlier framing, because it changes the order: I said the
database migration was the institutional blocker. Having now designed it
against the actual code, the blocker is **a second process**, and the database
is what unblocks that. Everything else still in-process — the rate limiter, the
cache, the stream hub's connection registry — needs Redis as well before a
second worker helps. So "move to Postgres" is one step of a larger piece of
work, not the piece of work. §I of `docs/OPEN-ITEMS.md` says when to start it,
and the trigger is a business event rather than a tidier diagram.
