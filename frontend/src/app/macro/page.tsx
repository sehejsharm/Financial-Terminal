"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { Shell } from "@/components/Shell";
import { SectorBoard } from "@/components/macro/SectorBoard";
import {
  ChipToggle, EmptyState, ErrorState, Loading, Note, PageHeader, Section,
  Stat, Tabs, type TabDef,
} from "@/components/ui";
import { api, type CalendarRow, type Indicator, type YieldCurve, type YieldPoint } from "@/lib/api";
import {
  coverage, directionOf, GROUP_BLURB, GROUP_LABEL, groupIndicators,
  pillarReports, regimeNote, regimeSummary,
} from "@/lib/macroRegime";
import { fmtNum } from "@/lib/utils";

// India first, and the default. This is an India-first terminal; opening the
// macro screen on the US meant the home market was always one click away.
const COUNTRY_ORDER = ["IN", "US", "EU", "UK", "JP", "CN"];

const COUNTRY_LABELS: Record<string, { label: string; flag: string; blurb: string }> = {
  IN: {
    label: "India", flag: "🇮🇳",
    blurb: "Growth, prices, policy, labour and the external balance for the "
      + "home market, plus bull/bear ratings for every NSE sector index.",
  },
  US: { label: "United States", flag: "🇺🇸", blurb: "The deepest series coverage of any market here — and the only one with a full free constant-maturity yield curve." },
  EU: { label: "Eurozone", flag: "🇪🇺", blurb: "Aggregate euro-area series; national detail is not carried by the free feed." },
  UK: { label: "United Kingdom", flag: "🇬🇧", blurb: "" },
  JP: { label: "Japan", flag: "🇯🇵", blurb: "" },
  CN: { label: "China", flag: "🇨🇳", blurb: "Thin coverage: most Chinese series on the free feed are annual or retired." },
};

type Tab = "overview" | "sectors" | "curve" | "calendar";

const TABS: readonly TabDef<Tab>[] = [
  { id: "overview", label: "Economy", hint: "Indicator blocks and the pillar read" },
  { id: "sectors", label: "Sectors", hint: "Bull/bear ratings for the NSE sector indices" },
  { id: "curve", label: "Yield curve" },
  { id: "calendar", label: "Releases" },
];

function YieldCurveChart({ points }: { points: YieldPoint[] }) {
  if (!points.length) return null;
  const W = 760, H = 280, padX = 52, padY = 34;
  const ys = points.map((p) => p.yield);
  const yMin = Math.min(...ys) - 0.25, yMax = Math.max(...ys) + 0.25;
  // Even (categorical) spacing by maturity — a yield curve is read left→right by
  // tenor, not by absolute years, so 1M…3Y don't bunch up on the far left.
  const n = points.length;
  const sx = (i: number) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (W - 2 * padX);
  const sy = (y: number) => H - padY - ((y - yMin) / (yMax - yMin || 1)) * (H - 2 * padY);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(i).toFixed(1)} ${sy(p.yield).toFixed(1)}`).join(" ");
  const inverted = ys[0] > ys[ys.length - 1];
  const stroke = inverted ? "#ff4d4f" : "#ffb000";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet" style={{ minWidth: 600 }}>
      {[0, 1, 2, 3, 4].map((i) => {
        const y = padY + (i * (H - 2 * padY)) / 4;
        const v = yMax - (i * (yMax - yMin)) / 4;
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={W - padX} y2={y} stroke="#1c2129" strokeWidth={1} />
            <text x={padX - 8} y={y + 4} textAnchor="end" fontSize={10} fill="#7d8694"
                  fontFamily="JetBrains Mono, monospace">{v.toFixed(2)}%</text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke={stroke} strokeWidth={2.5} />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={sx(i)} cy={sy(p.yield)} r={3.5} fill={stroke} />
          <text x={sx(i)} y={sy(p.yield) - 10} textAnchor="middle" fontSize={9}
                fill="#cdd1d8" fontFamily="JetBrains Mono, monospace">{p.yield.toFixed(2)}</text>
          <text x={sx(i)} y={H - 10} textAnchor="middle" fontSize={10} fill="#7d8694"
                fontFamily="JetBrains Mono, monospace">{p.maturity}</text>
        </g>
      ))}
    </svg>
  );
}

/** Formats a number in an indicator's unit, without inventing precision. */
function inUnit(v: number, u: string): string {
  if (u === "%") return `${fmtNum(v, 2)}%`;
  if (u === "count") return fmtNum(v, 0);
  if (u === "USD") {
    // World Bank GDP and reserves arrive in raw dollars; billions is the
    // only unit anyone reads them in — and the change has to be shown the
    // same way, or a card reports "+300,000,000,000.00 vs prior".
    const bn = Math.abs(v) / 1e9;
    return bn >= 1 ? `$${fmtNum(v / 1e9, 1)}bn` : `$${fmtNum(v, 0)}`;
  }
  if (u === "index" || u === "k") return fmtNum(v, 1);
  return `${fmtNum(v, 2)} ${u}`;
}

function indValue(ind: Indicator): string {
  return ind.value == null ? "—" : inUnit(ind.value, ind.unit);
}

const LEAN_TONE = {
  improving: "text-green", deteriorating: "text-red",
  mixed: "text-amber", null: "text-mut",
} as const;

// Written out rather than CSS-capitalised: `capitalize` turns the fallback
// into "No Signed Direction", which reads like a headline.
const LEAN_LABEL = {
  improving: "Improving", deteriorating: "Deteriorating",
  mixed: "Mixed", null: "No clear direction",
} as const;

export default function MacroPage() {
  const [countries, setCountries] = useState<string[]>(COUNTRY_ORDER);
  const [country, setCountry] = useState("IN");
  const [tab, setTab] = useState<Tab>("overview");
  const [inds, setInds] = useState<Indicator[] | null>(null);
  const [indsAt, setIndsAt] = useState<number | null>(null);
  const [curve, setCurve] = useState<YieldCurve | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sector ratings are Indian by construction; mounting the board once it's
  // been opened keeps its 15-minute-cached fetch from repeating on every
  // tab switch.
  const [sectorsOpened, setSectorsOpened] = useState(false);

  useEffect(() => {
    api.macroCountries()
      // Keep our display order regardless of what order the API lists them
      // in, and append anything new the backend gains later.
      .then((cs) => setCountries([
        ...COUNTRY_ORDER.filter((c) => cs.includes(c)),
        ...cs.filter((c) => !COUNTRY_ORDER.includes(c)),
      ]))
      .catch(() => {});
  }, []);

  const loadCurve = useCallback((fresh = false) => {
    api.yieldCurve(country, { fresh })
      .then((m) => setCurve(m.data))
      .catch(() => setCurve({ country, points: [], note: "Yield curve unavailable." }));
  }, [country]);
  useEffect(() => { setCurve(null); loadCurve(); }, [loadCurve]);

  const loadInds = useCallback((fresh = false) => {
    setBusy(true); setErr(null);
    api.macroIndicators(country, { fresh })
      .then((m) => { setInds(m.data); setIndsAt(m.fetchedAt); })
      .catch((e) => setErr(e?.detail || "Macro feed unavailable."))
      .finally(() => setBusy(false));
  }, [country]);
  useEffect(() => { setInds(null); setIndsAt(null); loadInds(); }, [loadInds]);

  const [cal, setCal] = useState<{ rows: CalendarRow[]; note: string } | null>(null);
  useEffect(() => {
    setCal(null);
    api.macroCalendar(country).then(setCal).catch(() => setCal({ rows: [], note: "" }));
  }, [country]);

  const pts = curve?.points ?? [];
  // Badge must agree with the "10Y-2Y spread" indicator card above it: prefer
  // that card's CURRENT value (same FRED series, same observation) and only
  // fall back to computing from the curve points, whose constituent series
  // can lag a day behind and made the badge show yesterday's ("prior") spread.
  const spread10y2y = (() => {
    const ind = inds?.find((i) => i.name === "10Y-2Y spread");
    if (ind?.value != null) return ind.value;
    const y2 = pts.find((p) => p.maturity === "2Y")?.yield;
    const y10 = pts.find((p) => p.maturity === "10Y")?.yield;
    return y2 != null && y10 != null ? y10 - y2 : null;
  })();

  // Series that returned nothing are not shown as empty cards — they're
  // counted in the coverage line instead. A grid of dashes tells the reader
  // nothing except that something is broken somewhere.
  const reported = useMemo(() => (inds ?? []).filter((i) => i.value != null), [inds]);
  const grouped = useMemo(() => groupIndicators(reported), [reported]);
  const regime = useMemo(() => regimeSummary(reported), [reported]);
  const pillars = useMemo(() => pillarReports(reported), [reported]);
  const cov = useMemo(() => coverage(inds ?? []), [inds]);

  const inversion = spread10y2y != null
    ? spread10y2y < 0
    : (pts.length >= 2 ? pts[0].yield > pts[pts.length - 1].yield : false);

  const meta = COUNTRY_LABELS[country];

  return (
    <Shell>
      <PageHeader
        title="MACRO"
        subtitle={meta?.blurb || undefined}
        actions={<DataAge at={indsAt} onRefresh={() => { loadInds(true); loadCurve(true); }} busy={busy} />}
      >
        <ChipToggle
          value={country}
          onChange={setCountry}
          options={countries.map((c) => ({
            id: c,
            label: `${COUNTRY_LABELS[c]?.flag ?? ""} ${COUNTRY_LABELS[c]?.label ?? c}`,
          }))}
        />
      </PageHeader>

      <Tabs tabs={TABS} value={tab}
            onChange={(t) => { setTab(t); if (t === "sectors") setSectorsOpened(true); }} />

      {tab === "overview" && (
        <>
          {err && (
            <ErrorState
              message={err}
              onRetry={() => loadInds(true)}
              hint={<>Add <code className="text-amber">FRED_API_KEY</code> to the backend
                env. Free key at{" "}
                <a className="text-amber underline" href="https://fredaccount.stlouisfed.org/apikeys"
                   target="_blank" rel="noopener noreferrer">fredaccount.stlouisfed.org</a>.</>}
            />
          )}

          {!err && busy && !inds && <Loading what={`${meta?.label ?? country} indicators`} />}

          {inds && reported.length === 0 && !busy && (
            <EmptyState
              title={`No ${meta?.label ?? country} series reported a value.`}
              detail={`All ${cov.total} configured series came back empty. Several of `
                + "these come from OECD collections FRED has been retiring since "
                + "2024; the feed is reachable, the series are not."} />
          )}

          {reported.length > 0 && (
            <>
              {/* The pillar read, before the detail: five blocks, each with
                  its own balance, so "how is this economy doing" is one
                  glance rather than a scan of twenty cards. */}
              <Section
                title="The read"
                note={<>
                  {regimeNote(regime)}{" "}
                  {cov.reported < cov.total && (
                    <span className="text-amber">
                      {cov.reported} of {cov.total} configured series reported a
                      value; the rest are omitted rather than shown blank.
                    </span>
                  )}
                </>}
              >
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5 mb-stagger">
                  {pillars.map((p) => (
                    <div key={p.group} className="hud mb-lift p-3.5">
                      <div className="label-xs">{GROUP_LABEL[p.group]}</div>
                      <div className={`text-[15px] mt-1 ${
                        LEAN_TONE[(p.lean ?? "null") as keyof typeof LEAN_TONE]}`}>
                        {LEAN_LABEL[(p.lean ?? "null") as keyof typeof LEAN_LABEL]}
                      </div>
                      <div className="flex gap-2 mt-1.5 text-[10.5px] num">
                        <span className="text-green">{p.good}↑</span>
                        <span className="text-red">{p.bad}↓</span>
                        <span className="text-mut">{p.neutral}·</span>
                        {p.stale > 0 && <span className="text-amber">{p.stale} stale</span>}
                      </div>
                      <div className="text-[10px] text-mut mt-1.5 leading-relaxed">
                        {GROUP_BLURB[p.group]}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              {/* Grouped into the blocks a macro desk actually thinks in,
                  rather than one undifferentiated grid the reader sorts. */}
              {grouped.map(([group, list]) => (
                <Section key={group} title={GROUP_LABEL[group]} count={list.length}>
                  {/* Fixed tracks, not auto-fit: a block with one series
                      stretched a single card across the whole page. */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-stagger">
                    {list.map((ind) => {
                      const dir = directionOf(ind.name, ind.change);
                      return (
                        <Stat
                          key={ind.name}
                          label={
                            <span className="flex items-center gap-1.5">
                              <span className="truncate flex-1">{ind.name}</span>
                              {ind.stale && (
                                <span className="text-[9px] px-1 py-0.5 rounded border border-amber/50 text-amber shrink-0"
                                      title={`Last observation ${ind.date ?? "unknown"} — older than expected for this indicator's release cadence.`}>
                                  Stale
                                </span>
                              )}
                            </span>
                          }
                          value={indValue(ind)}
                          tone={ind.stale ? "warn" : "neutral"}
                          sub={
                            <span className="flex items-center justify-between gap-2">
                              <span
                                title={dir === "neutral" && ind.change != null
                                  ? "This series has no inherently good or bad direction, so it isn't coloured."
                                  : undefined}
                                className={
                                  ind.change == null ? "text-mut"
                                    : dir === "good" ? "text-green"
                                    : dir === "bad" ? "text-red" : "text-txt"}>
                                {ind.change != null
                                  ? `${ind.change >= 0 ? "▲" : "▼"} ${inUnit(Math.abs(ind.change), ind.unit)} vs prior`
                                  : "no prior"}
                              </span>
                              <span className="text-mut whitespace-nowrap">{ind.date ?? "—"}</span>
                            </span>
                          }
                        />
                      );
                    })}
                  </div>
                </Section>
              ))}
            </>
          )}
        </>
      )}

      {/* Kept mounted once opened rather than remounted per tab switch: the
          board is one 15-minute-cached fetch over nine index histories, and
          throwing it away to re-request it on every glance is rude to a
          single-worker backend. */}
      {sectorsOpened && (
        <div className={tab === "sectors" ? "" : "hidden"}><SectorBoard /></div>
      )}

      {tab === "curve" && (
        <>
          {!curve && <Loading what="yield curve" />}
          {curve && pts.length > 0 && (
            <Section
              title={country === "US" ? "US Treasury yield curve"
                : `${meta?.label ?? country} sovereign yield curve`}
              actions={
                <div className="flex gap-3 text-[11px]">
                  {spread10y2y != null && (
                    <span className={spread10y2y < 0 ? "text-red" : "text-mut"}>
                      10Y–2Y <span className="num">{spread10y2y >= 0 ? "+" : ""}{spread10y2y.toFixed(2)}%</span>
                    </span>
                  )}
                  <span className={inversion ? "text-red" : "text-green"}>
                    {inversion ? "INVERTED" : "NORMAL"}
                  </span>
                </div>
              }
            >
              <div className="panel-2 p-4 mb-3 overflow-x-auto">
                <YieldCurveChart points={pts} />
              </div>
              <Note>
                An inverted curve (short rates above long rates) has historically
                preceded recessions. 10Y–2Y is the spread most often cited as a
                signal. Historically is doing a lot of work in that sentence:
                the sample is a handful of cycles, and the lead time has ranged
                from months to over two years.
              </Note>
            </Section>
          )}
          {curve && pts.length === 0 && (
            <EmptyState
              title={`No sovereign curve for ${meta?.label ?? country}.`}
              detail={curve.note || "Not available for this market."} />
          )}
        </>
      )}

      {tab === "calendar" && (
        <>
          {!cal && <Loading what="release calendar" />}
          {cal && cal.rows.length === 0 && (
            <EmptyState title="No release calendar for this market."
                        detail="Every series here is daily, so none of them has a release cadence to schedule." />
          )}
          {cal && cal.rows.length > 0 && (
            <Section title={`Release calendar — ${meta?.label ?? country}`}
                     count={cal.rows.length} note={cal.note}>
              <div className="panel overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-mut uppercase tracking-wider">
                    <tr className="border-b border-line">
                      <th className="text-left px-3 py-2 font-medium">Indicator</th>
                      <th className="text-right px-3 py-2 font-medium">Last</th>
                      <th className="text-right px-3 py-2 font-medium">Prior</th>
                      <th className="text-right px-3 py-2 font-medium">Surprise (vs prior)</th>
                      <th className="text-right px-3 py-2 font-medium">Last release</th>
                      <th className="text-right px-3 py-2 font-medium">Next (est.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cal.rows.map((r) => (
                      <tr key={r.name} className="border-b border-line/60 hover:bg-panel">
                        <td className="px-3 py-2">
                          {r.name}
                          {r.stale && <span className="ml-2 text-[9px] px-1 py-0.5 rounded border border-amber/50 text-amber uppercase">Stale</span>}
                        </td>
                        <td className="px-3 py-2 num text-right">{r.last_value != null ? fmtNum(r.last_value, 2) : "—"}</td>
                        <td className="px-3 py-2 num text-right">{r.prior != null ? fmtNum(r.prior, 2) : "—"}</td>
                        <td className={`px-3 py-2 num text-right ${r.surprise_vs_prior == null ? "text-mut" : r.surprise_vs_prior >= 0 ? "text-green" : "text-red"}`}>
                          {r.surprise_vs_prior != null ? `${r.surprise_vs_prior >= 0 ? "+" : ""}${fmtNum(r.surprise_vs_prior, 2)}` : "—"}
                        </td>
                        <td className="px-3 py-2 num text-right text-mut">{r.last_release ?? "—"}</td>
                        <td className="px-3 py-2 num text-right">{r.next_release_est ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
    </Shell>
  );
}
