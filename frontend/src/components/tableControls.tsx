"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

/** Client-side sort + filter + pagination for data tables (screener, bulk
 *  deals, audit log). Keeps each table's own cell renderers — this only
 *  transforms the row array and provides header/toolbar/pager UI. */

export type TableCtl<T> = {
  pageRows: T[];
  total: number;
  filtered: number;
  page: number;
  pages: number;
  setPage: (p: number) => void;
  sortKey: string | null;
  sortDir: 1 | -1;
  requestSort: (k: string) => void;
  filter: string;
  setFilter: (f: string) => void;
};

export function useTableControls<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  pageSize = 50,
): TableCtl<T> {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [filter, setFilterRaw] = useState("");
  const [page, setPage] = useState(0);

  const all = rows ?? [];

  const processed = useMemo(() => {
    let out = all;
    const f = filter.trim().toLowerCase();
    if (f) {
      out = out.filter((r) =>
        Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(f)));
    }
    if (sortKey) {
      out = [...out].sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;   // nulls sink regardless of direction
        if (vb == null) return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * sortDir;
        return String(va).localeCompare(String(vb)) * sortDir;
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filter, sortKey, sortDir]);

  const pages = Math.max(1, Math.ceil(processed.length / pageSize));
  const safePage = Math.min(page, pages - 1);

  function requestSort(k: string) {
    setPage(0);
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(-1); }
  }
  function setFilter(f: string) { setPage(0); setFilterRaw(f); }

  return {
    pageRows: processed.slice(safePage * pageSize, (safePage + 1) * pageSize),
    total: all.length,
    filtered: processed.length,
    page: safePage,
    pages,
    setPage,
    sortKey, sortDir, requestSort,
    filter, setFilter,
  };
}

export function SortableTh<T>({ label, k, ctl, align = "left", className = "" }: {
  label: string; k: string; ctl: TableCtl<T>;
  align?: "left" | "right"; className?: string;
}) {
  const active = ctl.sortKey === k;
  return (
    <th
      onClick={() => ctl.requestSort(k)}
      className={`px-3 py-2 font-medium whitespace-nowrap cursor-pointer select-none hover:text-amber ${align === "right" ? "text-right" : "text-left"} ${active ? "text-amber" : ""} ${className}`}
      title={`Sort by ${label}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (ctl.sortDir === -1 ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
      </span>
    </th>
  );
}

export function TableToolbar<T>({ ctl, placeholder = "Filter rows…" }: {
  ctl: TableCtl<T>; placeholder?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-2">
      <input
        value={ctl.filter}
        onChange={(e) => ctl.setFilter(e.target.value)}
        placeholder={placeholder}
        className="input-bare !py-1.5 text-xs w-56 max-w-full"
      />
      <span className="text-[11px] text-mut">
        {ctl.filter ? `${ctl.filtered} of ${ctl.total} rows` : `${ctl.total} rows`}
      </span>
    </div>
  );
}

export function Pager<T>({ ctl }: { ctl: TableCtl<T> }) {
  if (ctl.pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 mt-2 text-xs">
      <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0}
              className="btn-ghost !py-1 disabled:opacity-40">‹ Prev</button>
      <span className="text-mut">page {ctl.page + 1} / {ctl.pages}</span>
      <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pages - 1}
              className="btn-ghost !py-1 disabled:opacity-40">Next ›</button>
    </div>
  );
}
