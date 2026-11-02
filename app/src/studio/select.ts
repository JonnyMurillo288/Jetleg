import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import pointToLineDistance from '@turf/point-to-line-distance';
import type { LngLat } from '../engine/types';

/**
 * Which of `points` a drawn shape selects — a rectangle, a lasso or a
 * polygon, all of them a ring of corners on the map.
 *
 * With `zoneM`, a station is selected when its *hiding zone* reaches into the
 * shape, not only when its point is inside: a station just outside a lasso
 * whose circle covers half of it is part of what was drawn around. A lasso
 * that crosses itself selects by the even-odd rule, which is what a hand
 * drawing a loop expects.
 */
export function idsInShape(points: { id: string; at: LngLat }[], ring: LngLat[], zoneM?: number): string[] {
  if (ring.length < 3) return [];
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
  const polygon = { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [closed] } };
  const edge = { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: closed } };
  // Cheap rejection first: nothing further than the zone from the shape's box can touch it.
  const pad = zoneM ? zoneM / 111_000 : 0;
  const lons = closed.map((c) => c[0]);
  const lats = closed.map((c) => c[1]);
  const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const lonPad = pad / Math.max(0.2, Math.cos(((s + n) / 2) * (Math.PI / 180)));
  return points
    .filter(({ at: [lon, lat] }) => lon >= w - lonPad && lon <= e + lonPad && lat >= s - pad && lat <= n + pad)
    .filter(({ at }) =>
      booleanPointInPolygon(at, polygon) ||
      (!!zoneM && pointToLineDistance(at, edge, { units: 'meters' }) <= zoneM))
    .map((p) => p.id);
}

/** A drawn shape applied to a selection: added to it, or taken out of it. */
export function combine(current: string[], hit: string[], mode: 'add' | 'remove'): string[] {
  if (mode === 'remove') {
    const gone = new Set(hit);
    return current.filter((id) => !gone.has(id));
  }
  const have = new Set(current);
  return [...current, ...hit.filter((id) => !have.has(id))];
}
