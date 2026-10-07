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
          aria-label="Refresh now, bypassing the cache"
          title="Refresh now (bypasses cache)"
          // Widens the tap area to the 24px WCAG 2.5.8 AA floor without
          // pushing this inline stamp around; -m-1 pulls the extra padding
          // back out of the layout so nothing shifts.
          //
          // min-h/min-w rather than padding alone, because padding alone was
          // one pixel short: p-1.5 is 6px a side and the icon is 11px, which
          // measures 23x23. The previous comment here claimed it cleared the
          // floor, and it very nearly did.
          className="p-1.5 -m-1 min-w-6 min-h-6 inline-flex items-center justify-center hover:text-amber disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
        </button>
      )}
    </span>
  );
}
