"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/** "Updated 3m ago" stamp + optional manual refresh button.
 *
 *  Every cached panel should render one of these — the localStorage cache can
 *  serve data hours old, and before this the UI gave no hint. `at` is epoch ms
 *  (from apiFetchMeta.fetchedAt or useLive.updatedAt). */
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
  // Re-render every 15s so the label ages in place.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const ms = at == null ? null : typeof at === "string" ? Date.parse(at) : at;

  let label = "—";
  if (ms != null && !Number.isNaN(ms)) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) label = "just now";
    else if (s < 60) label = `${s}s ago`;
    else if (s < 3600) label = `${Math.floor(s / 60)}m ago`;
    else if (s < 86400) label = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    else label = `${Math.floor(s / 86400)}d ago`;
  }

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
