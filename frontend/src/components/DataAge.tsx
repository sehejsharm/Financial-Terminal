"use client";

import { RefreshCw } from "lucide-react";

import { formatAge, useNow } from "@/lib/clock";

/** "Updated 3m ago" stamp + optional manual refresh button.
 *
 *  Every cached panel should render one of these — the localStorage cache can
 *  serve data hours old, and before this the UI gave no hint. `at` is epoch ms
 *  (from apiFetchMeta.fetchedAt or useLive.updatedAt). The label ages against
 *  the shared app clock, so every DataAge on the page stays in lock-step. */
export function DataAge({
  at,
  onRefresh,
  busy,
  prefix = "Updated",
}: {
  at: number | string | null | undefined;
  onRefresh?: () => void;
  busy?: boolean;
  prefix?: string;
}) {
  const now = useNow();
  const label = formatAge(at, now);

  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] text-mut whitespace-nowrap">
      <span>{prefix} {label}</span>
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={busy}
          title="Refresh now (bypasses cache)"
          className="hover:text-amber disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
        </button>
      )}
    </span>
  );
}
