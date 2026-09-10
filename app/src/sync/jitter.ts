import { toUTM, toLngLat } from '../engine/project';
import type { LngLat } from '../engine/types';

/**
 * Offsets a point by a random distance up to `maxMeters` in a random
 * direction, for coordinates that leave the phone. Done in UTM, not degree
 * space, for the same reason every other distance in this app is: a metre
 * offset in lon/lat is not the same size east-west as north-south at this
 * latitude.
 *
 * The true point is only ever used locally, to answer the question — this
 * exists to produce the one that gets synced, never the other way round.
 */
export function jitterPoint(point: LngLat, maxMeters: number): LngLat {
  const [x, y] = toUTM(point);
  const angle = Math.random() * 2 * Math.PI;
  const radius = Math.random() * maxMeters;
  return toLngLat([x + radius * Math.cos(angle), y + radius * Math.sin(angle)]);
}
