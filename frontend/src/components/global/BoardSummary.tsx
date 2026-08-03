"use client";

import { useMemo } from "react";

import { Note, SectionHeader } from "@/components/ui";
import {
  boardNote, breadth, groupBreadth, riskTone, type Group, type Tile,
} from "@/lib/globalBoard";
import { useLiveTicks } from "@/lib/useQuote";
import { fmtNum } from "@/lib/utils";

/**
 * What the board adds up to.
 *
 * Forty tinted tiles is a good display and it answers nothing on its own — the
 * reader still scans every one to work out whether this is a broad risk-off day
 * or two indices doing something while the rest sit still.
 *
 * It also had no idea how much of itself was working. Free providers rate-limit
 * and get blocked from cloud hosts, so tiles legitimately render unpriced, and
 * a board with half its tiles unpriced looks remarkably like a calm market. The
 * footnote mentioned it; nothing counted it.
 *
 * Reads off the same shared tick store the tiles use, so it adds no requests.
 */
export function BoardSummary({ groups, volSyms }: {
  groups: { title: string; syms: string[] }[];
  /** Volatility symbols, kept out of the breadth count and used for the tone. */
  volSyms: string[];
}) {
  const allSyms = useMemo(
    () => [...new Set([...groups.flatMap((g) => g.syms), ...volSyms])],
    [groups, volSyms]);
  const ticks = useLiveTicks(allSyms);

  const tileFor = (sym: string): Tile => {
    const t = ticks.get(sym.toUpperCase());
    return { sym, changePct: t?.chgPct ?? null };
  };

  const boardGroups: Group[] = useMemo(
    () => groups.map((g) => ({ title: g.title, tiles: g.syms.map(tileFor) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, ticks]);

  const all = useMemo(
    () => breadth(boardGroups.flatMap((g) => g.tiles)), [boardGroups]);
  const perGroup = useMemo(() => groupBreadth(boardGroups), [boardGroups]);
  const risk = useMemo(
    () => riskTone(
      boardGroups.flatMap((g) => g.tiles),
      volSyms.map(tileFor)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardGroups, volSyms, ticks]);

  const TONE_CLASS = {
    "risk-on": "text-green",
    "risk-off": "text-red",
    mixed: "text-txt",
    unknown: "text-mut",
  } as const;

  return (
    <section className="mb-5">
      <SectionHeader
        title="What the board adds up to"
        count={`${all.total - all.unpriced}/${all.total} priced`}
        actions={
          <span className={`text-[11px] capitalize ${TONE_CLASS[risk.tone]}`}>
            {risk.tone}
          </span>
        } />

      <div className="grid gap-2.5 mb-2.5"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="hud p-3">
          <div className="label-xs">Advancing</div>
          <div className="num text-lg mt-0.5 text-green">{all.up}</div>
        </div>
        <div className="hud p-3">
          <div className="label-xs">Declining</div>
          <div className="num text-lg mt-0.5 text-red">{all.down}</div>
        </div>
        <div className="hud p-3" title="Moves under 0.1% are the spread, not a direction">
          <div className="label-xs">Flat</div>
          <div className="num text-lg mt-0.5 text-mut">{all.flat}</div>
        </div>
        <div className="hud p-3"
             title="Subscribed but never priced — a free-provider gap, not a quiet market">
          <div className="label-xs">Unpriced</div>
          <div className={`num text-lg mt-0.5 ${
            all.unpriced > 0 ? "text-amber" : "text-mut"}`}>
            {all.unpriced}
          </div>
        </div>
        <div className="hud p-3" title="Mean move across the tiles that priced">
          <div className="label-xs">Average move</div>
          <div className={`num text-lg mt-0.5 ${
            all.averagePct == null ? "text-mut"
              : all.averagePct >= 0 ? "text-green" : "text-red"}`}>
            {all.averagePct == null
              ? "—"
              : `${all.averagePct >= 0 ? "+" : ""}${fmtNum(all.averagePct, 2)}%`}
          </div>
        </div>
      </div>

      {/* Per region, so a broad day is distinguishable from one region moving. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] mb-2">
        {perGroup.map((g) => (
          <span key={g.title} className="text-mut whitespace-nowrap">
            {g.title}{" "}
            <span className="num text-green">{g.breadth.up}</span>
            <span className="text-mut">/</span>
            <span className="num text-red">{g.breadth.down}</span>
            {g.breadth.unpriced > 0 && (
              <span className="num text-amber/80"> ·{g.breadth.unpriced} unpriced</span>
            )}
          </span>
        ))}
      </div>

      <Note>{boardNote(all, risk)}</Note>
    </section>
  );
}
