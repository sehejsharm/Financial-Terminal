"use client";

import { useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

/** Per-ticker research notes — persisted server-side per user, included in
 *  the tear-sheet export. */
export function Notes({ ticker }: { ticker: string }) {
  // useAsync's stale guard is essential here: without it, fast ticker
  // switching could put ticker A's note text into ticker B's textarea and a
  // later Save would write it to the wrong ticker.
  const { data: note, error, busy, retry } = useAsync(() => api.note(ticker), [ticker]);

  const [text, setText] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState(false);

  // Sync editor state from the (stale-guarded) load result. While a new
  // ticker is loading, `note` is null, so the editor clears immediately.
  useEffect(() => {
    setText(note?.text ?? "");
    setUpdatedAt(note?.updated_at ?? null);
    setSaved(false);
    setSaveErr(false);
  }, [note]);

  async function save() {
    setSaving(true); setSaved(false); setSaveErr(false);
    try {
      await api.saveNote(ticker, text);
      setUpdatedAt(new Date().toISOString());
      setSaved(true);
    } catch {
      setSaveErr(true); // keep text; user can retry
    } finally {
      setSaving(false);
    }
  }

  if (busy) return <PanelLoading label="Loading notes…" />;
  if (error) return <PanelError error={error} retry={retry} label="Failed to load notes" />;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div className="heading flex-1">Research notes — {ticker}</div>
        {updatedAt && <DataAge at={updatedAt} prefix="Saved" />}
        {saved && <span className="text-green text-[11px]">Saved ✓</span>}
        {saveErr && (
          <button onClick={save} className="text-red text-[11px] underline">
            Save failed — retry
          </button>
        )}
        <button onClick={save} disabled={saving || busy} className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); setSaveErr(false); }}
        disabled={busy}
        rows={16}
        placeholder={`Your thesis, risks, catalysts, levels for ${ticker}… (included in the tear-sheet export)`}
        className="w-full input-bare font-mono text-sm leading-relaxed resize-y"
      />
      <div className="text-[10.5px] text-mut mt-1">
        Notes are private to your account and stored on the backend&apos;s data volume.
      </div>
    </div>
  );
}
