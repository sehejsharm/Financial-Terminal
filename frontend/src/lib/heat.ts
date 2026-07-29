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

/** Border tint to match, a touch stronger so the cell edge stays legible. */
export function heatBorder(cp: number | null | undefined): string {
  if (cp == null || !Number.isFinite(cp)) return "rgb(var(--c-line2))";
  const a = Math.min(1, Math.abs(cp) / HEAT_SATURATION_PCT);
  const alpha = (0.25 + a * 0.45).toFixed(3);
  return cp >= 0
    ? `rgb(var(--c-green) / ${alpha})`
    : `rgb(var(--c-red) / ${alpha})`;
}
