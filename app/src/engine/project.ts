import proj4 from 'proj4';
import type { LngLat } from './types';

/**
 * All geometry is computed in the board's UTM zone, never in lon/lat.
 *
 * This matters more than it looks. A perpendicular bisector computed on raw
 * lon/lat is not perpendicular on the ground: at SF's latitude a degree of
 * longitude is only ~0.79 of a degree of latitude, so a bisector drawn in
 * degree space is off by roughly 14 degrees. Over the width of the city that
 * puts the thermometer line hundreds of metres away from the truth — enough to
 * eliminate the correct hiding zone.
 *
 * The zone used to be a constant, 10N, because there was one board. A
 * community city pack can be anywhere, and UTM is only accurate near its own
 * central meridian — San Francisco's zone applied to New York is off by tens
 * of percent. So the zone follows the board: `setProjectionCenter` is called
 * with the board's centre whenever a board is loaded (engine/reset.ts). San
 * Francisco's centre gives zone 10N, so the shipped board is unchanged.
 */
const WGS84 = 'EPSG:4326';

/** The proj4 definition of the UTM zone containing a point. */
export function utmDefinition(lon: number, lat: number): string {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return `+proj=utm +zone=${zone}${lat < 0 ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
}

export type Projection = {
  definition: string;
  toUTM: (ll: LngLat) => [number, number];
  toLngLat: (xy: [number, number]) => LngLat;
};

/** A projection for a place, independent of whichever board is loaded. */
export function projectionAt(lon: number, lat: number): Projection {
  const definition = utmDefinition(lon, lat);
  const converter = proj4(WGS84, definition);
  return {
    definition,
    toUTM: (ll) => converter.forward(ll) as [number, number],
    toLngLat: (xy) => converter.inverse(xy) as LngLat,
  };
}

// The shipped board, until a board says otherwise.
let current = projectionAt(-122.44, 37.76);

/**
 * Point the engine at a board. Returns whether the zone changed — every
 * cached projected coordinate is then stale, and is dropped here.
 */
export function setProjectionCenter(lon: number, lat: number): boolean {
  const next = utmDefinition(lon, lat);
  if (next === current.definition) return false;
  current = projectionAt(lon, lat);
  utmCache.clear();
  return true;
}

export const currentProjection = (): Projection => current;

/** lon/lat degrees -> the board's UTM metres */
export function toUTM(ll: LngLat): [number, number] {
  return current.toUTM(ll);
}

/** the board's UTM metres -> lon/lat degrees */
export function toLngLat(xy: [number, number]): LngLat {
  return current.toLngLat(xy);
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
