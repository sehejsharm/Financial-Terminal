/** Which rows of the debt-history table have anything in them, and why the
 *  rest do not.
 *
 *  DDIS showed populated summary cards — Total debt, Cash, Net debt — above a
 *  "How it has moved" table where those same three series were "—" in every
 *  column. Both were correct and they came from different places: the cards
 *  read the capital-structure endpoint, which is a point-in-time snapshot, and
 *  the table reads the BALANCE SHEET, which for an Indian listing does not
 *  exist. The only free source of statements there is the XBRL a company files
 *  with its quarterly results, and that filing carries an income statement and
 *  nothing else.
 *
 *  A row of dashes reads as a bug in the app. The same absence, named, reads
 *  as a limit of the data — so rows with nothing in them are dropped and
 *  accounted for instead of rendered empty.
 */

export type TrendRow = {
  label: string;
  values: (number | null)[];
  kind: "money" | "x";
};

export type TrendSplit = {
  /** Rows with at least one real value — the only ones worth rendering. */
  shown: TrendRow[];
  /** Labels of rows that had nothing, in their original order. */
  missing: string[];
  /** True when nothing survived, so the table itself should not appear. */
  empty: boolean;
};

export function splitPopulated(rows: TrendRow[]): TrendSplit {
  const shown: TrendRow[] = [];
  const missing: string[] = [];
  for (const r of rows) {
    if (r.values.some((v) => v != null)) shown.push(r);
    else missing.push(r.label);
  }
  return { shown, missing, empty: shown.length === 0 };
}

/** Rows sourced from the balance sheet. Named because they go missing
 *  together — when the balance sheet is absent, it is exactly these. */
const BALANCE_ROWS = new Set(["Total debt", "Cash", "Net debt"]);

/**
 * Why the missing rows are missing, in the app's own voice.
 *
 * Prefers the server's explanation when it gave one — it knows which provider
 * it tried and why it came back empty — and falls back to naming the rows so
 * the gap is at least attributed rather than silent.
 */
export function missingTrendNote(missing: string[],
                                 balanceNote?: string | null): string | null {
  if (!missing.length) return null;

  const allFromBalance = missing.every((m) => BALANCE_ROWS.has(m));
  const list = missing.join(", ");

  if (allFromBalance) {
    return `${list} are not shown over time because no balance sheet is `
      + "available for this ticker. The cards above are still right — they "
      + `come from a point-in-time capital-structure lookup, not from a filed `
      + "balance sheet, which is why a current figure can exist while the "
      + `history cannot.${balanceNote ? ` ${balanceNote}` : ""}`;
  }
  return `Not shown over time: ${list}. The underlying statement lines were `
    + `absent for every period on file.${balanceNote ? ` ${balanceNote}` : ""}`;
}
