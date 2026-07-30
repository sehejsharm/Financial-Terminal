"use client";

import Link from "next/link";
import { useMemo } from "react";

import { Methodology } from "@/components/Methodology";
import { Note, SectionHeader } from "@/components/ui";
import {
  digestNote, feedHealth, mentions, themes, type Item,
} from "@/lib/wireDigest";

/**
 * What today is about, above the wire.
 *
 * The feed itself was already good — deduplicated, clustered, filterable. What
 * it left the reader was the one job that matters: scanning a hundred and
 * twenty lines to work out what the day is about. Three questions answer that,
 * and all three come off the headlines already fetched:
 *
 *   which listed companies are in the news, what subject keeps recurring, and
 *   is the wire healthy enough that a quiet page means a quiet market.
 *
 * The last one is not decoration. A page that looks calm because three feeds
 * are down is indistinguishable from a calm market, and only the feed report
 * separates them.
 */
export function WireDigest({ items, onPickTheme }: {
  items: Item[];
  /** Clicking a theme drops it into the feed's own search box. */
  onPickTheme?: (phrase: string) => void;
}) {
  const named = useMemo(() => mentions(items), [items]);
  const subjects = useMemo(() => themes(items), [items]);
  const health = useMemo(() => feedHealth(items), [items]);

  if (!items.length) return null;

  const top = named.slice(0, 12);

  return (
    <div className="mb-6">
      <SectionHeader
        title="What the wire is saying"
        count={`${items.length} headlines`}
        actions={
          health.silent.length > 0 ? (
            <span className="text-[10.5px] text-amber/90 whitespace-nowrap"
                  title={`No items this pull from: ${health.silent.join(", ")}`}>
              {health.silent.length} feed{health.silent.length === 1 ? "" : "s"} silent
            </span>
          ) : (
            <span className="text-[10.5px] text-mut whitespace-nowrap">
              {health.sources.length} sources reporting
            </span>
          )
        } />

      {top.length > 0 && (
        <div className="mb-3">
          <div className="label-xs mb-2">Companies in the news</div>
          <div className="flex flex-wrap gap-1.5" data-testid="wire-companies">
            {top.map((m) => (
              <Link key={m.ticker}
                    href={`/terminal?t=${encodeURIComponent(m.ticker)}&fn=CN`}
                    title={m.headline}
                    className="flex items-center gap-1.5 px-2 py-1 rounded border
                               border-line2 hover:border-amber/60 hover:text-amber
                               transition-colors text-[11px]">
                <span className="truncate max-w-[180px]">{m.name}</span>
                {/* The count is the point of the chip — never let it shrink
                    away behind a long company name. */}
                <span className="num text-[10px] text-mut shrink-0">{m.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {subjects.length > 0 && (
        <div className="mb-3">
          <div className="label-xs mb-2">Recurring subjects</div>
          <div className="flex flex-wrap gap-1.5">
            {subjects.map((t) => (
              <button key={t.phrase}
                      onClick={() => onPickTheme?.(t.phrase)}
                      title={t.example}
                      className="flex items-center gap-1.5 px-2 py-1 rounded border
                                 border-line2 hover:border-amber/60 hover:text-amber
                                 transition-colors text-[11px]">
                <span className="truncate max-w-[200px]">{t.phrase}</span>
                <span className="num text-[10px] text-mut shrink-0">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {health.sources.length > 0 && (
        <div className="mb-2">
          <div className="label-xs mb-2">Where these came from</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px]">
            {health.sources.map((s) => (
              <span key={s.name} className="text-mut whitespace-nowrap">
                {s.name} <span className="num text-txt">{s.n}</span>
              </span>
            ))}
            {health.silent.map((s) => (
              <span key={s} className="text-red/70 whitespace-nowrap"
                    title="Configured, but returned nothing this pull">
                {s} <span className="num">0</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <Note>{digestNote(named, subjects, health)}</Note>
      <Methodology id="wireDigest" className="mt-3" />
    </div>
  );
}
