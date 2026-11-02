import booleanIntersects from '@turf/boolean-intersects';
import booleanContains from '@turf/boolean-contains';
import circleOf from '@turf/circle';
import turfBbox from '@turf/bbox';
import turfArea from '@turf/area';
import intersect from '@turf/intersect';
import difference from '@turf/difference';
import type { BBox, Feature, MultiPolygon, Polygon, Position } from 'geojson';
import type { AskEntry, Boundary, LngLat, PoiLayer, Question, Station } from './types';
import {
  matchingRegion, measuringRegion, radarRegion, tentacleRegion, thermometerRegion,
  type Region,
} from './regions';
import { metresCached, toUTMCached } from './project';
import { layerIndex, nearestProjected, nearestTo } from './spatial';

/** The hiding-zone radius when a map does not choose one: the built-in board's, and the rulebook's for small and medium games. */
export const ZONE_RADIUS_M = 500;

/**
 * The hiding-zone radius of the board in play. A map may choose its own
 * (`rules.zoneRadiusM`), so this belongs to the board, like the projection:
 * `enterBoard` sets it, and every zone circle is built from it.
 */
let boardZoneRadiusM = ZONE_RADIUS_M;
export const zoneRadius = (): number => boardZoneRadiusM;
export function setZoneRadius(m: number): void {
  boardZoneRadiusM = m > 0 ? m : ZONE_RADIUS_M;
}

/**
 * How zones are ruled out.
 *
 * The rulebook is explicit that every answer describes the hider's *current
 * location*, not their hiding zone — and the hider may roam anywhere inside
 * their circle.
 *
 * 'strict' tests the station centre alone: a zone is in or out whole. It
 *   narrows fastest, and is wrong whenever the hider is near the edge of
 *   their circle.
 * 'loose' works with portions of the zone. Each answer cuts away the part of
 *   every circle it rules out, the answers' cuts add up, and a zone is ruled
 *   out only when nothing of it is left. It can never eliminate the true
 *   zone, and the map draws each zone as what is left of it.
 *
 * ('loose' replaced 'conservative', which kept a zone if any part of it
 * survived each answer *separately* — two answers that each left a different
 * half could not rule it out between them.)
 */
export type Strictness = 'strict' | 'loose';

/** A stored setting or game file from before 'loose' existed. */
export function readStrictness(v: unknown): Strictness | undefined {
  return v === 'strict' ? 'strict' : v === 'loose' || v === 'conservative' ? 'loose' : undefined;
}

export type ZoneVerdict = {
  station: Station;
  alive: boolean;
  /** Ask-entry ids that ruled this zone out. */
  killedBy: string[];
};

/** Below this many square metres, what is left of a zone is rounding, not ground. */
const EMPTY_M2 = 1;

/**
 * A station's identity for caching: its id *and* where it is.
 *
 * The id alone was enough while there was one board. A community map
 * (src/community/) swaps the station set at runtime, and two maps are free to
 * reuse an id for a stop a few blocks apart — keyed by id, the second map
 * would be judged against the first map's circle.
 */
const stationKey = (s: Station) => `${s.id}@${s.lon},${s.lat}`;

const setKeys = new WeakMap<Station[], string>();
/** One short string per station *set*, for caches that hold a whole set's result. */
function stationSetKey(stations: Station[]): string {
  let k = setKeys.get(stations);
  if (k === undefined) {
    // FNV-1a over every station's key. A count is not a signature: two maps
    // with the same number of stations are the ordinary case, not a collision.
    let h = 0x811c9dc5;
    for (const s of stations) {
      const key = stationKey(s);
      for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0x7c, 0x01000193);
    }
    k = `${stations.length}:${(h >>> 0).toString(36)}`;
    setKeys.set(stations, k);
  }
  return k;
}

const zoneCache = new Map<string, Feature<Polygon>>();
/** A station's hiding zone: by default at the radius of the board in play. */
export function zoneOf(station: Station, radiusM: number = boardZoneRadiusM): Feature<Polygon> {
  const key = `${stationKey(station)}r${radiusM}`;
  let z = zoneCache.get(key);
  if (!z) {
    z = circleOf([station.lon, station.lat], radiusM, { steps: 64, units: 'meters' }) as Feature<Polygon>;
    if (zoneCache.size > 5_000) zoneCache.clear();
    zoneCache.set(key, z);
  }
  return z;
}

const bboxCache = new WeakMap<object, BBox>();
function bboxOf(o: any): BBox {
  let b = bboxCache.get(o);
  if (!b) bboxCache.set(o, (b = turfBbox(o) as BBox));
  return b;
}

const disjoint = (a: BBox, b: BBox) => a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
const contains = (outer: BBox, inner: BBox) =>
  outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

/**
 * Does a zone remain possible given that the truth lies inside `region`?
 *
 * Strict: only if the station centre is inside. Loose: if any part of the
 * zone is — the cut that follows in `cutZone` can only take more away.
 *
 * The strict path starts with a bounding-box test, which rejects most
 * stations outright and is exact when it fires.
 */
function possible(station: Station, region: Region, strictness: Strictness): boolean {
  if (strictness === 'loose') return zoneAgainst(station, region).touches;
  const p = pointFeature(station);
  if (disjoint(bboxOf(p), bboxOf(region))) return false;
  return booleanIntersects(p, region);
}

/** The inverse: the truth is *outside* `region`. */
function possibleOutside(station: Station, region: Region, strictness: Strictness): boolean {
  if (strictness === 'loose') return !zoneAgainst(station, region).swallowed;
  const p = pointFeature(station);
  if (disjoint(bboxOf(p), bboxOf(region))) return true;
  return !booleanIntersects(p, region);
}

/** The box a zone's tests and cuts work in: its own, padded so trimming slivers fall outside the circle. */
function workBox(geom: Feature<any>): BBox {
  const [x0, y0, x1, y1] = bboxOf(geom);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/**
 * Loose: does any of a zone lie in `region`, and does all of it?
 *
 * Tested against the region trimmed to the zone's box rather than the whole
 * region. A region clipped to the city boundary carries thousands of vertices,
 * and `booleanContains` against all of them for every station made a single
 * thermometer answer take 4.6 s on a laptop — a freeze of most of a minute on
 * a phone. Trimmed, the same test sees the few dozen vertices near the zone.
 * Exact, because nothing outside the box can touch a zone inside it.
 */
function zoneAgainst(station: Station, region: Region): { touches: boolean; swallowed: boolean } {
  const zone = zoneOf(station);
  if (disjoint(bboxOf(zone), bboxOf(region))) return { touches: false, swallowed: false };
  const near = clipToBox(region.geometry as Polygon | MultiPolygon, workBox(zone));
  if (!near) return { touches: false, swallowed: false };
  const touches = booleanIntersects(zone, near);
  let swallowed = false;
  if (touches && contains(bboxOf(region), bboxOf(zone))) {
    try { swallowed = booleanContains(near, zone); } catch { swallowed = false; }
  }
  return { touches, swallowed };
}

/**
 * A polygon cut down to a box, ring by ring (Sutherland–Hodgman).
 *
 * Regions are clipped to the city boundary and carry its thousands of
 * vertices. Cutting a 64-point zone circle out of all of that costs far more
 * than cutting it out of the few dozen vertices near the zone, so the region
 * is first trimmed to a box a little larger than the zone. The trim can leave
 * zero-width slivers along the box's edges; the box is padded so they all lie
 * outside the circle, where the intersection or difference that follows
 * drops them.
 */
function clipToBox(geom: Polygon | MultiPolygon, [x0, y0, x1, y1]: BBox): Feature<MultiPolygon> | null {
  const clipRing = (ring: Position[]): Position[] => {
    let out = ring;
    const edges: [(p: Position) => boolean, (a: Position, b: Position) => Position][] = [
      [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
      [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
      [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
      [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
    ];
    for (const [inside, cross] of edges) {
      const input = out;
      out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        const prev = input[(i + input.length - 1) % input.length];
        if (inside(cur)) {
          if (!inside(prev)) out.push(cross(prev, cur));
          out.push(cur);
        } else if (inside(prev)) out.push(cross(prev, cur));
      }
      if (!out.length) return out;
    }
    return out;
  };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const kept: Position[][][] = [];
  for (const poly of polys) {
    const rings: Position[][] = [];
    for (let r = 0; r < poly.length; r++) {
      // Rings come closed; clip the open ring and close the result again.
      const c = clipRing(poly[r].slice(0, -1));
      if (c.length < 3) { if (r === 0) break; continue; }
      rings.push([...c, c[0]]);
    }
    if (rings.length) kept.push(rings);
  }
  return kept.length ? { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: kept } } : null;
}

const cutCache = new Map<string, Feature<Polygon | MultiPolygon> | null>();

/**
 * Loose: what is left of a zone after the answers that only partly cover it.
 * Null when nothing is.
 *
 * `cuts` are the asks, in log order, whose region crosses this zone — the
 * others either leave it whole or were already enough to rule it out. Each
 * result is cached under the chain of asks that produced it, so adding an
 * answer to the log costs one more cut per zone it crosses, not a rebuild.
 */
function cutZone(station: Station, cuts: { sig: string; region: Region; inverted: boolean }[]): Feature<Polygon | MultiPolygon> | null {
  let left: Feature<Polygon | MultiPolygon> | null = zoneOf(station);
  let key = `${stationKey(station)}r${boardZoneRadiusM}`;
  for (const c of cuts) {
    key += `|${c.inverted ? '-' : '+'}${c.sig}`;
    const cached = cutCache.get(key);
    if (cached !== undefined) { left = cached; if (!left) return null; continue; }
    const near = clipToBox(c.region.geometry as Polygon | MultiPolygon, workBox(left));
    let next: Feature<Polygon | MultiPolygon> | null;
    try {
      next = c.inverted
        ? (near ? difference({ type: 'FeatureCollection', features: [left, near] }) : left)
        : (near ? intersect({ type: 'FeatureCollection', features: [left, near] }) : null);
    } catch {
      // A degenerate cut is not evidence: keep what was there.
      next = left;
    }
    if (next && turfArea(next) < EMPTY_M2) next = null;
    if (cutCache.size > 20_000) cutCache.clear();
    cutCache.set(key, next);
    left = next;
    if (!left) return null;
  }
  return left;
}

/**
 * Per-region verdicts over the whole station set, cached by region signature.
 *
 * The station set is fixed for the life of the app, and a region is a pure
 * function of its ask, so "which zones survive this answer" only ever needs
 * computing once. Re-evaluating the log after an undo then costs a few set
 * intersections instead of thousands of polygon predicates.
 */
const verdictCache = new Map<string, { yes: Set<string>; no: Set<string> }>();

function verdictsFor(
  sig: string,
  region: Region,
  stations: Station[],
  strictness: Strictness,
): { yes: Set<string>; no: Set<string> } {
  const key = `${sig}|${strictness}|${stationSetKey(stations)}|r${boardZoneRadiusM}`;
  let v = verdictCache.get(key);
  if (v) return v;

  const yes = new Set<string>();
  const no = new Set<string>();
  for (const s of stations) {
    if (possible(s, region, strictness)) yes.add(s.id);
    if (possibleOutside(s, region, strictness)) no.add(s.id);
  }
  v = { yes, no };
  if (verdictCache.size > 200) verdictCache.clear();
  verdictCache.set(key, v);
  return v;
}

function pointFeature(s: Station): Feature<any> {
  return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } };
}

export type ResolvedAsk = {
  entry: AskEntry;
  question: Question;
  /** The area the hider must be in, given the answer. Null = no constraint. */
  region: Region | null;
  /** Set when the answer was "no"/"further"/"colder" and region is the yes-area. */
  inverted: boolean;
  note?: string;
  /**
   * Measuring: how far the seeker was from their nearest feature.
   *
   * Raw metres, not a formatted string. The engine has no business knowing
   * whether this player reads miles or kilometres — that is a display choice,
   * and baking it in here is how "0.42 km" ended up printed in a log next to
   * "0.26 mi" elsewhere on the same screen.
   */
  radiusM?: number;
};

/**
 * Regions are pure functions of (question, origin, destination, answer), so the
 * same inputs always produce the same polygon. Without this cache, every React
 * re-render rebuilt every region in the log — and the self-consistency property
 * test rebuilt the same ten regions once per station.
 */
const regionCache = new Map<string, ResolvedAsk>();

function signature(entry: AskEntry): string {
  const a = entry.answer as any;
  return [
    entry.questionId,
    entry.origin.map((n) => n.toFixed(6)).join(','),
    entry.destination?.map((n) => n.toFixed(6)).join(',') ?? '',
    entry.distanceM ?? '',
    a.kind,
    a.value ?? a.poiId ?? '',
  ].join('|');
}

/**
 * Turn one answered question into a region plus polarity.
 *
 * `region` is always the *yes* area. `inverted` says the hider is outside it.
 */
export function resolveAsk(
  entry: AskEntry,
  question: Question,
  layers: Record<string, PoiLayer>,
  boundary: Boundary,
): ResolvedAsk {
  const base: ResolvedAsk = { entry, question, region: null, inverted: false };
  if (entry.disabled) return base;

  const key = signature(entry);
  const hit = regionCache.get(key);
  // Cached geometry, re-attached to this particular log entry.
  if (hit) return { ...hit, entry };

  const computed = computeAsk(entry, question, layers, boundary);
  if (regionCache.size > 400) regionCache.clear();
  regionCache.set(key, computed);
  return computed;
}

function computeAsk(
  entry: AskEntry,
  question: Question,
  layers: Record<string, PoiLayer>,
  boundary: Boundary,
): ResolvedAsk {
  const base: ResolvedAsk = { entry, question, region: null, inverted: false };
  if (entry.answer.kind === 'null' || entry.answer.kind === 'photo') return base;

  switch (question.category) {
    case 'radar': {
      // "Choose" carries no fixed radius, so the one picked when the question
      // was asked is the only one there is.
      const radiusM = entry.distanceM ?? question.distanceM;
      if (!radiusM) return base;
      const r = radarRegion(entry.origin, radiusM, boundary);
      return { ...base, region: r, inverted: entry.answer.kind === 'yesno' && entry.answer.value === 'no' };
    }
    case 'thermometer': {
      if (!entry.destination) return base;
      const warmer = entry.answer.kind === 'hotterColder' && entry.answer.value === 'hotter';
      // The region is built for the answer given, so no inversion is needed.
      return { ...base, region: thermometerRegion(entry.origin, entry.destination, warmer, boundary) };
    }
    case 'matching': {
      const layer = question.layer ? layers[question.layer] : undefined;
      if (!layer) return base;
      const m = matchingRegion(entry.origin, layer, boundary);
      if (!m) return base;
      return {
        ...base,
        region: m.region,
        inverted: entry.answer.kind === 'yesno' && entry.answer.value === 'no',
        note: m.nearestId ? `seeker's nearest: ${m.nearestId}` : undefined,
      };
    }
    case 'measuring': {
      const layer = question.layer ? layers[question.layer] : undefined;
      if (!layer) return base;
      const m = measuringRegion(entry.origin, layer, boundary);
      if (!m) return base;
      return {
        ...base,
        region: m.region,
        inverted: entry.answer.kind === 'closerFurther' && entry.answer.value === 'further',
        radiusM: m.radiusM,
      };
    }
    case 'tentacle': {
      const layer = question.layer ? layers[question.layer] : undefined;
      if (!layer || entry.answer.kind !== 'tentacle') return base;
      const reachM = entry.distanceM ?? question.distanceM;
      if (!reachM) return base;
      const r = tentacleRegion(entry.origin, layer, reachM, entry.answer.poiId, boundary);
      // A "not within reach" answer means the hider is outside the whole disk.
      return { ...base, region: r, inverted: entry.answer.poiId === null };
    }
    default:
      return base;
  }
}

/** Apply the whole ask log to the station set. */
export function evaluate(
  stations: Station[],
  asks: AskEntry[],
  questionsById: Record<string, Question>,
  layers: Record<string, PoiLayer>,
  boundary: Boundary,
  strictness: Strictness,
): {
  verdicts: ZoneVerdict[];
  resolved: ResolvedAsk[];
  alive: Station[];
  /** Loose only: what is left of each surviving zone that an answer has cut into, by station id. */
  cuts: Map<string, Feature<Polygon | MultiPolygon>>;
} {
  const resolved = asks
    .map((a) => (questionsById[a.questionId] ? resolveAsk(a, questionsById[a.questionId], layers, boundary) : null))
    .filter(Boolean) as ResolvedAsk[];

  // One survivor set per answered question, then intersect.
  const survivorSets = resolved.map((r) => {
    if (!r.region) return null;
    const sig = signature(r.entry);
    const v = verdictsFor(sig, r.region, stations, strictness);
    // A zone the region both touches and does not swallow is crossed by it:
    // for loose, that is a zone this answer cuts.
    return { id: r.entry.id, sig, region: r.region, inverted: r.inverted, set: v[r.inverted ? 'no' : 'yes'], v };
  });

  const cuts = new Map<string, Feature<Polygon | MultiPolygon>>();
  const verdicts: ZoneVerdict[] = stations.map((station) => {
    const killedBy: string[] = [];
    for (const s of survivorSets) {
      if (!s) continue;
      if (!s.set.has(station.id)) killedBy.push(s.id);
    }
    if (strictness === 'loose' && killedBy.length === 0) {
      const crossing = survivorSets.filter((s): s is NonNullable<typeof s> => !!s && s.v.yes.has(station.id) && s.v.no.has(station.id));
      if (crossing.length) {
        const left = cutZone(station, crossing);
        // The cuts together left nothing: the last of them is what finished it.
        if (!left) killedBy.push(crossing[crossing.length - 1].id);
        else cuts.set(station.id, left);
      }
    }
    return { station, alive: killedBy.length === 0, killedBy };
  });

  return { verdicts, resolved, alive: verdicts.filter((v) => v.alive).map((v) => v.station), cuts };
}

/**
 * Nearest feature distance from each station to a layer, computed once.
 *
 * 276 stations x 278 parks is 76,000 projections; doing that per render made
 * the question list janky. Layers never change after load, so cache by key.
 */
const nearestCache = new Map<string, Map<string, { distanceM: number; id: string }>>();

/**
 * Filled per station, on demand. It used to be filled once from whichever
 * stations the first caller passed and then returned as-is — so a call made
 * with only the surviving zones left every other station permanently missing,
 * and a swapped board would have read the old board's distances.
 */
function nearestPerStation(layer: PoiLayer, stations: Station[]) {
  let m = nearestCache.get(layer.key);
  if (!m) nearestCache.set(layer.key, (m = new Map()));

  let idx: ReturnType<typeof layerIndex> | undefined;
  const out = new Map<string, { distanceM: number; id: string }>();
  for (const s of stations) {
    const key = stationKey(s);
    let n = m.get(key);
    if (!n) {
      // Project the layer once, then walk stations against flat typed arrays.
      idx ??= layerIndex(layer);
      const [sx, sy] = toUTMCached([s.lon, s.lat]);
      const hit = nearestProjected(idx, sx, sy);
      n = hit ? { distanceM: hit.distanceM, id: hit.id } : { distanceM: Infinity, id: '' };
      if (m.size > 20_000) m.clear();
      m.set(key, n);
    }
    out.set(s.id, n);
  }
  return out;
}

/**
 * What a question would do if asked right now, from `origin`.
 *
 * This is an *advisory* indicator, and it deliberately answers a simpler
 * question than the elimination engine: how would the answer split the
 * surviving stations by their centre points? That makes it exact arithmetic —
 * no polygons — which matters because it runs for every question in the open
 * category on every render. Doing it with the full conservative geometry meant
 * thousands of polygon predicates synchronously during render, and the panel
 * locked up for seconds on open.
 *
 * The centre-point split is also the more useful number to look at: it always
 * partitions (yes + no = total), so a 138/138 reading tells you the question
 * halves the board, while 276/0 tells you not to bother asking.
 */
export function previewSplit(
  question: Question,
  origin: LngLat,
  alive: Station[],
  layers: Record<string, PoiLayer>,
): { yes: number; no: number } | null {
  if (!alive.length) return { yes: 0, no: 0 };

  if (question.category === 'radar') {
    if (!question.distanceM) return null; // "Choose" has no fixed radius
    let yes = 0;
    for (const s of alive) if (metresCached(origin, [s.lon, s.lat]) <= question.distanceM) yes++;
    return { yes, no: alive.length - yes };
  }

  const layer = question.layer ? layers[question.layer] : undefined;
  if (!layer || layer.features.length === 0) return null;

  const mine = nearestTo(layerIndex(layer), origin);
  if (!mine) return null;
  const perStation = nearestPerStation(layer, alive);

  if (question.category === 'measuring') {
    let yes = 0;
    for (const s of alive) {
      const n = perStation.get(s.id);
      if (n && n.distanceM < mine.distanceM) yes++;
    }
    return { yes, no: alive.length - yes };
  }

  if (question.category === 'matching') {
    const myId = mine.id;
    let yes = 0;
    for (const s of alive) if (perStation.get(s.id)?.id === myId) yes++;
    return { yes, no: alive.length - yes };
  }

  // Thermometer needs actual travel; photo and tentacle have no binary split.
  return null;
}

/** Layers are immutable after load, but clear if they are ever swapped. */
export function resetPreviewCaches(): void {
  nearestCache.clear();
}

/**
 * Everything here that was computed for one board and would be wrong on
 * another: regions are clipped to a boundary and built from a layer, zones
 * and verdicts are projected in a UTM zone. Called by engine/reset.ts.
 */
export function resetCandidateCaches(): void {
  zoneCache.clear();
  cutCache.clear();
  verdictCache.clear();
  regionCache.clear();
  nearestCache.clear();
}
