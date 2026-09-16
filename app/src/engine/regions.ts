import intersect from '@turf/intersect';
import difference from '@turf/difference';
import union from '@turf/union';
import circleOf from '@turf/circle';
import buffer from '@turf/buffer';
import bboxOf from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { featureCollection, polygon, feature, point as pointOf } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { toUTM, toLngLat, metres } from './project';
import type { Boundary, LngLat, PoiLayer } from './types';

export type Region = Feature<Polygon | MultiPolygon>;

/**
 * The single "still in play" area, and its complement.
 *
 * Each answer contributes a yes-region; the hider is inside it, or outside it
 * when the answer was no/further/colder. Intersecting and subtracting them in
 * turn collapses the whole ask log into one polygon, so the map can shade
 * everywhere the hider provably is not — rather than stacking one translucent
 * overlay per question and leaving the reader to work out the intersection.
 *
 * This is presentation only. The authoritative answer is still the discrete set
 * of surviving hiding zones, which is computed independently.
 */
export function playArea(
  boundary: Boundary,
  regions: { region: Region | null; inverted: boolean }[],
): { inPlay: Region | null; outOfPlay: Region | null } {
  let inPlay: Region | null = boundary as Region;

  for (const r of regions) {
    if (!r.region || !inPlay) continue;
    try {
      inPlay = r.inverted
        ? (difference(featureCollection([inPlay, r.region]) as any) as Region | null)
        : (intersect(featureCollection([inPlay, r.region]) as any) as Region | null);
    } catch {
      // A degenerate polygon should not blank the map; skip that constraint.
    }
  }

  if (!inPlay) return { inPlay: null, outOfPlay: boundary as Region };

  let outOfPlay: Region | null = null;
  try {
    outOfPlay = difference(featureCollection([boundary as Region, inPlay]) as any) as Region | null;
  } catch {
    outOfPlay = null;
  }
  return { inPlay, outOfPlay };
}

/**
 * Build a lon/lat polygon from UTM corners, interpolating along every edge.
 *
 * This is load-bearing, and its absence was a real elimination bug. A straight
 * line in UTM is a *curve* in lon/lat, but turf treats a polygon edge as
 * straight in degree space. These half-planes are 120 km across, so a
 * four-corner rectangle's bisector edge bowed hundreds of metres away from the
 * line it was supposed to be — enough to put whole Voronoi cells on the wrong
 * side of a matching answer. Measured against nearest-POI truth over 1,665
 * sample points, the four-corner version misclassified 9.2% of them; four
 * points per edge misclassified none.
 */
const EDGE_STEPS = 16;

function utmPolygon(corners: [number, number][]): Region {
  const ring: LngLat[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let s = 0; s < EDGE_STEPS; s++) {
      const t = s / EDGE_STEPS;
      ring.push(toLngLat([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
    }
  }
  ring.push(ring[0]);
  return polygon([ring]) as Region;
}

/** Clip anything to the game board. Out-of-bounds area is not in play. */
export function clip(region: Region | null, boundary: Boundary): Region | null {
  if (!region) return null;
  try {
    return intersect(featureCollection([region, boundary]) as any) as Region | null;
  } catch {
    return null;
  }
}

/** A radar disk: everywhere within `radiusM` of the seeker. */
export function radarRegion(origin: LngLat, radiusM: number, boundary: Boundary): Region | null {
  return clip(circleOf(origin, radiusM, { steps: 128, units: 'meters' }) as Region, boundary);
}

/**
 * Thermometer: the half of the board on the far side of the perpendicular
 * bisector of the seeker's travel.
 *
 * Built in UTM as a rectangle wide enough to cover the whole city, anchored at
 * the midpoint and oriented perpendicular to the direction of travel, then
 * clipped to the boundary. "Hotter" keeps the half containing the destination.
 */
export function thermometerRegion(
  start: LngLat,
  end: LngLat,
  warmer: boolean,
  boundary: Boundary,
): Region | null {
  const [sx, sy] = toUTM(start);
  const [ex, ey] = toUTM(end);
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null; // no meaningful travel

  // Unit vector along travel, and its perpendicular.
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  // Midpoint of the segment — the bisector passes through here.
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;

  // Far larger than SF, so the half-plane fully covers the board either way.
  const R = 60_000;
  const sign = warmer ? 1 : -1;

  const corners: [number, number][] = [
    [mx + px * R, my + py * R],
    [mx - px * R, my - py * R],
    [mx - px * R + ux * R * sign, my - py * R + uy * R * sign],
    [mx + px * R + ux * R * sign, my + py * R + uy * R * sign],
  ];
  return clip(utmPolygon(corners), boundary);
}

/**
 * Measuring: "compared to me, are you closer to or further from an X?"
 *
 * The seeker's own distance to their nearest X sets a radius r. Anywhere within
 * r of *any* X is closer than the seeker; everywhere else is further. That is
 * exactly the rulebook's airport diagram — a union of disks, not a bisector.
 *
 * For a line layer (coastline), the same idea is a buffer of the line by r.
 */
export function measuringRegion(
  origin: LngLat,
  layer: PoiLayer,
  boundary: Boundary,
): { region: Region | null; radiusM: number } | null {
  const r = nearestDistanceM(origin, layer);
  if (r === null) return null; // no such feature in bounds -> null answer

  const disks: Region[] = [];
  for (const f of layer.features) {
    const g = f.geometry;
    if (g.type === 'Point') {
      disks.push(circleOf(g.coordinates as LngLat, r, { steps: 64, units: 'meters' }) as Region);
    } else {
      const b = buffer(f as any, r, { units: 'meters' });
      if (b) disks.push(b as Region);
    }
  }
  if (!disks.length) return null;

  const merged = disks.length === 1 ? disks[0] : (union(featureCollection(disks) as any) as Region | null);
  return { region: clip(merged, boundary), radiusM: r };
}

/**
 * Matching: "is your nearest X the same as mine?"
 *
 * The yes-region is the Voronoi cell of the seeker's nearest X. Rather than
 * building a full Voronoi diagram, the cell is carved directly as the
 * intersection of half-planes against every other X — which is both simpler and
 * exact, and avoids turf's bbox-clipped voronoi entirely.
 */
export function matchingRegion(
  origin: LngLat,
  layer: PoiLayer,
  boundary: Boundary,
): { region: Region | null; nearestId: string | null } | null {
  const nearest = nearestFeature(origin, layer);
  if (!nearest) return null;

  const focus = featurePoint(nearest.feature);
  if (!focus) return null;

  // The shipped cell when there is one — already exact, already clipped to the
  // board, and the very polygon the map draws. Carving is the fallback for
  // layers the pipeline has no diagram for.
  const pre = precomputedCell(layer, nearest.feature);
  const cell = pre ?? voronoiCell(focus, nearest.feature, layer, boundary);
  return {
    region: cell,
    // The human-readable name, not the OSM-derived id: this string is shown in
    // the seeker's ask log, where "parks-941913562" tells them nothing.
    nearestId: (nearest.feature.properties?.name as string) ?? (nearest.feature.properties?.id as string) ?? null,
  };
}

/**
 * The district (or other polygon-partition feature) containing a point, by
 * point-in-polygon rather than nearest-feature — the layer already partitions
 * the whole board, so there is no Voronoi carving to do.
 */
export function districtFeatureAt(
  pt: LngLat,
  layer: PoiLayer,
): Feature<Polygon | MultiPolygon> | null {
  const p = pointOf(pt);
  for (const f of layer.features) {
    const g = f.geometry;
    if (g?.type !== 'Polygon' && g?.type !== 'MultiPolygon') continue;
    if (booleanPointInPolygon(p, f as Feature<Polygon | MultiPolygon>)) {
      return f as Feature<Polygon | MultiPolygon>;
    }
  }
  return null;
}

/**
 * Matching against a polygon-partition layer (districts): "is your district
 * the same as mine?" The yes-region is simply the seeker's own district,
 * already clipped to the board.
 */
export function districtRegion(
  origin: LngLat,
  layer: PoiLayer,
  boundary: Boundary,
): { region: Region | null; nearestId: string | null } | null {
  const f = districtFeatureAt(origin, layer);
  if (!f) return null;
  return {
    region: clip(f as Region, boundary),
    nearestId: (f.properties?.name as string) ?? (f.properties?.id as string) ?? null,
  };
}

/**
 * Matching by a derived property rather than feature identity: "is your
 * station's [property] the same as mine?" The yes-region is the union of
 * every matching feature's own Voronoi cell (precomputed when the layer has
 * one, carved otherwise) — a many-to-one grouping, unlike `matchingRegion`'s
 * single nearest cell.
 */
export function groupedMatchingRegion(
  origin: LngLat,
  layer: PoiLayer,
  groupKeyOf: (f: Feature<any>) => string | number | null,
  boundary: Boundary,
): { region: Region | null; groupKey: string | number | null } | null {
  const nearest = nearestFeature(origin, layer);
  if (!nearest) return null;

  const key = groupKeyOf(nearest.feature);
  if (key === null) return null;

  const cells: Region[] = [];
  for (const f of layer.features) {
    if (groupKeyOf(f) !== key) continue;
    const focus = featurePoint(f);
    if (!focus) continue;
    const pre = precomputedCell(layer, f);
    const cell = pre ?? voronoiCell(focus, f, layer, boundary);
    if (cell) cells.push(cell);
  }
  if (!cells.length) return null;

  const merged = cells.length === 1 ? cells[0] : (union(featureCollection(cells) as any) as Region | null);
  return { region: clip(merged, boundary), groupKey: key };
}

/**
 * Carve one Voronoi cell as an intersection of half-planes.
 *
 * Naively this is one polygon clip per other POI — 278 of them for parks, which
 * made a single question take hundreds of milliseconds. The pruning below makes
 * it exact but cheap: work outwards from the focus, and stop as soon as the
 * cell is entirely closer to the focus than half the distance to the next POI.
 * No POI beyond that point can cut the cell, because its bisector with the
 * focus lies at half that distance. For a dense layer this converges after a
 * handful of neighbours.
 */
function voronoiCell(
  focus: LngLat,
  focusFeature: Feature<any>,
  layer: PoiLayer,
  start: Region,
): Region | null {
  const [fx, fy] = toUTM(focus);

  const others = layer.features
    .filter((f) => f !== focusFeature && f.geometry?.type === 'Point')
    .map((f) => {
      const p = f.geometry.coordinates as LngLat;
      const [x, y] = toUTM(p);
      return { p, d: Math.hypot(x - fx, y - fy) };
    })
    .sort((a, b) => a.d - b.d);

  let cell: Region | null = start;
  for (const other of others) {
    if (!cell) break;
    // Furthest the current cell reaches from the focus.
    const reach = maxReachFromM(cell, fx, fy);
    // Bisector with `other` sits at other.d / 2. Anything beyond cannot cut.
    if (other.d / 2 >= reach) break;
    cell = clip(cell, halfPlaneCloserTo(focus, other.p) as Boundary);
  }
  return cell;
}

/** Distance in metres from (fx,fy) to the furthest corner of a region's bbox. */
function maxReachFromM(region: Region, fx: number, fy: number): number {
  const [w, s, e, n] = bboxOf(region);
  let max = 0;
  for (const ll of [[w, s], [w, n], [e, s], [e, n]] as LngLat[]) {
    const [x, y] = toUTM(ll);
    max = Math.max(max, Math.hypot(x - fx, y - fy));
  }
  return max;
}

/**
 * Tentacle: "within D of me, which X are you nearest to?"
 * The named POI's Voronoi cell, intersected with the reach disk.
 */
export function tentacleRegion(
  origin: LngLat,
  layer: PoiLayer,
  radiusM: number,
  poiId: string | null,
  boundary: Boundary,
): Region | null {
  const disk = radarRegion(origin, radiusM, boundary);
  if (!disk) return null;

  // "Not within reach" eliminates the whole disk, so the yes-region is its
  // complement — represented here by returning the disk and inverting at the
  // call site via the answer polarity.
  if (!poiId) return disk;

  const target = layer.features.find(
    (f) => (f.properties?.id ?? f.properties?.name) === poiId,
  );
  if (!target) return null;
  const focus = featurePoint(target);
  if (!focus) return null;

  const pre = precomputedCell(layer, target);
  return pre ? clip(pre, disk as Boundary) : voronoiCell(focus, target, layer, disk);
}

/**
 * The precomputed Voronoi cell for one feature, by id.
 *
 * Indexed once per layer; the cells never change after load.
 */
const cellIndexCache = new WeakMap<object, Map<string, Region>>();

function precomputedCell(layer: PoiLayer, feature: Feature<any>): Region | null {
  const cells = layer.cells;
  if (!cells?.features.length) return null;

  let index = cellIndexCache.get(cells);
  if (!index) {
    index = new Map();
    for (const f of cells.features) {
      const id = (f.properties?.id ?? f.properties?.name) as string | undefined;
      if (id) index.set(id, f as Region);
    }
    cellIndexCache.set(cells, index);
  }

  const id = (feature.properties?.id ?? feature.properties?.name) as string | undefined;
  return (id && index.get(id)) || null;
}

// ------------------------------------------------------------------ helpers

/** The half-plane of points strictly closer to `a` than to `b`. */
function halfPlaneCloserTo(a: LngLat, b: LngLat): Region {
  const [ax, ay] = toUTM(a);
  const [bx, by] = toUTM(b);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const R = 60_000;

  const corners: [number, number][] = [
    [mx + px * R, my + py * R],
    [mx - px * R, my - py * R],
    [mx - px * R - ux * R, my - py * R - uy * R],
    [mx + px * R - ux * R, my + py * R - uy * R],
  ];
  return utmPolygon(corners);
}

export function featurePoint(f: Feature<any>): LngLat | null {
  if (f.geometry?.type === 'Point') return f.geometry.coordinates as LngLat;
  return null;
}

/** Distance to the nearest feature in a layer, or null if the layer is empty. */
export function nearestDistanceM(from: LngLat, layer: PoiLayer): number | null {
  const n = nearestFeature(from, layer);
  return n ? n.distanceM : null;
}

export function nearestFeature(
  from: LngLat,
  layer: PoiLayer,
): { feature: Feature<any>; distanceM: number } | null {
  let best: { feature: Feature<any>; distanceM: number } | null = null;
  for (const f of layer.features) {
    const d = distanceToFeatureM(from, f);
    if (d === null) continue;
    if (!best || d < best.distanceM) best = { feature: f, distanceM: d };
  }
  return best;
}

/**
 * Distance to a feature. Points measure to the map icon, per the rulebook —
 * deliberately, even though it means you can stand inside Golden Gate Park and
 * be nearer to a smaller park's icon.
 */
export function distanceToFeatureM(from: LngLat, f: Feature<any>): number | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return metres(from, g.coordinates as LngLat);
  if (g.type === 'LineString') return lineDistanceM(from, g.coordinates as LngLat[]);
  if (g.type === 'MultiLineString') {
    let best: number | null = null;
    for (const part of g.coordinates as LngLat[][]) {
      const d = lineDistanceM(from, part);
      if (d !== null && (best === null || d < best)) best = d;
    }
    return best;
  }
  return null;
}

function lineDistanceM(from: LngLat, coords: LngLat[]): number | null {
  if (coords.length < 2) return null;
  const [px, py] = toUTM(from);
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = toUTM(coords[i]);
    const [bx, by] = toUTM(coords[i + 1]);
    best = Math.min(best, pointSegmentDistance(px, py, ax, ay, bx, by));
  }
  return Number.isFinite(best) ? best : null;
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export const regionBbox = (r: Region) => bboxOf(r);
export const asFeature = feature;
