# Invariant suite (Phase 0.2)

Rules that must hold for **every** ticker, not examples that happen to work for
one. Each rule is a class of audit defect, generalised so the same mistake
cannot reappear in a different screen.

`pytest tests/invariants` is a required CI check.

## Conventions

**Strict xfail.** A rule the code currently violates is marked
`@pytest.mark.xfail(strict=True, reason="defect #N ...")`. The suite is green on
`main`, so it can gate merges today; when someone fixes the defect the xfail
becomes an **XPASS failure**, forcing the marker to be removed. A rule that
quietly starts passing is a rule that quietly starts failing again later.

**No network.** Everything runs against frozen fixtures
(`tests/fixtures/golden/`). Capture them with
`python scripts/capture_fixtures.py` on a machine that can reach the providers.
Tests `skip` (not fail) when a fixture is absent, so the rules stay in the suite
instead of being deleted in an environment that cannot capture.

**Two languages.** Backend-computed rules live here in pytest; metrics computed
in TypeScript are guarded in `frontend/src/lib/__invariants__/` under vitest,
where `it.fails(...)` is the strict-xfail equivalent. Splitting by language is
not elegant, but asserting in Python on a number the frontend recomputes would
test a copy rather than the thing that ships.

## Current status

| Rule | Guards | File | Status |
|---|---|---|---|
| INV-01 | Sortino >= Sharpe | `frontend/.../riskInvariants.test.ts` | **xfail — #23** |
| INV-02 | Movers sign + strict ordering | `test_inv_market.py` | passing (already fixed) |
| INV-05 | Revenue-per-share within 2 OOM of price | `test_inv_units.py` | **xfail — #14** |
| INV-06 | Beta in [0.2, 3.0] or null | `test_inv_risk.py` | **xfail — #11** |
| INV-08 | Money fields carry a currency | `test_inv_units.py` | **xfail — #14/#32** |
| INV-10 | Discrete never mixed with cumulative | `test_inv_market.py` | passing (XBRL half) |
| INV-13 | A percent field is [0,1] xor [0,100] | `test_inv_units.py` | **xfail — #15** |
| INV-14 | Cost of equity >= risk-free rate | `test_inv_risk.py` | passing; **xfail** on the `beta or 1.0` coercion — #12 |

Not yet implemented — they need Phase 1's data layer to have something to assert
against: INV-03 (diluted share count vs filed), INV-04 (allocations sum to 100),
INV-07 (vintage / max_age), INV-09 (one P/E across screens), INV-11 (target
range ordering), INV-12 (trade counts agree), INV-15 (prose guard, Phase 3).
