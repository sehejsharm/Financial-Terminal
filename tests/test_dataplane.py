"""The data-plane split.

The property that matters is a contract term, not a product preference: if a
licensed real-time feed is active, a tick from it must never reach a subscriber
who is not entitled to it. A breach is found in an audit of logs months later,
so "it works in the UI" is not evidence of anything.

The second property, which is easy to get backwards, is that a PUBLIC tick is
withheld from nobody. Today every price in this app comes from a public source;
delaying those for free accounts would make the product worse for no licensing
reason and would mean printing a lag figure we cannot stand behind.
"""
from __future__ import annotations

import time

import pytest

from backend import dataplane, feeds, plans
from backend.stream import delayed, hub

FREE = {"username": "f", "role": "user", "plan": plans.FREE}
PRO = {"username": "p", "role": "user", "plan": plans.PRO}
ADMIN = {"username": "a", "role": "master_admin", "plan": plans.FREE}


@pytest.fixture(autouse=True)
def clean():
    delayed.clear()
    hub._conns.clear()
    hub._last.clear()
    hub._refcount.clear()
    feeds.reset_for_tests()
    yield
    delayed.clear()
    hub._conns.clear()
    feeds.reset_for_tests()


class TestTiers:
    def test_free_is_the_delayed_plane(self):
        assert dataplane.tier_for(FREE) == dataplane.DELAYED

    def test_pro_is_the_realtime_plane(self):
        assert dataplane.tier_for(PRO) == dataplane.REALTIME

    def test_the_admin_is_realtime_whatever_their_plan_says(self):
        assert dataplane.tier_for(ADMIN) == dataplane.REALTIME

    def test_an_anonymous_caller_is_delayed(self):
        assert dataplane.tier_for(None) == dataplane.DELAYED


class TestTheDelayIsAPropertyOfTheSource:
    """The part that is easy to get backwards."""

    def test_licensed_data_is_withheld_from_the_delayed_plane(self):
        assert dataplane.requires_delay(dataplane.LICENSED, dataplane.DELAYED)

    def test_licensed_data_flows_to_the_realtime_plane(self):
        assert not dataplane.requires_delay(dataplane.LICENSED,
                                            dataplane.REALTIME)

    def test_public_data_is_withheld_from_nobody(self):
        # Today every price comes from a public source. Delaying it for free
        # accounts would make the product worse for no licensing reason.
        assert not dataplane.requires_delay(dataplane.PUBLIC, dataplane.DELAYED)
        assert not dataplane.requires_delay(dataplane.PUBLIC, dataplane.REALTIME)


class TestLabelsClaimNothingUntrue:
    def test_public_data_is_not_called_real_time(self):
        # We do not know NSE's or Twelve Data's actual lag, and "Real-time"
        # would be a claim we cannot stand behind on a finance screen.
        label = dataplane.label(dataplane.PUBLIC, dataplane.REALTIME)
        assert "eal-time" not in label
        assert "Live" not in label

    def test_public_data_is_not_given_an_invented_delay(self):
        label = dataplane.label(dataplane.PUBLIC, dataplane.DELAYED)
        assert "min" not in label

    def test_a_delayed_licensed_quote_states_the_delay(self):
        assert "15 min" in dataplane.label(dataplane.LICENSED, dataplane.DELAYED)

    def test_a_licensed_realtime_quote_is_called_live(self):
        assert dataplane.label(dataplane.LICENSED, dataplane.REALTIME) == "Live"

    def test_a_delay_is_only_claimed_when_one_was_applied(self):
        public = dataplane.annotate({"price": 1}, tier=dataplane.DELAYED,
                                    source_class=dataplane.PUBLIC, as_of=1.0)
        assert "delayed_by_seconds" not in public
        lic = dataplane.annotate({"price": 1}, tier=dataplane.DELAYED,
                                 source_class=dataplane.LICENSED, as_of=1.0)
        assert lic["delayed_by_seconds"] == dataplane.DELAY_SECONDS

    def test_a_guessed_timestamp_is_marked_as_guessed(self):
        # A chart that says 15:29:58 when the figure is from 15:14 is worse
        # than one that admits it does not know.
        known = dataplane.annotate({}, tier=dataplane.REALTIME,
                                   source_class=dataplane.PUBLIC, as_of=123.0)
        assert known["as_of"] == 123.0
        assert known["as_of_estimated"] is False
        guessed = dataplane.annotate({}, tier=dataplane.REALTIME,
                                     source_class=dataplane.PUBLIC)
        assert guessed["as_of_estimated"] is True


class TestTheDelayBuffer:
    def test_a_fresh_tick_is_not_released(self):
        now = time.time()
        delayed.record("RELIANCE.NS", {"s": "RELIANCE.NS", "ltp": 100}, now)
        assert delayed.released("RELIANCE.NS", now) is None

    def test_a_tick_older_than_the_window_is_released(self):
        now = time.time()
        delayed.record("RELIANCE.NS", {"s": "RELIANCE.NS", "ltp": 100},
                       now - dataplane.DELAY_SECONDS - 1)
        assert delayed.released("RELIANCE.NS", now)["ltp"] == 100

    def test_the_newest_qualifying_tick_wins(self):
        now = time.time()
        base = now - dataplane.DELAY_SECONDS
        for i, px in enumerate((100, 101, 102)):
            delayed.record("X", {"s": "X", "ltp": px}, base - 300 + i * 60)
        assert delayed.released("X", now)["ltp"] == 102

    def test_a_newer_tick_does_not_leak_early(self):
        # The leak this buffer exists to prevent: a price from ten seconds ago
        # must not be served when the window is fifteen minutes.
        now = time.time()
        delayed.record("X", {"s": "X", "ltp": 100},
                       now - dataplane.DELAY_SECONDS - 1)
        delayed.record("X", {"s": "X", "ltp": 999}, now - 10)
        assert delayed.released("X", now)["ltp"] == 100

    def test_out_of_order_arrivals_are_handled(self):
        # Normal on a feed reconnect. The tail is not necessarily the newest.
        now = time.time()
        base = now - dataplane.DELAY_SECONDS - 1
        delayed.record("X", {"s": "X", "ltp": 200}, base)
        delayed.record("X", {"s": "X", "ltp": 100}, base - 120)
        assert delayed.released("X", now)["ltp"] == 200

    def test_nothing_recorded_releases_nothing(self):
        assert delayed.released("NEVER.NS", time.time()) is None

    def test_history_is_pruned_to_the_window(self):
        # Ticks spanning well past the retention window (delay + margin),
        # one per minute, so the oldest fall outside it. Spanning less than
        # the window would keep everything and prove nothing.
        now = time.time()
        span_minutes = (dataplane.DELAY_SECONDS * 3) // 60
        for i in range(span_minutes):
            delayed.record("X", {"s": "X", "ltp": i},
                           now - dataplane.DELAY_SECONDS * 3 + i * 60)
        held = delayed.stats()["delayedTicksHeld"]
        assert held < span_minutes, "nothing was pruned"
        # What is kept is roughly the retention window, in minutes.
        assert held <= (dataplane.DELAY_SECONDS + 120) // 60 + 2

    def test_a_symbol_can_be_forgotten(self):
        delayed.record("X", {"s": "X"}, time.time())
        delayed.forget("X")
        assert delayed.stats()["delayedSymbols"] == 0


class TestPublishRespectsThePlane:
    """The licensing control, at the one point every tick passes through."""

    def _conn(self, tier):
        c = hub.Connection(tier=tier)
        hub.register(c)
        hub.add_symbols(c, ["RELIANCE.NS"])
        # add_symbols may enqueue a snapshot; start from empty so the
        # assertions below are about publish() alone.
        while not c.queue.empty():
            c.queue.get_nowait()
        return c

    def test_a_licensed_tick_never_reaches_a_delayed_subscriber(self):
        free = self._conn(dataplane.DELAYED)
        hub.publish("RELIANCE.NS", {"ltp": 2945.5, "ts": int(time.time() * 1000),
                                    "source_class": dataplane.LICENSED})
        assert free.queue.empty(), "licensed data leaked to the delayed plane"

    def test_a_licensed_tick_does_reach_an_entitled_subscriber(self):
        pro = self._conn(dataplane.REALTIME)
        hub.publish("RELIANCE.NS", {"ltp": 2945.5, "ts": int(time.time() * 1000),
                                    "source_class": dataplane.LICENSED})
        assert not pro.queue.empty()

    def test_both_planes_at_once_only_serves_the_entitled_one(self):
        free = self._conn(dataplane.DELAYED)
        pro = self._conn(dataplane.REALTIME)
        hub.publish("RELIANCE.NS", {"ltp": 2945.5, "ts": int(time.time() * 1000),
                                    "source_class": dataplane.LICENSED})
        assert free.queue.empty()
        assert not pro.queue.empty()

    def test_a_public_tick_reaches_everyone(self):
        # Nothing changes for anybody today, which is the point: the split is
        # inert until a licensed feed exists.
        free = self._conn(dataplane.DELAYED)
        pro = self._conn(dataplane.REALTIME)
        hub.publish("RELIANCE.NS", {"ltp": 2945.5, "ts": int(time.time() * 1000)})
        assert not free.queue.empty()
        assert not pro.queue.empty()

    def test_an_untagged_tick_is_treated_as_public(self):
        # Every existing producer omits source_class. Defaulting to LICENSED
        # would have silently stopped prices reaching every current client.
        free = self._conn(dataplane.DELAYED)
        hub.publish("RELIANCE.NS", {"ltp": 1.0, "ts": int(time.time() * 1000)})
        assert not free.queue.empty()

    def test_a_licensed_tick_is_recorded_for_later_release(self):
        self._conn(dataplane.DELAYED)
        hub.publish("RELIANCE.NS", {"ltp": 2945.5, "ts": int(time.time() * 1000),
                                    "source_class": dataplane.LICENSED})
        assert delayed.stats()["delayedTicksHeld"] == 1

    def test_a_public_tick_is_not_recorded(self):
        self._conn(dataplane.DELAYED)
        hub.publish("RELIANCE.NS", {"ltp": 1.0, "ts": int(time.time() * 1000)})
        assert delayed.stats()["delayedTicksHeld"] == 0

    def test_the_delayed_plane_is_served_once_the_window_passes(self):
        free = self._conn(dataplane.DELAYED)
        old_ms = int((time.time() - dataplane.DELAY_SECONDS - 1) * 1000)
        hub.publish("RELIANCE.NS", {"ltp": 2900.0, "ts": old_ms,
                                    "source_class": dataplane.LICENSED})
        assert free.queue.empty()          # not pushed live
        assert hub.publish_delayed("RELIANCE.NS") == 1
        assert not free.queue.empty()      # served from history

    def test_publish_delayed_does_not_serve_the_realtime_plane(self):
        # They already had it live; sending it again would show them a stale
        # price after a fresh one.
        pro = self._conn(dataplane.REALTIME)
        old_ms = int((time.time() - dataplane.DELAY_SECONDS - 1) * 1000)
        hub.publish("RELIANCE.NS", {"ltp": 2900.0, "ts": old_ms,
                                    "source_class": dataplane.LICENSED})
        while not pro.queue.empty():
            pro.queue.get_nowait()
        assert hub.publish_delayed("RELIANCE.NS") == 0

    def test_the_delay_is_measured_against_the_feed_clock(self):
        """A tick that is OLD on arrival is releasable immediately.

        The delay must be measured from when the feed knew the price, not from
        when we received it — otherwise a slow poll would extend the delay,
        and a local clock running fast would SHORTEN it, which is the breach.
        """
        free = self._conn(dataplane.DELAYED)
        old_ms = int((time.time() - dataplane.DELAY_SECONDS - 60) * 1000)
        hub.publish("RELIANCE.NS", {"ltp": 2900.0, "ts": old_ms,
                                    "source_class": dataplane.LICENSED})
        assert hub.publish_delayed("RELIANCE.NS") == 1
        assert not free.queue.empty()


class TestTheFeedRegistry:
    def test_no_vendor_is_wired_up(self):
        # On instruction: adapters wait for the signed contract.
        assert feeds.available() == []

    def test_absent_configuration_means_no_feed(self):
        assert feeds.active() is None

    def test_an_unknown_feed_name_degrades_rather_than_crashing(self, monkeypatch,
                                                                caplog):
        # Failing to boot would take the product down; falling back to public
        # data is what the app did before any of this and is never a breach.
        monkeypatch.setenv("REALTIME_FEED", "not-a-real-vendor")
        feeds.reset_for_tests()
        assert feeds.active() is None
        assert any("not a known feed" in r.message for r in caplog.records)

    def test_the_package_only_ever_produces_licensed_data(self):
        # An adapter around a public endpoint belongs in providers.py; putting
        # one here would mark public data as licensed and delay it for free
        # users for no reason.
        assert feeds.SOURCE_CLASS == dataplane.LICENSED


class TestHealthReportsBothPlanes:
    def test_stats_splits_connections_by_plane(self):
        hub.register(hub.Connection(tier=dataplane.REALTIME))
        hub.register(hub.Connection(tier=dataplane.DELAYED))
        s = hub.stats()
        assert s["realtimeConnections"] == 1
        assert s["delayedConnections"] == 1

    def test_stats_names_the_licensed_feed_or_none(self):
        # A licensing control that silently serves nobody looks identical to
        # one that works, so this has to be visible.
        assert hub.stats()["licensedFeed"] is None
