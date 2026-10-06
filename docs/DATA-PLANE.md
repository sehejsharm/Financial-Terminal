# The data-plane split

Two planes, one rule: **a licensed real-time tick must never reach a
subscriber who is not entitled to it.** That is a contract term, not a product
preference. A breach is found in an audit of logs months later, so it cannot
be a UI decision.

## The one thing to understand

**The delay is a property of the SOURCE, not of the tier.**

The obvious design — "free users get everything 15 minutes late" — is wrong
here, and it is worth knowing why before changing any of this.

Today every price in this app comes from a **public** source: NSE's own
website, Twelve Data, yfinance. None of it is licensed real-time data and none
of it carries a contract saying who may look at it. Delaying it for free
accounts would make the product worse for no licensing reason at all, and
would mean printing "delayed by 15 minutes" on a number whose real lag nobody
knows — a false claim on a finance screen.

So `dataplane.requires_delay()` asks about the source first:

| Source | Free account | Paid account |
|---|---|---|
| `public` (today) | passed through, labelled "Public data" | passed through, labelled "Public data" |
| `licensed` (after a contract) | held `DELAY_SECONDS`, labelled "Delayed 15 min" | passed live, labelled "Live" |

The useful consequence: **nothing changes for anybody today**, and the split
starts working the day a feed is configured without revisiting a single call
site.

## Where the rule is enforced

- `backend/stream/hub.publish()` — the single point every tick passes
  through. There is one `publish()` and several ways to subscribe, so this is
  the only place the rule cannot be forgotten.
- `Connection.tier` is set once, from the plan claim in the token, when the
  socket authenticates. Not re-checked per tick, so a client cannot change it
  mid-stream.
- `backend/routes/market._serve_quote()` — the REST path.
- `backend/stream/delayed.py` — holds licensed ticks and releases the newest
  one older than the window.

**The delay is measured against the feed's own timestamp**, never the local
clock. A slow poll or a clock drift can then only make the delay *longer* than
promised. Shorter would be the breach.

## Wiring a vendor, once the contract is signed

Nothing is implemented in `backend/feeds/` on purpose — the shape of an
adapter depends entirely on which vendor. A FIX session, a websocket pushing
binary frames, and a quota-limited REST endpoint are three different programs,
and the only thing they share is the `RealtimeFeed` protocol.

1. Write `backend/feeds/<vendor>.py` with a `Feed` class satisfying
   `RealtimeFeed` (see the protocol in `backend/feeds/__init__.py`).
   **`latest()` must return the feed's own `as_of` in epoch seconds** — the
   delayed plane releases on that value, so substituting the local clock
   silently shortens the delay.
2. Add it to `_REGISTRY` in `backend/feeds/__init__.py`.
3. Set `REALTIME_FEED=<vendor>` and whatever credentials it needs.
4. Check `GET /api/v1/stream/health` (admin): `licensedFeed` should name it,
   and `realtimeConnections` / `delayedConnections` should both be non-zero
   once a free and a paid client are connected. A licensing control that
   silently serves nobody looks identical to one that works, which is why
   those counters exist.

Tag every tick the adapter produces with `source_class: "licensed"` — or
rather, don't: `feeds.SOURCE_CLASS` is `licensed` for the whole package, and
an adapter wrapping a *public* endpoint belongs in `backend/providers.py`
instead. Putting one here would mark public data as licensed and delay it for
free users for no reason.

### An unknown `REALTIME_FEED` degrades, it does not crash

It logs loudly and falls back to public data for every tier. Failing to boot
would take the whole product down; falling back is what the app did before any
of this existed and is never a breach. The loud log is how someone finds out
they typed the name wrong — paid accounts will show "Public data" rather than
live prices until it is fixed.

## What we say to users

`dataplane.label()` and `planDisplay.dataSourceLabel()` must agree, and
neither claims anything we cannot stand behind:

- Public data is **never** called "real-time" or "live".
- A delay is named **only** when one was actually applied.
- `as_of_estimated` marks a timestamp that is our clock rather than the
  provider's, so the UI need not imply precision it does not have.
- With no provenance at all (the stream's compact deltas), the label is
  `null` — not "Live". That default is the one most worth getting right.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `REALTIME_FEED` | unset | Which adapter to use. Unset = no licensed feed. |
| `DELAYED_FEED_SECONDS` | `900` | How far behind the delayed plane runs. Set it to whatever the signed contract says. |
