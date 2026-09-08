import proj4 from 'proj4';
import type { LngLat } from './types';

/**
 * All geometry is computed in UTM zone 10N, never in lon/lat.
 *
 * This matters more than it looks. A perpendicular bisector computed on raw
 * lon/lat is not perpendicular on the ground: at SF's latitude a degree of
 * longitude is only ~0.79 of a degree of latitude, so a bisector drawn in
 * degree space is off by roughly 14 degrees. Over the width of the city that
 * puts the thermometer line hundreds of metres away from the truth — enough to
 * eliminate the correct hiding zone.
 *
 * UTM 10N covers San Francisco with sub-metre distortion.
 */
const UTM10N = '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs';
const WGS84 = 'EPSG:4326';

/** lon/lat degrees -> UTM 10N metres */
export function toUTM(ll: LngLat): [number, number] {
  return proj4(WGS84, UTM10N, ll) as [number, number];
}

/** UTM 10N metres -> lon/lat degrees */
export function toLngLat(xy: [number, number]): LngLat {
  return proj4(UTM10N, WGS84, xy) as LngLat;
}

export function toUTMRing(ring: LngLat[]): [number, number][] {
  return ring.map(toUTM);
}

export function toLngLatRing(ring: [number, number][]): LngLat[] {
  return ring.map(toLngLat);
}

/** Planar distance in metres. Accurate to well under a metre across SF. */
export function metres(a: LngLat, b: LngLat): number {
  const [ax, ay] = toUTM(a);
  const [bx, by] = toUTM(b);
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Memoized projection.
 *
 * proj4 is not cheap, and the question-quality indicator projects every station
 * against every POI in a layer — 276 x 278 for parks. Coordinates never change
 * once loaded, so cache them by identity.
 */
const utmCache = new Map<string, [number, number]>();
export function toUTMCached(ll: LngLat): [number, number] {
  const key = `${ll[0]},${ll[1]}`;
  let v = utmCache.get(key);
  if (!v) {
    v = toUTM(ll);
    if (utmCache.size > 20_000) utmCache.clear();
    utmCache.set(key, v);
  }
  return v;
}

export function metresCached(a: LngLat, b: LngLat): number {
  const [ax, ay] = toUTMCached(a);
  const [bx, by] = toUTMCached(b);
  return Math.hypot(ax - bx, ay - by);
}
