import { toUTM, toLngLat } from './project';
import type { LngLat } from './types';

/**
 * The seeker's exact dividing line, as two numbers portable over voice or
 * text: a midpoint the line passes through, and the bearing of the line
 * itself.
 *
 * The angle is the *full* 0-359.9° bearing of the perpendicular-to-travel
 * vector `thermometerRegion` itself computes (`px = -uy, py = ux`) — not
 * folded to a 0-179.9° "line orientation". Folding it loses which of the two
 * perpendicular directions is real, and that bit is exactly what lets the
 * hider's reconstruction land on the correct half when they answer hotter or
 * colder — losing it would silently invert the region on roughly half of all
 * runs.
 */
export function thermometerMidAngle(start: LngLat, end: LngLat): { midpoint: LngLat; angleDeg: number } | null {
  const [sx, sy] = toUTM(start);
  const [ex, ey] = toUTM(end);
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null; // no meaningful travel — same guard as thermometerRegion

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const midpoint = toLngLat([(sx + ex) / 2, (sy + ey) / 2]);
  const angleDeg = (Math.atan2(px, py) * 180 / Math.PI + 360) % 360;
  return { midpoint, angleDeg };
}

/**
 * The inverse: a start/end pair that reproduces the *exact* same region as
 * the original travel, built from only a midpoint and angle.
 *
 * The two synthetic points are placed an arbitrary distance apart —
 * `thermometerRegion` only ever uses their direction and midpoint, never how
 * far apart they are, so any separation reproduces identical geometry. This
 * is deliberately not a new region function: reusing `thermometerRegion`
 * unchanged is what guarantees the hider's reconstruction can't drift from
 * what the seeker's app actually computed.
 */
export function pointsFromMidAngle(midpoint: LngLat, angleDeg: number): { start: LngLat; end: LngLat } {
  const [mx, my] = toUTM(midpoint);
  const rad = (angleDeg * Math.PI) / 180;
  const px = Math.sin(rad);
  const py = Math.cos(rad);
  // Exact inverse of px = -uy, py = ux.
  const ux = py;
  const uy = -px;

  const EPS = 100; // metres; magnitude is irrelevant, only direction and midpoint matter
  return {
    start: toLngLat([mx - ux * EPS, my - uy * EPS]),
    end: toLngLat([mx + ux * EPS, my + uy * EPS]),
  };
}
