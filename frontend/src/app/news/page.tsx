"use client";

import { useCallback, useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { News } from "@/components/News";
import { Shell } from "@/components/Shell";
import { TickerInput } from "@/components/TickerInput";
import { NewsFeed } from "@/components/news/NewsFeed";
import { WireDigest } from "@/components/news/WireDigest";
import { ErrorState, Loading, PageHeader, Tabs, type TabDef } from "@/components/ui";
import { api, type NewsItem } from "@/lib/api";

type Tab = "market" | "ticker";

const TABS: readonly TabDef<Tab>[] = [
  { id: "market", label: "Market wire", hint: "Every configured feed, deduplicated" },
  { id: "ticker", label: "By ticker", hint: "Headlines tagged to one symbol" },
];

export default function NewsPage() {
  const [tab, setTab] = useState<Tab>("market");
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticker, setTicker] = useState("RELIANCE.NS");
  // Lifted out of the feed so the digest's theme chips can drive it.
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setBusy(true); setErr(null);
    // 120 rather than 30: clustering collapses syndicated copies, so a
    // small pull renders as a very short page.
    api.marketNews(120)
      .then((n) => { setItems(n); setAt(Date.now()); })
      .catch((e) => setErr(e?.detail || "News feed unavailable."))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <Shell>
      <PageHeader
        title="NEWS"
        subtitle="Indian market wires first — Economic Times, Business Standard,
                  Livemint, Moneycontrol, BusinessLine — plus Yahoo and CNBC,
                  deduplicated across feeds and grouped by story."
        actions={<DataAge at={at} onRefresh={load} busy={busy} />}
      />

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === "market" && (
        <>
          {err && <ErrorState message={err} onRetry={load} />}
          {!err && !items && <Loading what="headlines" />}
          {items && (
            <>
              {/* What the day is about, before the hundred and twenty lines
                  the reader would otherwise scan to work it out. */}
              <WireDigest items={items} onPickTheme={setQuery} />
              <NewsFeed
                items={items}
                query={query}
                onQueryChange={setQuery}
                emptyTitle="No headlines available right now."
                emptyDetail="Every configured feed returned nothing. That is usually
                             the network rather than a quiet news day." />
            </>
          )}
        </>
      )}

      {tab === "ticker" && (
        <>
          <div className="max-w-sm mb-4">
            <TickerInput value={ticker} onCommit={setTicker} placeholder="RELIANCE.NS" />
          </div>
          <News ticker={ticker} />
        </>
      )}
    </Shell>
  );
}
