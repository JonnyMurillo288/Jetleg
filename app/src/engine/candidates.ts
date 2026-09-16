import booleanIntersects from '@turf/boolean-intersects';
import booleanContains from '@turf/boolean-contains';
import circleOf from '@turf/circle';
import turfBbox from '@turf/bbox';
import type { BBox, Feature, Polygon } from 'geojson';
import type { AskEntry, Boundary, LngLat, PoiLayer, Question, Station } from './types';
import {
  districtFeatureAt, districtRegion, groupedMatchingRegion, matchingRegion,
  measuringRegion, radarRegion, tentacleRegion, thermometerRegion,
  type Region,
} from './regions';
import { metresCached, toUTMCached } from './project';
import { layerIndex, nearestProjected, nearestTo } from './spatial';
import { stationNameLength } from './stationName';
import { STATION_NAME_LENGTH_QUESTION_ID } from './questions';

export const ZONE_RADIUS_M = 500;

/**
 * How strictly to eliminate.
 *
 * The rulebook is explicit that every answer describes the hider's *current
 * location*, not their hiding zone — and the hider may roam anywhere inside a
 * 500 m circle. So a zone contradicts an answer only if every point in it does.
 *
 * 'conservative' honours that and can never eliminate the true zone.
 * 'strict' tests the station centre alone: it narrows faster, and is wrong
 * whenever the hider is near the edge of their circle.
 */
export type Strictness = 'conservative' | 'strict';

export type ZoneVerdict = {
  station: Station;
  alive: boolean;
  /** Ask-entry ids that ruled this zone out. */
  killedBy: string[];
};

const zoneCache = new Map<string, Feature<Polygon>>();
export function zoneOf(station: Station): Feature<Polygon> {
  let z = zoneCache.get(station.id);
  if (!z) {
    z = circleOf([station.lon, station.lat], ZONE_RADIUS_M, { steps: 64, units: 'meters' }) as Feature<Polygon>;
    zoneCache.set(station.id, z);
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
 * Conservative: survives if any part of the zone is inside the region.
 * Strict: survives only if the station centre is inside.
 *
 * Both paths start with a bounding-box test. Regions are clipped to the city
 * boundary and so inherit its ~2,600 vertices; a full polygon predicate against
 * that costs about a millisecond, and the app runs 276 of them per answer. The
 * bbox check rejects most stations outright and is exact when it fires.
 */
function possible(station: Station, region: Region, strictness: Strictness): boolean {
  const geom = strictness === 'strict' ? pointFeature(station) : zoneOf(station);
  if (disjoint(bboxOf(geom), bboxOf(region))) return false;
  return booleanIntersects(geom, region);
}

/** The inverse: the truth is *outside* `region`. */
function possibleOutside(station: Station, region: Region, strictness: Strictness): boolean {
  if (strictness === 'strict') {
    const p = pointFeature(station);
    if (disjoint(bboxOf(p), bboxOf(region))) return true;
    return !booleanIntersects(p, region);
  }
  // Survives unless the zone is wholly swallowed by the region. A zone whose
  // bbox is not inside the region's bbox cannot possibly be contained.
  const zone = zoneOf(station);
  if (!contains(bboxOf(region), bboxOf(zone))) return true;
  try {
    return !booleanContains(region, zone);
  } catch {
    return true;
  }
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
  const key = `${sig}|${strictness}|${stations.length}`;
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
      const inverted = entry.answer.kind === 'yesno' && entry.answer.value === 'no';

      if (layer.kind === 'polygon') {
        const d = districtRegion(entry.origin, layer, boundary);
        if (!d) return base;
        return {
          ...base, region: d.region, inverted,
          note: d.nearestId ? `seeker's district: ${d.nearestId}` : undefined,
        };
      }

      if (question.id === STATION_NAME_LENGTH_QUESTION_ID) {
        const g = groupedMatchingRegion(
          entry.origin, layer, (f) => stationNameLength((f.properties?.name as string) ?? ''), boundary,
        );
        if (!g) return base;
        return {
          ...base, region: g.region, inverted,
          note: g.groupKey !== null ? `seeker's station name length: ${g.groupKey}` : undefined,
        };
      }

      const m = matchingRegion(entry.origin, layer, boundary);
      if (!m) return base;
      return {
        ...base, region: m.region, inverted,
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
): { verdicts: ZoneVerdict[]; resolved: ResolvedAsk[]; alive: Station[] } {
  const resolved = asks
    .map((a) => (questionsById[a.questionId] ? resolveAsk(a, questionsById[a.questionId], layers, boundary) : null))
    .filter(Boolean) as ResolvedAsk[];

  // One survivor set per answered question, then intersect.
  const survivorSets = resolved.map((r) =>
    r.region ? { id: r.entry.id, set: verdictsFor(signature(r.entry), r.region, stations, strictness)[r.inverted ? 'no' : 'yes'] } : null,
  );

  const verdicts: ZoneVerdict[] = stations.map((station) => {
    const killedBy: string[] = [];
    for (const s of survivorSets) {
      if (!s) continue;
      if (!s.set.has(station.id)) killedBy.push(s.id);
    }
    return { station, alive: killedBy.length === 0, killedBy };
  });

  return { verdicts, resolved, alive: verdicts.filter((v) => v.alive).map((v) => v.station) };
}

/**
 * Nearest feature distance from each station to a layer, computed once.
 *
 * 276 stations x 278 parks is 76,000 projections; doing that per render made
 * the question list janky. Layers never change after load, so cache by key.
 */
const nearestCache = new Map<string, Map<string, { distanceM: number; id: string }>>();

/**
 * District membership per station, cached by layer key — the same model as
 * `nearestCache` below, and for the same reason: 192 stations x 11 polygons
 * of DataSF's own vertex density is cheap once and not worth repeating on
 * every render.
 */
const districtCache = new Map<string, Map<string, string | null>>();

function districtPerStation(layer: PoiLayer, stations: Station[]) {
  let m = districtCache.get(layer.key);
  if (m) return m;
  m = new Map();
  for (const s of stations) {
    const f = districtFeatureAt([s.lon, s.lat], layer);
    m.set(s.id, (f?.properties?.id as string) ?? null);
  }
  districtCache.set(layer.key, m);
  return m;
}

function nearestPerStation(layer: PoiLayer, stations: Station[]) {
  let m = nearestCache.get(layer.key);
  if (m) return m;

  // Project the layer once, then walk stations against flat typed arrays.
  const idx = layerIndex(layer);
  m = new Map();
  for (const s of stations) {
    const [sx, sy] = toUTMCached([s.lon, s.lat]);
    const n = nearestProjected(idx, sx, sy);
    m.set(s.id, n ? { distanceM: n.distanceM, id: n.id } : { distanceM: Infinity, id: '' });
  }
  nearestCache.set(layer.key, m);
  return m;
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

  // Polygon-partition layers (districts) match by containment, not nearest
  // feature — `layerIndex` assumes point/line geometry and would be nonsense
  // here, so this must branch before it runs.
  if (question.category === 'matching' && layer.kind === 'polygon') {
    const mineDistrict = districtFeatureAt(origin, layer)?.properties?.id ?? null;
    if (mineDistrict === null) return null;
    const perStation = districtPerStation(layer, alive);
    let yes = 0;
    for (const s of alive) if (perStation.get(s.id) === mineDistrict) yes++;
    return { yes, no: alive.length - yes };
  }

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
    if (question.id === STATION_NAME_LENGTH_QUESTION_ID) {
      const myLen = stationNameLength(mine.name);
      let yes = 0;
      for (const s of alive) if (stationNameLength(s.name) === myLen) yes++;
      return { yes, no: alive.length - yes };
    }
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
  districtCache.clear();
}
