"""Workspace layout persistence.

v2 added a tiling grid (rows of panes) and link groups on top of the flat v1
{panes, split} shape. The behaviour worth pinning is that BOTH shapes still
round-trip: a user with a v1 document saved months ago must not lose it, and
a client that hasn't reloaded yet must still be able to save.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    tmp = tmp_path_factory.mktemp("ws")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    monkeymodule.setenv("BACKEND_JWT_SECRET",
                        "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    import lib.auth as lib_auth
    monkeymodule.setattr(lib_auth, "DATA_DIR", Path(tmp))
    monkeymodule.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    monkeymodule.setattr(lib_auth, "INITIAL_PW_PATH",
                         Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))
    from backend import app as app_mod
    importlib.reload(app_mod)
    return TestClient(app_mod.app)


@pytest.fixture(scope="module")
def token(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}


V2 = {
    "id": "desk1", "name": "Research desk", "version": 2,
    "rows": [
        {"id": "r1", "height": 2, "split": [2, 1], "panes": [
            {"id": "p1", "widget": "chart", "link": "A"},
            {"id": "p2", "widget": "news", "link": "A"},
        ]},
        {"id": "r2", "height": 1, "split": [1], "panes": [
            {"id": "p3", "widget": "movers", "link": "none"},
        ]},
    ],
    "groups": {"A": "RELIANCE.NS", "B": "TCS.NS"},
}

V1 = {
    "id": "old1", "name": "Legacy desk",
    "panes": [{"widget": "chart", "ticker": "TCS.NS"},
              {"widget": "news", "ticker": "TCS.NS"}],
    "split": [2, 1],
}


def test_requires_auth(client):
    assert client.get("/api/v1/workspaces").status_code in (401, 403)
    assert client.put("/api/v1/workspaces", json={"layouts": []}).status_code in (401, 403)


def test_empty_for_a_new_user(client, auth):
    r = client.get("/api/v1/workspaces", headers=auth)
    assert r.status_code == 200
    assert r.json()["layouts"] == []


def test_v2_grid_round_trips_with_rows_groups_and_weights(client, auth):
    r = client.put("/api/v1/workspaces",
                   json={"layouts": [V2], "active_id": "desk1"}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1

    got = client.get("/api/v1/workspaces", headers=auth).json()
    assert got["active_id"] == "desk1"
    l = got["layouts"][0]
    assert l["name"] == "Research desk"
    assert len(l["rows"]) == 2
    assert l["rows"][0]["split"] == [2, 1]
    assert l["rows"][0]["height"] == 2
    assert l["rows"][0]["panes"][0]["link"] == "A"
    assert l["groups"] == {"A": "RELIANCE.NS", "B": "TCS.NS"}


def test_a_LEGACY_v1_layout_still_saves_and_reads_back(client, auth):
    """A client that hasn't reloaded still posts the old shape."""
    r = client.put("/api/v1/workspaces", json={"layouts": [V1]}, headers=auth)
    assert r.status_code == 200, r.text
    l = client.get("/api/v1/workspaces", headers=auth).json()["layouts"][0]
    assert l["name"] == "Legacy desk"
    assert [p["widget"] for p in l["panes"]] == ["chart", "news"]
    assert l["split"] == [2, 1]
    assert l["panes"][0]["ticker"] == "TCS.NS"


def test_v2_documents_do_not_carry_empty_legacy_fields(client, auth):
    client.put("/api/v1/workspaces", json={"layouts": [V2]}, headers=auth)
    l = client.get("/api/v1/workspaces", headers=auth).json()["layouts"][0]
    # The v1 keys are dropped when unused, so stored docs stay clean.
    assert "panes" not in l
    assert "split" not in l


def test_mixed_v1_and_v2_layouts_coexist(client, auth):
    client.put("/api/v1/workspaces", json={"layouts": [V1, V2]}, headers=auth)
    got = client.get("/api/v1/workspaces", headers=auth).json()["layouts"]
    assert len(got) == 2
    by_name = {l["name"]: l for l in got}
    assert by_name["Legacy desk"]["panes"]
    assert by_name["Research desk"]["rows"]


def test_layouts_are_per_user(client, auth):
    client.put("/api/v1/workspaces", json={"layouts": [V2]}, headers=auth)
    r = client.post("/api/v1/admin/users",
                    json={"username": "otheruser", "password": "another-pw-123",
                          "role": "user"},
                    headers=auth)
    assert r.status_code in (200, 201), r.text
    tok = client.post("/api/v1/auth/login",
                      json={"username": "otheruser", "password": "another-pw-123"}
                      ).json()["access_token"]
    other = client.get("/api/v1/workspaces",
                       headers={"Authorization": f"Bearer {tok}"}).json()
    assert other["layouts"] == []


# ── caps: the server is the last line of defence ──────────────────────────

def test_rejects_too_many_rows(client, auth):
    from backend.routes.workspaces import MAX_ROWS
    bad = {**V2, "rows": [V2["rows"][0]] * (MAX_ROWS + 1)}
    assert client.put("/api/v1/workspaces", json={"layouts": [bad]},
                      headers=auth).status_code == 422


def test_rejects_too_many_panes_in_a_row(client, auth):
    from backend.routes.workspaces import MAX_PANES_PER_ROW
    row = {"panes": [{"widget": "news"}] * (MAX_PANES_PER_ROW + 1),
           "split": [], "height": 1}
    bad = {**V2, "rows": [row]}
    assert client.put("/api/v1/workspaces", json={"layouts": [bad]},
                      headers=auth).status_code == 422


def test_rejects_too_many_layouts(client, auth):
    from backend.routes.workspaces import MAX_LAYOUTS
    many = [{**V2, "id": f"d{i}", "name": f"D{i}"} for i in range(MAX_LAYOUTS + 1)]
    assert client.put("/api/v1/workspaces", json={"layouts": many},
                      headers=auth).status_code == 422


def test_rejects_oversized_strings(client, auth):
    for field, value in [("name", "x" * 61), ("id", "y" * 61)]:
        bad = {**V2, field: value}
        assert client.put("/api/v1/workspaces", json={"layouts": [bad]},
                          headers=auth).status_code == 422, field

    bad_pane = {**V2, "rows": [{"panes": [{"widget": "w" * 31}], "split": [], "height": 1}]}
    assert client.put("/api/v1/workspaces", json={"layouts": [bad_pane]},
                      headers=auth).status_code == 422


def test_missing_active_id_does_not_clear_the_saved_one(client, auth):
    """A v1 client omits active_id; that must not wipe the user's choice."""
    client.put("/api/v1/workspaces",
               json={"layouts": [V2], "active_id": "desk1"}, headers=auth)
    assert client.get("/api/v1/workspaces", headers=auth).json()["active_id"] == "desk1"
    # A save without the field stores null rather than erroring — the client
    # falls back to its own local memory of what was open.
    r = client.put("/api/v1/workspaces", json={"layouts": [V2]}, headers=auth)
    assert r.status_code == 200
