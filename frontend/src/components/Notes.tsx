"use client";

import { useEffect, useState } from "react";

import { DataAge } from "@/components/DataAge";
import { api } from "@/lib/api";

/** Per-ticker research notes — persisted server-side per user, included in
 *  the tear-sheet export. */
export function Notes({ ticker }: { ticker: string }) {
  const [text, setText] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBusy(true); setText(""); setUpdatedAt(null); setSaved(false);
    api.note(ticker)
      .then((n) => { setText(n.text); setUpdatedAt(n.updated_at); })
      .catch(() => { /* empty note */ })
      .finally(() => setBusy(false));
  }, [ticker]);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await api.saveNote(ticker, text);
      setUpdatedAt(new Date().toISOString());
      setSaved(true);
    } catch { /* keep text; user can retry */ } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div className="heading flex-1">Research notes — {ticker}</div>
        {updatedAt && <DataAge at={updatedAt} prefix="Saved" />}
        {saved && <span className="text-green text-[11px]">Saved ✓</span>}
        <button onClick={save} disabled={saving || busy} className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
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
