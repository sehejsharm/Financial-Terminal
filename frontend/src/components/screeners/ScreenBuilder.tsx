"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { api, type ScreenClause, type SavedScreenDoc } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

/**
 * The custom screen builder.
 *
 * Two things make it more than a list of inputs:
 *
 *  COVERAGE. Every field shows how many of the scanned names actually carry
 *  it. A filter on a thinly-covered metric returns nothing and looks like "no
 *  company qualifies" when it really means "we don't have that number" — so
 *  the count sits right next to the field, and a thin one is flagged before
 *  you run.
 *
 *  SAVED SCREENS live on the server, not in localStorage, so a screen you
 *  built at your desk is there on your laptop.
 */

const OP_LABEL: Record<string, string> = {
  ">": "greater than", ">=": "at least", "<": "less than",
  "<=": "at most", "=": "equals", between: "between",
};

type FieldMeta = { key: string; label: string; unit: string; group: string };

/**
 * Mirrors lib/screens.py FIELDS. Used until the server responds — and if it
 * never does, the builder still works. The field list is a stable property of
 * the app; making it hostage to a live universe scan meant one slow provider
 * left you staring at an empty dropdown with nothing to select.
 */
const FALLBACK_FIELDS: FieldMeta[] = [
  { key: "mcap_cr", label: "Market cap", unit: "₹cr", group: "Size" },
  { key: "price", label: "Price", unit: "", group: "Size" },
  { key: "change_pct", label: "Change today", unit: "%", group: "Size" },
  { key: "revenue_cr", label: "Revenue", unit: "₹cr", group: "Size" },
  { key: "pe", label: "P/E (trailing)", unit: "x", group: "Valuation" },
  { key: "forward_pe", label: "P/E (forward)", unit: "x", group: "Valuation" },
  { key: "peg", label: "PEG", unit: "x", group: "Valuation" },
  { key: "pb", label: "Price / book", unit: "x", group: "Valuation" },
  { key: "ps", label: "Price / sales", unit: "x", group: "Valuation" },
  { key: "div_yield", label: "Dividend yield", unit: "%", group: "Valuation" },
  { key: "eps_growth", label: "EPS growth", unit: "%", group: "Growth" },
  { key: "sales_growth", label: "Sales growth", unit: "%", group: "Growth" },
  { key: "roce", label: "ROCE", unit: "%", group: "Quality" },
  { key: "roe", label: "ROE", unit: "%", group: "Quality" },
  { key: "profit_margin", label: "Profit margin", unit: "%", group: "Quality" },
  { key: "operating_margin", label: "Operating margin", unit: "%", group: "Quality" },
  { key: "gross_margin", label: "Gross margin", unit: "%", group: "Quality" },
  { key: "fcf_cr", label: "Free cash flow", unit: "₹cr", group: "Quality" },
  { key: "de", label: "Debt / equity", unit: "x", group: "Balance sheet" },
  { key: "current_ratio", label: "Current ratio", unit: "x", group: "Balance sheet" },
  { key: "promoter", label: "Promoter holding", unit: "%", group: "Balance sheet" },
  { key: "pos_52w", label: "52w range position", unit: "%", group: "Technicals" },
  { key: "vs_50d", label: "vs 50-day avg", unit: "%", group: "Technicals" },
  { key: "vs_200d", label: "vs 200-day avg", unit: "%", group: "Technicals" },
  { key: "beta", label: "Beta", unit: "", group: "Technicals" },
];

const ALL_OPS = [">", ">=", "<", "<=", "=", "between"];

export function ScreenBuilder({ onRun, busy }: {
  onRun: (filters: ScreenClause[], match: "all" | "any", sectors: string[]) => void;
  busy: boolean;
}) {
  const [meta, setMeta] = useState<{
    fields: FieldMeta[]; ops: string[]; sectors: string[];
    coverage: Record<string, number>; evaluable: number; scanned: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [filters, setFilters] = useState<ScreenClause[]>(
    [{ key: "mcap_cr", op: ">", value: 20000 }]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [sectors, setSectors] = useState<string[]>([]);

  const [saved, setSaved] = useState<SavedScreenDoc[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.screenFields()
      .then(setMeta)
      .catch((e: any) => setErr(e?.detail || "Could not load the field list."));
    api.listSavedScreens()
      .then((r) => setSaved(r.screens ?? []))
      .catch(() => setSaved([]));
  }, []);

  const fields = meta?.fields?.length ? meta.fields : FALLBACK_FIELDS;

  const byGroup = useMemo(() => {
    const out = new Map<string, FieldMeta[]>();
    for (const f of fields) {
      if (!out.has(f.group)) out.set(f.group, []);
      out.get(f.group)!.push(f);
    }
    return [...out.entries()];
  }, [fields]);

  const fieldOf = useCallback(
    (key: string) => fields.find((f) => f.key === key), [fields]);

  /** Fields the scan barely populates — filtering on one throws away every
   *  name it can't evaluate. */
  const thinFor = useCallback((key: string) => {
    if (!meta) return false;
    return (meta.coverage[key] ?? 0) < Math.max(1, meta.evaluable * 0.4);
  }, [meta]);

  const thinUsed = filters.map((f) => f.key).filter(thinFor);

  function setF(i: number, patch: Partial<ScreenClause>) {
    setFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  async function persist(next: SavedScreenDoc[]) {
    setSaved(next);
    setSaving(true);
    try { await api.saveScreens(next); setErr(null); }
    catch (e: any) { setErr(e?.detail || "Could not save to the server."); }
    finally { setSaving(false); }
  }

  function saveCurrent() {
    const name = saveName.trim();
    if (!name) return;
    const existing = saved.find((s) => s.name === name);
    const doc: SavedScreenDoc = {
      id: existing?.id ?? `scr_${Date.now().toString(36)}`,
      name, filters, match, sectors,
    };
    setSaveName("");
    persist([...saved.filter((s) => s.id !== doc.id), doc]);
  }

  function load(s: SavedScreenDoc) {
    setFilters(s.filters.length ? s.filters : [{ key: "mcap_cr", op: ">", value: 0 }]);
    setMatch(s.match === "any" ? "any" : "all");
    setSectors(s.sectors ?? []);
    onRun(s.filters, s.match === "any" ? "any" : "all", s.sectors ?? []);
  }

  return (
    <div className="hud p-3 mb-4">
      {err && <div className="mb-3"><PanelError error={err} /></div>}

      {/* ── saved screens ── */}
      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3 pb-3 border-b border-line2">
          <span className="label-xs">Saved</span>
          {saved.map((s) => (
            <span key={s.id} className="inline-flex items-center">
              <button onClick={() => load(s)}
                      className="text-[11px] px-2 py-1 rounded-l border border-line2 text-txt hover:border-amber">
                {s.name}
              </button>
              <button onClick={() => {
                        if (confirm(`Delete the saved screen "${s.name}"?`)) {
                          persist(saved.filter((x) => x.id !== s.id));
                        }
                      }}
                      title={`Delete "${s.name}"`}
                      className="px-1 py-1 rounded-r border border-l-0 border-line2 text-mut hover:text-red">
                <Trash2 size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── clauses ── */}
      <div className="flex flex-col gap-2">
        {filters.map((f, i) => {
          const fm = fieldOf(f.key);
          const cov = meta?.coverage[f.key];
          const thin = thinFor(f.key);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-mut w-8 shrink-0">
                {i === 0 ? "WHERE" : match === "all" ? "AND" : "OR"}
              </span>

              <select value={f.key} onChange={(e) => setF(i, { key: e.target.value })}
                      className="input-bare !py-1 text-xs min-w-[170px]">
                {byGroup.map(([g, list]) => (
                  <optgroup key={g} label={g}>
                    {list.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}{x.unit ? ` (${x.unit})` : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <select value={f.op} onChange={(e) => setF(i, { op: e.target.value })}
                      className="input-bare !py-1 text-xs w-[118px]">
                {(meta?.ops?.length ? meta.ops : ALL_OPS).map((o) => (
                  <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>
                ))}
              </select>

              <input type="number" value={f.value ?? ""}
                     onChange={(e) => setF(i, {
                       value: e.target.value === "" ? null : parseFloat(e.target.value),
                     })}
                     className="input-bare !py-1 text-xs num w-24" />

              {f.op === "between" && (
                <>
                  <span className="text-[10px] text-mut">and</span>
                  <input type="number" value={f.value2 ?? ""}
                         onChange={(e) => setF(i, {
                           value2: e.target.value === "" ? null : parseFloat(e.target.value),
                         })}
                         className="input-bare !py-1 text-xs num w-24" />
                </>
              )}

              {cov != null && meta && (
                <span className={`text-[10px] ${thin ? "text-amber" : "text-mut"}`}
                      title={`${cov} of ${meta.evaluable} scanned names have a value for ${fm?.label ?? f.key}.`
                        + (thin ? " Filtering on it discards everything it can't evaluate." : "")}>
                  {cov}/{meta.evaluable} covered
                </span>
              )}

              <button onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
                      disabled={filters.length <= 1}
                      className="text-mut hover:text-red disabled:opacity-30 ml-auto"
                      title="Remove this condition">
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/* ── controls ── */}
      <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-line2">
        <button onClick={() => setFilters((fs) => [...fs, { key: "pe", op: "<", value: 25 }])}
                disabled={filters.length >= 12}
                className="btn-ghost text-[11px] flex items-center gap-1 disabled:opacity-40">
          <Plus size={11} /> Condition
        </button>

        <label className="flex items-center gap-1.5 text-[11px] text-mut">
          Match
          <select value={match} onChange={(e) => setMatch(e.target.value as "all" | "any")}
                  className="input-bare !py-1 text-xs">
            <option value="all">all conditions</option>
            <option value="any">any condition</option>
          </select>
        </label>

        {meta && meta.sectors.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-mut"
                 title="Leave empty to include every sector">
            Sector
            <select multiple={false}
                    value={sectors[0] ?? ""}
                    onChange={(e) => setSectors(e.target.value ? [e.target.value] : [])}
                    className="input-bare !py-1 text-xs max-w-[170px]">
              <option value="">All sectors</option>
              {meta.sectors.map((sx) => <option key={sx} value={sx}>{sx}</option>)}
            </select>
          </label>
        )}

        <div className="flex-1" />

        <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") saveCurrent(); }}
               placeholder="Save as…" className="input-bare !py-1 w-28 text-[11px]" />
        <button onClick={saveCurrent} disabled={!saveName.trim() || saving}
                className="btn-ghost text-[11px] flex items-center gap-1 disabled:opacity-40">
          <Save size={11} /> {saving ? "Saving…" : "Save"}
        </button>

        <button onClick={() => onRun(filters, match, sectors)} disabled={busy}
                className="btn-primary text-[11px] disabled:opacity-50">
          {busy ? "Scanning…" : "Run screen"}
        </button>
      </div>

      {/* ── coverage warning, before you run into an empty result ── */}
      {thinUsed.length > 0 && meta && (
        <div className="text-[10.5px] text-amber mt-2.5">
          {thinUsed.map((k) => fieldOf(k)?.label ?? k).join(", ")}{" "}
          {thinUsed.length === 1 ? "is" : "are"} sparsely covered on this data
          plan — a condition on {thinUsed.length === 1 ? "it" : "them"} drops every
          name without the number, which is usually most of them. Expect few or no
          matches.
        </div>
      )}

      {!meta && !err && (
        <div className="text-[10.5px] text-mut mt-2">
          Loading live coverage counts… you can build and run a screen now; the
          per-field coverage numbers appear once the universe scan reports in.
        </div>
      )}

      {meta && (
        <div className="text-[10.5px] text-mut mt-2">
          Scanning {meta.evaluable} of {meta.scanned} universe names that returned
          usable fundamentals. {meta.fields.length} filterable fields.
          Coverage counts are live — they reflect what the providers actually
          returned on the last scan, not what they advertise.
          {" "}Fields: {fields.length}.
        </div>
      )}
    </div>
  );
}
