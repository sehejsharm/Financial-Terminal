"""Schema validation for AI-generated value-chain maps.

The reported failure was "The AI did not return a valid structured map".
Underneath, the only check was "does this parse as JSON" — so a reply that
parsed but carried no relationships rendered as an empty diagram, and a
reply that didn't parse produced an error naming a Regenerate action that
wasn't on screen.

These tests pin the distinction: parsing is not validating.
"""
from __future__ import annotations

import pytest

from lib import value_chain as vc


def node(name, pct=None, **kw):
    return {"name": name, "revenue_pct": pct, **kw}


def good_payload():
    return {
        "suppliers": [node("Supplier A", 20), node("Supplier B", 10)],
        "customers": [node("Customer A", 35)],
        "competitors": [node("Rival A")],
        "summary": "A summary.",
    }


class TestValidateChain:
    def test_accepts_a_well_formed_map(self):
        out, problems = vc.validate_chain(good_payload())
        assert out is not None
        assert [n["name"] for n in out["suppliers"]] == ["Supplier A", "Supplier B"]
        assert out["customers"][0]["revenue_pct"] == 35.0
        assert problems == []

    def test_REJECTS_valid_json_that_is_not_a_map(self):
        # The exact failure mode that reached the screen as an empty diagram.
        out, problems = vc.validate_chain({"answer": "I don't know"})
        assert out is None
        assert any("suppliers" in p for p in problems)

    def test_rejects_a_non_object(self):
        assert vc.validate_chain(["a", "b"])[0] is None
        assert vc.validate_chain("nope")[0] is None
        assert vc.validate_chain(None)[0] is None

    def test_rejects_a_map_with_too_few_relationships(self):
        out, problems = vc.validate_chain(
            {"suppliers": [node("Only One")], "customers": [], "competitors": []})
        assert out is None
        assert any("survived validation" in p for p in problems)

    def test_competitors_alone_are_not_a_value_chain(self):
        out, _ = vc.validate_chain(
            {"suppliers": [], "customers": [],
             "competitors": [node("A"), node("B"), node("C")]})
        assert out is None

    def test_drops_unusable_nodes_but_keeps_the_map(self):
        payload = good_payload()
        payload["suppliers"] += [{"note": "no name"}, {"name": ""}, 42]
        out, problems = vc.validate_chain(payload)
        assert out is not None
        assert len(out["suppliers"]) == 2
        assert sum("unusable" in p for p in problems) == 3

    def test_a_bare_string_node_is_repaired_not_dropped(self):
        out, _ = vc.validate_chain(
            {"suppliers": ["Acme Corp", "Globex"], "customers": [], "competitors": []})
        assert out is not None
        assert [n["name"] for n in out["suppliers"]] == ["Acme Corp", "Globex"]

    def test_parses_a_percentage_written_as_text(self):
        out, _ = vc.validate_chain(
            {"suppliers": [node("A", "15%"), node("B", " 7 ")],
             "customers": [], "competitors": []})
        assert [n["revenue_pct"] for n in out["suppliers"]] == [15.0, 7.0]

    def test_an_out_of_range_or_nonsense_percentage_becomes_null(self):
        # Better a missing weight than a 4000% revenue share on a chart.
        out, _ = vc.validate_chain(
            {"suppliers": [node("A", 4000), node("B", "about a third")],
             "customers": [], "competitors": []})
        assert [n["revenue_pct"] for n in out["suppliers"]] == [None, None]

    def test_a_role_of_the_wrong_type_is_reported_not_crashed_on(self):
        payload = good_payload()
        payload["competitors"] = "Rival A, Rival B"
        out, problems = vc.validate_chain(payload)
        assert out is not None and out["competitors"] == []
        assert any("not a list" in p for p in problems)

    def test_absurdly_long_names_are_rejected(self):
        out, _ = vc.validate_chain(
            {"suppliers": [node("x" * 500), node("A"), node("B")],
             "customers": [], "competitors": []})
        assert all(len(n["name"]) <= 120 for n in out["suppliers"])

    def test_notes_survive_and_are_bounded(self):
        out, _ = vc.validate_chain(
            {"suppliers": [node("A", 5, note="y" * 900), node("B")],
             "customers": [], "competitors": []})
        assert len(out["suppliers"][0]["note"]) <= 400


class TestGenerationRetries:
    """get_chain_data must retry on a bad map and explain a final failure."""

    def _patch(self, monkeypatch, replies):
        calls = {"n": 0, "prompts": []}

        def fake_call(prompt, **kw):
            calls["prompts"].append(prompt)
            i = min(calls["n"], len(replies) - 1)
            calls["n"] += 1
            return replies[i]

        monkeypatch.setattr(vc.ai_analyst, "_call", fake_call)
        monkeypatch.setattr(vc.ai_analyst, "active_provider", lambda: "test")
        # The 12-hour cache would otherwise serve one test's result to the next.
        vc.get_chain_data.clear()
        return calls

    def test_a_good_first_reply_is_not_retried(self, monkeypatch):
        import json
        calls = self._patch(monkeypatch, [json.dumps(good_payload())])
        out = vc.get_chain_data("X.NS", "Ex Ltd", nonce=1)
        assert out is not None and calls["n"] == 1
        assert out["source"] == "test" and out["generated_at"]

    def test_retries_after_an_unparseable_reply(self, monkeypatch):
        import json
        calls = self._patch(monkeypatch,
                            ["sorry, I can't help with that",
                             json.dumps(good_payload())])
        assert vc.get_chain_data("Y.NS", "Why Ltd", nonce=2) is not None
        assert calls["n"] == 2

    def test_retries_after_a_reply_that_PARSES_but_is_not_a_map(self, monkeypatch):
        import json
        calls = self._patch(monkeypatch,
                            ['{"answer": "unknown"}', json.dumps(good_payload())])
        assert vc.get_chain_data("Z.NS", "Zed Ltd", nonce=3) is not None
        assert calls["n"] == 2

    def test_the_retry_prompt_states_what_was_wrong(self, monkeypatch):
        import json
        calls = self._patch(monkeypatch,
                            ['{"answer": "unknown"}', json.dumps(good_payload())])
        vc.get_chain_data("W.NS", "Dub Ltd", nonce=4)
        assert "rejected because" in calls["prompts"][1]

    def test_gives_up_after_three_attempts_with_a_specific_reason(self, monkeypatch):
        calls = self._patch(monkeypatch, ['{"answer": "unknown"}'])
        with pytest.raises(vc.ai_analyst.AnalystError) as exc:
            vc.get_chain_data("V.NS", "Vee Ltd", nonce=5)
        assert calls["n"] == 3
        # Not "something went wrong" — the actual validation failure.
        assert "suppliers" in str(exc.value) or "relationships" in str(exc.value)
