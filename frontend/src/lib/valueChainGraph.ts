/** Pure geometry/graph helpers for the value-chain map.
 *
 *  Kept out of the component so the maths is unit-testable without a DOM:
 *  viewport fitting today, entity de-duplication / edge-metric selection /
 *  snapshot diffing as those land.
 */

/** Canvas coordinate space the SVG viewBox is expressed in. */
export const W = 1200;
export const H = 780;
export const CX = W / 2;
export const CY = 340;

/** Zoom limits, expressed on the viewBox WIDTH (smaller = more zoomed in). */
export const MIN_W = W / 8;
export const MAX_W = W * 3;

export type View = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const DEFAULT_VIEW: View = { x: 0, y: 0, w: W, h: H };

/** Node box half-extents used by the renderer (rect is 156×32 centred on x,y). */
export const NODE_HALF_W = 78;
export const NODE_HALF_H = 16;

/**
 * Smallest view that frames every point, padded, widened to the canvas aspect
 * ratio and clamped to the zoom limits. Returns DEFAULT_VIEW for an empty
 * graph so "Fit" always does something sane.
 */
export function fitView(
  points: { x: number; y: number }[],
  opts: { pad?: number; halfW?: number; halfH?: number } = {},
): View {
  const { pad = 24, halfW = NODE_HALF_W, halfH = NODE_HALF_H } = opts;
  if (!points.length) return { ...DEFAULT_VIEW };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    xs.push(p.x - halfW, p.x + halfW);
    ys.push(p.y - halfH, p.y + halfH);
  }
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  let w = maxX - minX;
  const h = maxY - minY;
  // Grow the tighter axis so the framed box keeps the canvas aspect ratio.
  if (w / h < W / H) w = h * (W / H);
  w = clamp(w, MIN_W, MAX_W);
  const fh = w * (H / W);
  return { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - fh / 2, w, h: fh };
}

/**
 * Zoom anchored on a point given in 0..1 fractions of the viewport, so the
 * graph coordinate under the cursor stays under the cursor.
 */
export function zoomAt(view: View, factor: number, fx: number, fy: number): View {
  const w = clamp(view.w * factor, MIN_W, MAX_W);
  const h = w * (H / W);
  return {
    x: view.x + (view.w - w) * clamp(fx, 0, 1),
    y: view.y + (view.h - h) * clamp(fy, 0, 1),
    w,
    h,
  };
}
