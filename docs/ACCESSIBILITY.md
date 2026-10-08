# Accessibility

## The honest headline

**A green axe run does not mean this app is accessible.** axe catches roughly a
third of WCAG problems — the mechanical ones it can see in markup. It cannot
tell you whether the keyboard reaches anything, whether focus is visible,
whether a drawer traps focus, whether the reading order makes sense, or whether
a label says anything useful.

That is not a hedge, it is the finding: when the automated gate was first run,
**thirteen of fourteen routes were already clean** — and the app still had a
keyboard trap in its mobile navigation and a chart with no text alternative.
Both are things axe reports as fine.

So the suite has two halves, and the second half is the one that found things.

## The automated gate

`frontend/e2e/a11y.spec.ts` runs axe over every route at WCAG 2.0/2.1 A and AA.
Expected result: zero violations. It fails the build on any.

What it found, and what was fixed:

| Route | Violation | Fix |
|---|---|---|
| `/login` | `label`, **critical**, ×2 | The username and password inputs had visible label text with no `htmlFor`/`id` association, so a screen reader announced two unlabelled boxes — on the one screen a user cannot skip, where knowing which field is which matters most. Also added `autoComplete`, because a password manager that can fill a form is an accessibility feature. |

Everything else was already clean. Credit where due: the skip link, the
`aria-label`s on icon controls, the colourblind-safe gain/loss palette and the
`prefers-reduced-motion` handling all predate this phase.

## What axe cannot check, and what that found

| Behaviour | Test | What it found |
|---|---|---|
| Keyboard-only sign-in | types into the form and submits with Enter | passed |
| Focus is visible | tabs 25 times, asserts an outline or shadow on whatever is focused | passed. This is the most common accessibility regression there is, it is invisible in a screenshot taken with a mouse, and no automated tool checks it |
| Skip link actually moves focus | presses Tab, Enter, asserts `#main-content` | passed |
| **Escape closes the mobile drawer** | opens the drawer, presses Escape | **FAILED.** The drawer could be opened from the keyboard and not closed — a trap, and a trap is worse than no drawer |
| **Focus moves in on open, back out on close** | asserts the close button is focused, then the opener after Escape | **FAILED.** Opening told assistive tech a dialog appeared and left focus on the page behind it |
| **Tab stays inside the open drawer** | 30 tabs, asserts focus never leaves `[role=dialog]` | **FAILED.** Focus walked onto controls behind the backdrop that a user cannot see |

The drawer now has `role="dialog"`, `aria-modal`, an Escape handler, a focus
trap and focus restoration. Each of those tests was confirmed to fail with its
fix removed — a test that passes either way is worse than no test, because it
looks like coverage.

## Live regions

The connection badge (`LIVE` / `RECONNECTING` / `STALE` / `CLOSED`) is now
`role="status" aria-live="polite"`. A sighted user watches that badge change
and knows the numbers have stopped moving; without the live region a
screen-reader user was told nothing and kept reading figures that were no
longer updating.

`polite`, not `assertive`, so it waits for a gap instead of interrupting. And
it is only safe to make this a live region **because it reflects the
connection**, which changes rarely — wiring one to the prices would announce
every tick and make the app unusable. That is the reason prices are
deliberately *not* a live region.

## Known gaps — not fixed, not pretended otherwise

1. **No real screen-reader verification.** Everything above is Chromium plus
   axe. NVDA, JAWS and VoiceOver each behave differently, and nothing here has
   been through any of them. This is the largest gap and it needs a person with
   the software, not another test.
2. **Charts have a label, not parity.** `PriceChart` draws to a canvas, so
   there is nothing in the DOM to read. It now has `role="img"` and a name
   saying what it is and that the figures are available as text in the
   surrounding panels — which is a floor. A proper data-table alternative would
   be better and is not built.
3. **The connection badge is `hidden sm:flex`**, so on the narrowest screens it
   is not rendered and therefore not announced either.
4. **The axe gate now runs in CI, but does not block.** The Playwright suite
   is wired in as the `e2e` job (`.github/workflows/ci.yml`), so the
   accessibility checks execute on every push and report. The job is
   `continue-on-error` because three unrelated specs depend on live market-data
   providers and fail in CI — see docs/RELEASE.md for why that is deliberate
   and what fixing it requires. So an accessibility regression is *visible* in
   CI but will not stop a merge until the e2e job can be made blocking.
5. **WCAG 2.5.8 target sizes** were measured and fixed in the UI/UX phase; see
   that commit. Inline text links are deliberately left alone — 2.5.8 exempts
   targets in a sentence.
