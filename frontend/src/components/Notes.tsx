"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { Note } from "@/components/ui";
import { api } from "@/lib/api";
import {
  AUTOSAVE_MS, clearDraft, counts, loadDraft, saveDraft, shouldRecover, stamp,
  type Draft,
} from "@/lib/noteDraft";
import { useAsync } from "@/lib/useAsync";
import { curSymbol } from "@/lib/utils";

/**
 * Per-ticker research notes — persisted server-side per user, included in
 * the tear-sheet export.
 *
 * The screen used to have one Save button and nothing else, which meant typing
 * a thesis and then clicking to another function threw the text away without a
 * word. That is the worst class of bug in a research tool: it loses the one
 * thing on the page the user actually made. Now the draft is kept locally the
 * moment it changes, autosaved on a debounce, restorable if the tab died, and
 * ⌘S works because everyone tries it.
 */
export function Notes({ ticker, price, currency }: {
  ticker: string;
  /** The live price, for stamping a dated entry. Optional. */
  price?: number | null;
  currency?: string;
}) {
  // useAsync's stale guard is essential here: without it, fast ticker
  // switching could put ticker A's note text into ticker B's textarea and a
  // later Save would write it to the wrong ticker.
  const { data: note, error, busy, retry } = useAsync(() => api.note(ticker), [ticker]);

  const [text, setText] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState(false);
  const [recover, setRecover] = useState<Draft | null>(null);

  /** The last text known to be on the server — what "dirty" is measured against. */
  const serverText = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Sync editor state from the (stale-guarded) load result. While a new
  // ticker is loading, `note` is null, so the editor clears immediately.
  useEffect(() => {
    const loaded = note?.text ?? "";
    serverText.current = loaded;
    setText(loaded);
    setUpdatedAt(note?.updated_at ?? null);
    setSaved(false);
    setSaveErr(false);
    // A local draft newer than the server copy means the last session ended
    // without a save. Offer it; never apply it silently over good text.
    const draft = loadDraft(ticker);
    setRecover(shouldRecover(draft, loaded, note?.updated_at ?? null) ? draft : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  const save = useCallback(async (value: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setSaving(true); setSaved(false); setSaveErr(false);
    try {
      await api.saveNote(ticker, value);
      serverText.current = value;
      clearDraft(ticker);
      setUpdatedAt(new Date().toISOString());
      setSaved(true);
    } catch {
      // Keep the text AND the local draft: the server copy is now the stale
      // one, and losing the draft here would lose the work outright.
      setSaveErr(true);
    } finally {
      setSaving(false);
    }
  }, [ticker]);

  /** Every edit: persist locally at once, schedule a server save. */
  function edit(value: string) {
    setText(value);
    setSaved(false);
    setSaveErr(false);
    setRecover(null);
    saveDraft(ticker, value, serverText.current, Date.now());
    if (timer.current) clearTimeout(timer.current);
    if (value !== serverText.current) {
      timer.current = setTimeout(() => { void save(value); }, AUTOSAVE_MS);
    }
  }

  // Drop a pending autosave when the ticker changes or the screen unmounts:
  // it would fire with the previous ticker's text against the new ticker.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, [ticker]);

  const dirty = text !== serverText.current;

  // ⌘S / Ctrl-S, because everyone tries it and the browser's own Save dialog
  // is never what they wanted.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save(text);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, text, save]);

  // Closing the tab mid-edit gets the browser's own confirmation. The draft is
  // already stored, so this is a courtesy rather than the safety net.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function addStamp() {
    const date = new Date().toISOString().slice(0, 10);
    const next = stamp(text, {
      date, price: price ?? null, currency: curSymbol(currency || "USD"),
    });
    edit(next);
    // Put the cursor under the new heading rather than at the end of a year of
    // notes, which is where a plain focus() would leave it.
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      const at = next.indexOf("\n\n") + 2;
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  if (busy) return <PanelLoading label="Loading notes…" />;
  if (error) return <PanelError error={error} retry={retry} label="Failed to load notes" />;

  const c = counts(text);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <div className="heading flex-1 min-w-0">Research notes — {ticker}</div>
        {updatedAt && <DataAge at={updatedAt} prefix="Saved" />}
        {/* One status slot, so the states can't stack up and shift the row. */}
        <span className="text-[11px] whitespace-nowrap">
          {saving ? <span className="text-mut">Saving…</span>
            : saveErr ? (
              <button onClick={() => void save(text)} className="text-red underline">
                Save failed — retry
              </button>
            )
            : dirty ? <span className="text-amber">Unsaved — autosaves shortly</span>
            : saved ? <span className="text-green">Saved ✓</span>
            : <span className="text-mut">Up to date</span>}
        </span>
        <button onClick={addStamp} className="btn btn-ghost"
                title="Insert a dated heading at today's price">
          Stamp entry
        </button>
        <button onClick={() => void save(text)} disabled={saving || !dirty}
                className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {recover && (
        <div className="panel-2 p-3 mb-2 flex flex-wrap items-center gap-3">
          <div className="text-[11px] text-amber flex-1 min-w-[240px] leading-relaxed">
            An unsaved draft from{" "}
            {new Date(recover.at).toLocaleString()} is newer than the saved note
            ({counts(recover.text).words} words). It was kept locally when the
            last session ended without saving.
          </div>
          <button onClick={() => { edit(recover.text); setRecover(null); }}
                  className="btn-primary">Restore draft</button>
          <button onClick={() => { clearDraft(ticker); setRecover(null); }}
                  className="btn btn-ghost">Discard it</button>
        </div>
      )}

      <textarea
        ref={areaRef}
        value={text}
        onChange={(e) => edit(e.target.value)}
        rows={18}
        placeholder={`Your thesis, risks, catalysts, levels for ${ticker}… (included in the tear-sheet export)`}
        className="w-full input-bare font-mono text-sm leading-relaxed resize-y"
      />
      <div className="flex flex-wrap items-center gap-3 mt-1">
        <span className="text-[10.5px] text-mut num">
          {c.words} words · {c.lines} lines
        </span>
        <span className="text-[10.5px] text-mut">⌘S saves</span>
      </div>
      <div className="mt-2">
        <Note>
          Notes are private to your account and stored on the backend&apos;s data
          volume. Edits are also kept in this browser as you type and autosave
          after a pause, so a closed tab doesn&apos;t lose them — but a draft
          held only in the browser is not backed up, and clearing site data
          clears it.
        </Note>
      </div>
    </div>
  );
}
