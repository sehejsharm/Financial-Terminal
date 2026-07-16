"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";

type Hit = { symbol: string; name: string; exchange?: string };

/** Ticker input with debounced typeahead (symbol + company name).
 *  Keyboard: ↑/↓ move, Enter commits highlighted (or raw text), Esc closes. */
export function TickerInput({
  value, onCommit, placeholder, className,
}: {
  value: string;
  onCommit: (ticker: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const skipSearchRef = useRef(false);

  useEffect(() => { setText(value); }, [value]);

  // Debounced search while typing.
  useEffect(() => {
    if (skipSearchRef.current) { skipSearchRef.current = false; return; }
    const q = text.trim();
    if (q.length < 2 || q.toUpperCase() === value.toUpperCase()) {
      setHits([]); setOpen(false); return;
    }
    const id = setTimeout(() => {
      api.search(q)
        .then((h) => { setHits((h ?? []).slice(0, 8)); setOpen(true); setSel(-1); })
        .catch(() => { setHits([]); setOpen(false); });
    }, 250);
    return () => clearTimeout(id);
  }, [text, value]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function commit(t: string) {
    skipSearchRef.current = true;
    setText(t.toUpperCase());
    setOpen(false); setHits([]);
    onCommit(t.toUpperCase());
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open && hits.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % hits.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + hits.length) % hits.length); return; }
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key === "Enter" && sel >= 0) { e.preventDefault(); commit(hits[sel].symbol); return; }
    }
    if (e.key === "Enter") commit((e.target as HTMLInputElement).value.trim());
  }

  return (
    <div ref={boxRef} className="relative min-w-0">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => { /* commit stays explicit (Enter/click) to avoid surprise loads */ }}
        placeholder={placeholder}
        className={className ?? "input-bare w-full"}
        autoComplete="off"
        spellCheck={false}
      />
      {open && hits.length > 0 && (
        <div className="absolute z-40 top-full left-0 right-0 mt-1 panel-2 shadow-panel max-h-72 overflow-y-auto">
          {hits.map((h, i) => (
            <button
              key={h.symbol}
              onMouseDown={(e) => { e.preventDefault(); commit(h.symbol); }}
              onMouseEnter={() => setSel(i)}
              className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm ${i === sel ? "bg-panel text-amber" : "text-txt"}`}
            >
              <span className="text-amber font-bold w-28 truncate shrink-0">{h.symbol}</span>
              <span className="flex-1 truncate text-xs">{h.name}</span>
              {h.exchange && <span className="text-mut text-[10px] shrink-0">{h.exchange}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
