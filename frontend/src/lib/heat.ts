/** Shared "how big is this move" shading.
 *
 *  Used by the Global heatmap and the dashboard tiles so a 1.4% move looks
 *  identical wherever it appears — the whole value of a heat colour is that
 *  it means the same thing on every screen.
 */

/** Moves saturate at ±2%: past that the direction matters more than the
 *  exact figure, and a fully-toned cell reads faster than a slightly
 *  darker one. */
export const HEAT_SATURATION_PCT = 2;

/** Background tint for a percentage move. Transparent when unknown — an
 *  absent quote must not look like a flat one. */
export function heatBg(cp: number | null | undefined,
                       { min = 0.08, max = 0.5 } = {}): string {
  if (cp == null || !Number.isFinite(cp)) return "transparent";
  const a = Math.min(1, Math.abs(cp) / HEAT_SATURATION_PCT);
  const alpha = (min + a * (max - min)).toFixed(3);
  return cp >= 0
    ? `rgb(var(--c-green) / ${alpha})`
    : `rgb(var(--c-red) / ${alpha})`;
}

/** The same shading for a value on any scale.
 *
 *  Sector scores run −100…+100, not percent moves, so they need their own
 *  saturation point. Sharing the ramp keeps green meaning the same thing
 *  everywhere; passing the scale explicitly stops a −40 score from being
 *  painted as if it were a −40% day.
 */
export function tintBg(v: number | null | undefined, saturateAt: number,
                       { min = 0.08, max = 0.5 } = {}): string {
  if (v == null || !Number.isFinite(v) || saturateAt <= 0) return "transparent";
  const a = Math.min(1, Math.abs(v) / saturateAt);
  const alpha = (min + a * (max - min)).toFixed(3);
  return v >= 0 ? `rgb(var(--c-green) / ${alpha})` : `rgb(var(--c-red) / ${alpha})`;
}

export function tintBorder(v: number | null | undefined, saturateAt: number): string {
  if (v == null || !Number.isFinite(v) || saturateAt <= 0) return "rgb(var(--c-line2))";
  const a = Math.min(1, Math.abs(v) / saturateAt);
  const alpha = (0.25 + a * 0.45).toFixed(3);
  return v >= 0 ? `rgb(var(--c-green) / ${alpha})` : `rgb(var(--c-red) / ${alpha})`;
}

/** Border tint to match, a touch stronger so the cell edge stays legible. */
export function heatBorder(cp: number | null | undefined): string {
  if (cp == null || !Number.isFinite(cp)) return "rgb(var(--c-line2))";
  const a = Math.min(1, Math.abs(cp) / HEAT_SATURATION_PCT);
  const alpha = (0.25 + a * 0.45).toFixed(3);
  return cp >= 0
    ? `rgb(var(--c-green) / ${alpha})`
    : `rgb(var(--c-red) / ${alpha})`;
}
