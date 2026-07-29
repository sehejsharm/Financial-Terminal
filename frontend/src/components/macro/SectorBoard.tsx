"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import {
  AsyncPanel, Note, SectionHeader, SkeletonCards,
} from "@/components/ui";
import { Methodology } from "@/components/Methodology";
import { useAsync } from "@/lib/useAsync";
import { api, type SectorRow } from "@/lib/api";
import { tintBg, tintBorder } from "@/lib/heat";
import { fmtNum } from "@/lib/utils";

/**
 * Sector bull/bear ratings.
 *
 * The rating is a weighted sum of six measurements, and the whole point of
 * this screen is that you can open any sector and see all six. A rating you
 * can't take apart is an opinion with a number painted on it.
 */

// Scores run −100…+100. Saturating the tint at 60 rather than 100 keeps the
// middle of the range readable — almost nothing scores ±100, and a ramp
// nobody reaches is a ramp that renders everything beige.
const SCORE_SATURATION = 60;

function RatingBadge({ rating, score }: { rating: string | null; score: number | null }) {
  if (rating == null || score == null) {
    return <span className="text-[10px] uppercase tracking-wider text-mut">Unrated</span>;
  }
  const tone = score >= 20 ? "text-green border-green/50"
    : score <= -20 ? "text-red border-red/50"
    : "text-mut border-line2";
  return (
    <span className={`text-[9.5px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded border ${tone}`}>
      {rating}
    </span>
  );
}

function pct(v: number | null | undefined, dp = 1) {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${fmtNum(v, dp)}%`;
}

function toneOf(v: number | null | undefined) {
  return v == null ? "text-mut" : v >= 0 ? "text-green" : "text-red";
}

/** The six components, each as a signed bar around a centre line. */
function Components({ row, labels, weights }: {
  row: SectorRow;
  labels: Record<string, string>;
  weights: Record<string, number>;
}) {
  const keys = Object.keys(weights);
  return (
    <div className="mt-3 pt-3 border-t border-line2 grid gap-1.5">
      {keys.map((k) => {
        const c = row.components?.[k];
        const contrib = row.contributions?.[k];
        const w = Math.round((weights[k] ?? 0) * 100);
        return (
          <div key={k} className="flex items-center gap-2 text-[11px]">
            <span className="text-mut w-[190px] shrink-0 truncate" title={labels[k] ?? k}>
              {labels[k] ?? k}
              <span className="text-[9px] ml-1 opacity-70">{w}%</span>
            </span>
            {/* Centre line at zero so a negative bar grows left and a
                positive one right — the sign is visible before you read. */}
            <span className="relative flex-1 h-2 min-w-[80px] bg-line/50 rounded-sm overflow-hidden">
              <span className="absolute inset-y-0 left-1/2 w-px bg-line2" />
              {c != null && (
                <span className="absolute inset-y-0"
                      style={{
                        left: c >= 0 ? "50%" : `${50 + (c * 50)}%`,
                        width: `${Math.abs(c) * 50}%`,
                        background: c >= 0
                          ? "rgb(var(--c-green) / 0.75)"
                          : "rgb(var(--c-red) / 0.75)",
                      }} />
              )}
            </span>
            <span className={`num w-14 text-right shrink-0 ${
              c == null ? "text-mut" : toneOf(contrib)}`}>
              {c == null ? "n/a" : `${contrib! >= 0 ? "+" : ""}${fmtNum(contrib!, 1)}`}
            </span>
          </div>
        );
      })}
      <div className="text-[10px] text-mut mt-1">
        Points are already weighted and sum to the score. Components marked
        n/a were not measurable from the available history and their weight
        was redistributed across the rest — not counted as zero.
      </div>
    </div>
  );
}

function SectorCard({ row, labels, weights }: {
  row: SectorRow;
  labels: Record<string, string>;
  weights: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const m = row.measures;

  return (
    <div className="hud mb-lift relative overflow-hidden"
         style={{ borderColor: tintBorder(row.score, SCORE_SATURATION) }}>
      <span aria-hidden className="absolute inset-0 pointer-events-none"
            style={{ background: tintBg(row.score, SCORE_SATURATION) }} />
      <button onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="relative w-full text-left px-3.5 py-3">
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={13} className="text-mut shrink-0" />
                : <ChevronRight size={13} className="text-mut shrink-0" />}
          <span className="text-sm text-txt font-medium flex-1 min-w-0 truncate">
            {row.label}
          </span>
          <RatingBadge rating={row.rating} score={row.score} />
        </div>

        {/* Score on its own line. Letting the metrics wrap up beside it made
            short scores sit on one line and long ones on two, so a grid of
            cards read as misaligned for no reason the data supports. */}
        <div className="mt-2 pl-[21px]">
          <div className={`num text-2xl leading-none ${toneOf(row.score)}`}>
            {row.score == null ? "—" : `${row.score > 0 ? "+" : ""}${fmtNum(row.score, 0)}`}
          </div>
          <div className="text-[10.5px] text-mut mt-1.5">
            1M <span className={`num ${toneOf(m.ret_1m)}`}>{pct(m.ret_1m)}</span>
            {"  ·  "}3M <span className={`num ${toneOf(m.ret_3m)}`}>{pct(m.ret_3m)}</span>
            {"  ·  "}vs NIFTY <span className={`num ${toneOf(m.relative_3m)}`}>{pct(m.relative_3m)}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 pl-[21px] text-[10px] text-mut">
          <span>
            {m.from_high_pct == null ? "—" : `${fmtNum(Math.abs(m.from_high_pct), 1)}% below 52w high`}
          </span>
          <span>
            {m.last != null && m.ma200 != null
              ? (m.last >= m.ma200 ? "above 200-DMA" : "below 200-DMA")
              : "200-DMA unavailable"}
          </span>
          <span>
            {row.members_quoted > 0
              ? `${row.advancers}▲ / ${row.decliners}▼ of ${row.members_quoted}`
              : "no breadth reading"}
          </span>
        </div>
        {row.reason && (
          <div className="text-[10px] text-amber/90 mt-1.5 pl-[21px]">{row.reason}</div>
        )}
      </button>

      {open && (
        <div className="relative px-3.5 pb-3.5">
          <Components row={row} labels={labels} weights={weights} />
        </div>
      )}
    </div>
  );
}

export function SectorBoard() {
  // The board fans out over nine index histories and ~70 quotes server-side.
  // It is the slowest screen in the app, which is exactly why it gets an
  // explicit deadline: it used to spin forever with no timeout and no error
  // state when the backend didn't answer.
  const [nonce, setNonce] = useState(0);
  const [at, setAt] = useState<number | null>(null);
  const state = useAsync(
    () => api.macroSectors({ fresh: nonce > 0, timeoutMs: 40_000 })
      .then((m) => { setAt(m.fetchedAt); return m.data; }),
    [nonce],
    { timeoutMs: 45_000 },
  );

  const board = state.data;
  const rated = (board?.sectors ?? []).filter((s) => s.score != null);
  const leader = rated[0];
  const laggard = rated[rated.length - 1];

  return (
    <>
      <SectionHeader
        title="Sector ratings — India"
        count={board ? `${board.rated}/${board.sectors.length} rated` : undefined}
        actions={<DataAge at={at} onRefresh={() => setNonce((n) => n + 1)}
                          busy={state.busy} />}
        note={leader && laggard && leader.key !== laggard.key ? (
          <>
            Strongest <span className="text-green">{leader.label}</span> at{" "}
            <span className="num">{fmtNum(leader.score!, 0)}</span>, weakest{" "}
            <span className="text-red">{laggard.label}</span> at{" "}
            <span className="num">{fmtNum(laggard.score!, 0)}</span>. Click any
            sector to see the six measurements behind its score.
          </>
        ) : undefined}
      />

      <AsyncPanel
        state={state}
        skeleton={<SkeletonCards n={8} rows={4} />}
        isEmpty={(b) => b.sectors.length === 0}
        emptyTitle="No sectors returned."
        emptyDetail="The market-data provider returned nothing for the sector indices."
      >
        {(b) => (
          <>
            <div className="grid gap-2.5 mb-stagger mb-4"
                 style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              {b.sectors.map((s) => (
                <SectorCard key={s.key} row={s}
                            labels={b.component_labels} weights={b.weights} />
              ))}
            </div>
            <Note>{b.note}</Note>
            <Methodology id="sectorRating" className="mt-3" />
          </>
        )}
      </AsyncPanel>
    </>
  );
}
