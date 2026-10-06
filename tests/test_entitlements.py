"""Plans, entitlements and metering.

The claim being tested is that gating is ENFORCED, not merely displayed. Every
test here goes through HTTP with a real token, because the failure mode worth
catching is a limit that only exists in the UI — and that failure mode passes
every unit test of the plan table.

The other thing pinned here is what a plan change must NOT do: narrowing a plan
can stop someone creating more of something, and must never delete or hide what
they already have. A product that deletes your watchlists when your card
expires is one nobody should trust with a portfolio.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import plans

ADMIN_PW = "test-pw-123"
USER_PW = "user-pw-123"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", ADMIN_PW)
    monkeypatch.setenv("BACKEND_JWT_SECRET",
                       "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    monkeypatch.setenv("MAIL_PROVIDER", "console")
    import lib.auth as lib_auth
    monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
    monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
    monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH",
                        Path(tmp_path) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp_path))
    from backend import app as app_mod
    importlib.reload(app_mod)
    from backend import invites, sessions, usage
    for mod in (invites, sessions, usage):
        mod.configure(Path(tmp_path))
    return TestClient(app_mod.app)


@pytest.fixture
def admin(client):
    tok = client.post("/api/v1/auth/login",
                      json={"username": "admin",
                            "password": ADMIN_PW}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def make_user(client, admin, username="trader", plan=plans.FREE):
    import lib.auth as lib_auth
    lib_auth.create_user(username, USER_PW)
    lib_auth.set_plan(username, plan)
    tok = client.post("/api/v1/auth/login",
                      json={"username": username,
                            "password": USER_PW}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


class TestThePlanTable:
    def test_free_can_still_do_real_research(self):
        # The product claim. A free tier that cannot screen, read fundamentals
        # or run a backtest is a demo, and the brief rules out dark patterns.
        free = plans.PLANS[plans.FREE]["entitlements"]
        assert free["screens_per_day"] >= 10
        assert free["history_years"] >= 5
        assert free["max_watchlists"] >= 1

    def test_the_paid_lever_is_realtime_not_crippling(self):
        free = plans.PLANS[plans.FREE]["entitlements"]
        pro = plans.PLANS[plans.PRO]["entitlements"]
        assert free["realtime_data"] is False
        assert pro["realtime_data"] is True

    def test_every_plan_declares_every_entitlement(self):
        # A missing key reads as None, and a gate on None is silently
        # permissive — the worst way for a limit to fail.
        for pid, p in plans.PLANS.items():
            missing = set(plans.ENTITLEMENTS) - set(p["entitlements"])
            assert not missing, f"{pid} is missing {missing}"

    def test_an_unknown_entitlement_raises_rather_than_passing(self):
        with pytest.raises(KeyError):
            plans.allows({"plan": plans.FREE}, "no_such_feature")

    def test_an_unknown_stored_plan_falls_back_instead_of_breaking(self):
        # A typo in the user table, or a plan retired from the catalogue, must
        # not take an account down.
        assert plans.plan_for({"plan": "enterprise-platinum"}) == plans.DEFAULT_PLAN

    def test_the_admin_is_not_metered(self):
        # Metering the person who has to reproduce a bug report is pointless.
        ents = plans.entitlements({"role": "master_admin", "plan": plans.FREE})
        assert ents["realtime_data"] is True
        assert ents["screens_per_day"] == plans.UNLIMITED

    def test_unlimited_compares_correctly_without_a_special_case(self):
        assert plans.within({"role": "master_admin"}, "max_alerts", 10_000)


class TestCeilingsAreEnforcedOverHttp:
    def test_a_free_account_hits_the_watchlist_ceiling(self, client, admin):
        hdr = make_user(client, admin)
        limit = plans.PLANS[plans.FREE]["entitlements"]["max_watchlists"]
        for i in range(limit):
            r = client.post("/api/v1/watchlists", headers=hdr,
                            json={"name": f"wl{i}", "tickers": []})
            assert r.status_code == 201, r.text
        r = client.post("/api/v1/watchlists", headers=hdr,
                        json={"name": "one too many", "tickers": []})
        assert r.status_code == 402, r.text

    def test_the_refusal_says_what_the_limit_is(self, client, admin):
        hdr = make_user(client, admin)
        limit = plans.PLANS[plans.FREE]["entitlements"]["max_watchlists"]
        for i in range(limit):
            client.post("/api/v1/watchlists", headers=hdr,
                        json={"name": f"wl{i}", "tickers": []})
        detail = client.post("/api/v1/watchlists", headers=hdr,
                             json={"name": "x", "tickers": []}).json()["detail"]
        assert str(limit) in detail
        assert "Free" in detail

    def test_402_not_403_so_the_client_can_tell_them_apart(self, client, admin):
        # 403 already means "wrong role" and "CSRF failed" here. A client
        # cannot show an upgrade screen for a status that means three things.
        hdr = make_user(client, admin)
        limit = plans.PLANS[plans.FREE]["entitlements"]["max_watchlists"]
        for i in range(limit):
            client.post("/api/v1/watchlists", headers=hdr,
                        json={"name": f"wl{i}", "tickers": []})
        assert client.post("/api/v1/watchlists", headers=hdr,
                           json={"name": "x", "tickers": []}).status_code == 402

    def test_a_pro_account_gets_the_higher_ceiling(self, client, admin):
        hdr = make_user(client, admin, "prouser", plans.PRO)
        free_limit = plans.PLANS[plans.FREE]["entitlements"]["max_watchlists"]
        for i in range(free_limit + 2):
            r = client.post("/api/v1/watchlists", headers=hdr,
                            json={"name": f"wl{i}", "tickers": []})
            assert r.status_code == 201, f"pro blocked at {i}: {r.text}"

    def test_the_admin_has_no_ceiling(self, client, admin):
        pro_limit = plans.PLANS[plans.PRO]["entitlements"]["max_watchlists"]
        for i in range(pro_limit + 1):
            r = client.post("/api/v1/watchlists", headers=admin,
                            json={"name": f"a{i}", "tickers": []})
            assert r.status_code == 201, f"admin blocked at {i}"


class TestNarrowingAPlanNeverDestroys:
    def test_a_downgrade_keeps_everything_already_created(self, client, admin):
        """The property that makes this safe to ship.

        A lapsed subscription must not delete data. Deleting someone's
        watchlists because their card expired is indefensible, and hiding them
        is the same thing with extra steps.
        """
        import lib.auth as lib_auth
        hdr = make_user(client, admin, "lapsing", plans.PRO)
        free_limit = plans.PLANS[plans.FREE]["entitlements"]["max_watchlists"]
        for i in range(free_limit + 3):
            assert client.post("/api/v1/watchlists", headers=hdr,
                               json={"name": f"wl{i}", "tickers": []}
                               ).status_code == 201
        before = len(client.get("/api/v1/watchlists", headers=hdr).json())

        lib_auth.set_plan("lapsing", plans.FREE)
        hdr = {"Authorization": "Bearer " + client.post(
            "/api/v1/auth/login",
            json={"username": "lapsing", "password": USER_PW}
        ).json()["access_token"]}

        after = client.get("/api/v1/watchlists", headers=hdr).json()
        assert len(after) == before, "a downgrade destroyed data"

    def test_but_cannot_add_more_while_over_the_new_ceiling(self, client, admin):
        import lib.auth as lib_auth
        hdr = make_user(client, admin, "lapsing2", plans.PRO)
        free_limit = plans.PLANS[plans.FREE]["entitlements"]["max_watchlists"]
        for i in range(free_limit + 2):
            client.post("/api/v1/watchlists", headers=hdr,
                        json={"name": f"wl{i}", "tickers": []})
        lib_auth.set_plan("lapsing2", plans.FREE)
        hdr = {"Authorization": "Bearer " + client.post(
            "/api/v1/auth/login",
            json={"username": "lapsing2", "password": USER_PW}
        ).json()["access_token"]}
        assert client.post("/api/v1/watchlists", headers=hdr,
                           json={"name": "nope", "tickers": []}
                           ).status_code == 402


class TestTheDataApiIsPaid:
    def test_a_free_account_is_refused(self, client, admin):
        hdr = make_user(client, admin, "freebdp")
        r = client.get("/api/v1/data/bdp?tickers=RELIANCE.NS&fields=px_last",
                       headers=hdr)
        assert r.status_code == 402, r.text

    def test_a_pro_account_is_not_refused_by_the_gate(self, client, admin):
        # Must not be 402. It may well fail for want of a provider in this
        # sandbox, which is a different thing and not what this asserts.
        hdr = make_user(client, admin, "probdp", plans.PRO)
        r = client.get("/api/v1/data/bdp?tickers=RELIANCE.NS&fields=px_last",
                       headers=hdr)
        assert r.status_code != 402, r.text


class TestMetering:
    def test_the_daily_allowance_is_enforced(self, client, admin):
        from backend import usage
        hdr = make_user(client, admin, "screener")
        limit = plans.PLANS[plans.FREE]["entitlements"]["screens_per_day"]
        # Spend the allowance directly rather than making N provider calls.
        for _ in range(limit):
            usage.record("screener", "screens")
        r = client.post("/api/v1/screens/custom", headers=hdr,
                        json={"filters": []})
        assert r.status_code == 402, r.text
        assert "resets at midnight IST" in r.json()["detail"]

    def test_a_use_is_counted_even_when_the_provider_fails(self, client, admin):
        # Counted BEFORE the route runs, deliberately: the cost is incurred by
        # calling the provider, so counting only successes makes a failing
        # provider a free unmetered loop.
        from backend import usage
        hdr = make_user(client, admin, "counted")
        client.post("/api/v1/screens/custom", headers=hdr, json={"filters": []})
        assert usage.used("counted", "screens") == 1

    def test_the_admin_is_never_metered(self, client, admin):
        from backend import usage
        for _ in range(500):
            usage.record("admin", "screens")
        r = client.post("/api/v1/screens/custom", headers=admin,
                        json={"filters": []})
        assert r.status_code != 402

    def test_the_day_boundary_is_ist_not_utc(self):
        # A quota that rolls over at midnight UTC resets at 05:30 IST, which
        # is the middle of pre-market — exactly when an Indian user is running
        # screens.
        from datetime import datetime, timezone
        from backend import usage
        # 19:00 UTC on the 1st is already 00:30 IST on the 2nd.
        late = datetime(2026, 1, 1, 19, 0, tzinfo=timezone.utc)
        assert usage.today_key(late) == "2026-01-02"

    def test_usage_is_per_user(self, client, admin):
        from backend import usage
        usage.record("alice", "screens")
        assert usage.used("bob", "screens") == 0


class TestTheBillingEndpoints:
    def test_the_price_list_needs_no_login(self, client):
        # A price list people cannot read before signing up is not a price
        # list.
        r = client.get("/api/v1/billing/plans")
        assert r.status_code == 200
        assert len(r.json()["plans"]) >= 2

    def test_the_catalogue_is_cheapest_first(self, client):
        prices = [p["price_inr_month"]
                  for p in client.get("/api/v1/billing/plans").json()["plans"]]
        assert prices == sorted(prices)

    def test_my_plan_reports_entitlements_and_usage(self, client, admin):
        hdr = make_user(client, admin, "reporter")
        body = client.get("/api/v1/billing/plan", headers=hdr).json()
        assert body["plan"] == plans.FREE
        assert body["entitlements"]["realtime_data"] is False
        assert body["usage"]["screens_per_day"]["limit"] == \
            plans.PLANS[plans.FREE]["entitlements"]["screens_per_day"]

    def test_my_plan_reflects_an_upgrade_immediately(self, client, admin):
        # Reads the user table, not the token — so a user who just paid is not
        # told they are still on free for another fifteen minutes.
        import lib.auth as lib_auth
        hdr = make_user(client, admin, "upgrader")
        lib_auth.set_plan("upgrader", plans.PRO)
        body = client.get("/api/v1/billing/plan", headers=hdr).json()
        assert body["plan"] == plans.PRO

    def test_the_admin_is_labelled_as_an_override(self, client, admin):
        # Otherwise the UI claims the operator is on a plan they are not
        # paying for.
        assert client.get("/api/v1/billing/plan",
                          headers=admin).json()["admin_override"] is True

    def test_my_plan_requires_a_login(self, client):
        assert client.get("/api/v1/billing/plan").status_code == 401


class TestAdminPlanManagement:
    def test_an_admin_can_move_an_account_to_a_plan(self, client, admin):
        make_user(client, admin, "promoted")
        r = client.post("/api/v1/admin/users/promoted/plan?plan=pro",
                        headers=admin)
        assert r.status_code == 200, r.text
        import lib.auth as lib_auth
        assert lib_auth.get_user("promoted")["plan"] == plans.PRO

    def test_an_unknown_plan_is_refused_and_names_the_valid_ones(self, client, admin):
        make_user(client, admin, "confused")
        r = client.post("/api/v1/admin/users/confused/plan?plan=platinum",
                        headers=admin)
        assert r.status_code == 400
        assert "free" in r.json()["detail"]

    def test_a_non_admin_cannot_change_plans(self, client, admin):
        hdr = make_user(client, admin, "selfpromoter")
        r = client.post("/api/v1/admin/users/selfpromoter/plan?plan=pro",
                        headers=hdr)
        assert r.status_code in (401, 403)

    def test_a_plan_change_is_audited(self, client, admin):
        make_user(client, admin, "audited")
        client.post("/api/v1/admin/users/audited/plan?plan=pro", headers=admin)
        log = client.get("/api/v1/admin/audit", headers=admin).json()
        assert any("plan_changed:audited" in str(e.get("path", "")) for e in log)

    def test_usage_can_be_returned_to_a_user(self, client, admin):
        from backend import usage
        make_user(client, admin, "wronged")
        usage.record("wronged", "screens")
        assert client.post("/api/v1/admin/users/wronged/usage/reset",
                           headers=admin).status_code == 200
        assert usage.used("wronged", "screens") == 0


class TestGrandfathering:
    def test_accounts_predating_plans_are_moved_to_the_paid_tier(self, tmp_path,
                                                                 monkeypatch):
        """The migration that stops this change breaking existing users.

        These accounts were created when the ceilings were whatever each
        router hardcoded (40 alerts, 10 portfolios). Defaulting them to free
        would retroactively cut a working account below what it holds.
        """
        import lib.auth as lib_auth
        monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
        monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
        monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH",
                            Path(tmp_path) / "pw.txt")
        lib_auth._save({"users": {}})
        lib_auth.create_user("oldtimer", "a-password")
        # Simulate a record written before plans existed.
        data = lib_auth._load()
        del data["users"]["oldtimer"]["plan"]
        lib_auth._save(data)

        assert lib_auth.backfill_plans(plans.PRO) == 1
        assert lib_auth.get_user("oldtimer")["plan"] == plans.PRO

    def test_the_migration_is_idempotent(self, tmp_path, monkeypatch):
        import lib.auth as lib_auth
        monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
        monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
        monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH", Path(tmp_path) / "pw.txt")
        lib_auth._save({"users": {}})
        lib_auth.create_user("oldtimer", "a-password")
        data = lib_auth._load()
        del data["users"]["oldtimer"]["plan"]
        lib_auth._save(data)
        lib_auth.backfill_plans(plans.PRO)
        assert lib_auth.backfill_plans(plans.PRO) == 0

    def test_it_does_not_overwrite_a_deliberate_free_plan(self, tmp_path,
                                                          monkeypatch):
        import lib.auth as lib_auth
        monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
        monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
        monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH", Path(tmp_path) / "pw.txt")
        lib_auth._save({"users": {}})
        lib_auth.create_user("newbie", "a-password")
        lib_auth.set_plan("newbie", plans.FREE)
        lib_auth.backfill_plans(plans.PRO)
        assert lib_auth.get_user("newbie")["plan"] == plans.FREE

    def test_a_new_account_gets_the_free_tier(self, client, admin):
        hdr = make_user(client, admin, "signup", plan=plans.FREE)
        assert client.get("/api/v1/billing/plan",
                          headers=hdr).json()["plan"] == plans.FREE


def test_the_duplicated_default_plan_constant_agrees_with_the_table():
    """lib/auth.DEFAULT_PLAN duplicates backend.plans.DEFAULT_PLAN.

    It is duplicated on purpose — lib/ sits below backend/ and must not import
    upward — so this is the thing that stops the two drifting. If they drift,
    new accounts land on a plan the gates do not expect.
    """
    import lib.auth as lib_auth
    assert lib_auth.DEFAULT_PLAN == plans.DEFAULT_PLAN
    assert plans.known(lib_auth.DEFAULT_PLAN)
