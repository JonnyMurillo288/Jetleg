import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBbox from '@turf/bbox';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { Mode } from '../engine/types';
import { projectionAt } from '../engine/project';
import { slugId, type LayerFeature, type MapStation } from './format';
import { boundaryFeature } from './pack';

/**
 * OpenStreetMap, from the browser — the fetching half of the pipeline.
 *
 * `pipeline/` built San Francisco by asking Overpass for each kind of place
 * and keeping what passed the rulebook's tests. These are the same queries
 * and the same tests (named features only, honorary consulates out, pools
 * out, one entry per place), pointed at whatever boundary the studio has
 * open. The parsing is separate from the fetching so it can be tested
 * without a network.
 *
 * Two public services are used, both free and both rate-limited: Nominatim
 * to find a place's outline by name, Overpass for everything inside it. A
 * busy Overpass answers 429 or 504; that is routine, and retried.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export type Place = {
  name: string;
  geometry: Polygon | MultiPolygon;
  bbox: [number, number, number, number];
};

/** Places matching a name that have an outline — a city, a borough, an island. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `${NOMINATIM}?format=jsonv2&polygon_geojson=1&limit=6&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}).`);
  const rows = (await res.json()) as { display_name: string; geojson?: { type: string }; boundingbox?: string[] }[];
  return rows
    .filter((r) => r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon') && r.boundingbox?.length === 4)
    .map((r) => {
      const [s, n, w, e] = r.boundingbox!.map(Number);
      return { name: r.display_name, geometry: r.geojson as Polygon | MultiPolygon, bbox: [w, s, e, n] };
    });
}

type Element = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; geometry?: { lat: number; lon: number }[] }[];
};

export async function overpass(query: string, signal?: AbortSignal, onWait?: (seconds: number) => void): Promise<Element[]> {
  let last = '';
  const waits = [5, 12, 25, 40];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    // A failed fetch here is usually the mirror refusing cross-origin use or
    // a dropped connection, not the user being offline — worth another go.
    const res = await fetch(OVERPASS[attempt % OVERPASS.length], {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    }).catch((e) => {
      if (signal?.aborted) throw e;
      return null;
    });
    if (res?.ok) {
      const parsed = (await res.json()) as { elements?: Element[] };
      if (!parsed.elements) throw new Error('OpenStreetMap returned nothing usable.');
      return parsed.elements;
    }
    last = res ? `HTTP ${res.status}` : 'no connection';
    if (res && ![429, 502, 503, 504].includes(res.status)) break;
    if (attempt === waits.length) break;
    onWait?.(waits[attempt]);
    await new Promise((r) => setTimeout(r, waits[attempt] * 1000));
  }
  throw new Error(`OpenStreetMap is not answering (${last}). It is a shared free service — try again in a minute.`);
}

const bboxClause = (boundary: Polygon) => {
  const [w, s, e, n] = turfBbox(boundary);
  return `${s},${w},${n},${e}`;
};

// ------------------------------------------------------------------ POI layers

type PoiDef = { tag: [string, string]; reject?: (tags: Record<string, string>) => boolean };

/** Step 04's layer definitions: the same tags, the same exclusions. */
export const POI_DEFS: Record<string, PoiDef> = {
  parks: { tag: ['leisure', 'park'] },
  libraries: { tag: ['amenity', 'library'] },
  museums: { tag: ['tourism', 'museum'] },
  hospitals: { tag: ['amenity', 'hospital'] },
  movieTheaters: { tag: ['amenity', 'cinema'] },
  // The rulebook excludes honorary consulates.
  consulates: { tag: ['office', 'diplomatic'], reject: (t) => t.diplomatic === 'honorary_consulate' || t.consulate === 'honorary' },
  // Outdoor courses only; mini-golf and driving ranges do not count.
  golfCourses: { tag: ['leisure', 'golf_course'], reject: (t) => t.golf === 'miniature' || t.leisure === 'miniature_golf' || t.golf === 'driving_range' },
  aquariums: { tag: ['tourism', 'aquarium'] },
  zoos: { tag: ['tourism', 'zoo'] },
  amusementParks: { tag: ['tourism', 'theme_park'] },
  mountains: { tag: ['natural', 'peak'] },
  // "Any named body of water, excluding pools."
  water: { tag: ['natural', 'water'], reject: (t) => t.water === 'pool' || t.leisure === 'swimming_pool' || t.water === 'reflecting_pool' },
};

const selectorOf = (def: PoiDef) => `["${def.tag[0]}"="${def.tag[1]}"]`;

export type Dropped = { unnamed: number; outside: number; rejected: number; duplicates: number };

/**
 * Everything is a POINT, because the rulebook measures to the map icon, not
 * to the nearest edge of a feature. Ways and relations arrive with Overpass's
 * `center`.
 */
export function parsePois(key: string, elements: Element[], boundary: Polygon): { features: LayerFeature[]; dropped: Dropped } {
  const def = POI_DEFS[key];
  const within = boundaryFeature(boundary);
  const seen = new Set<string>();
  const features: LayerFeature[] = [];
  const dropped: Dropped = { unnamed: 0, outside: 0, rejected: 0, duplicates: 0 };

  for (const el of elements) {
    const tags = el.tags ?? {};
    // A combined fetch returns every category at once; take only this one's.
    if (def && tags[def.tag[0]] !== def.tag[1]) continue;
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon === undefined || lat === undefined) continue;
    if (def?.reject?.(tags)) { dropped.rejected++; continue; }
    const name = tags.name ?? tags['name:en'];
    if (!name) { dropped.unnamed++; continue; }
    if (!booleanPointInPolygon([lon, lat], within)) { dropped.outside++; continue; }
    // OSM often carries both a node and an enclosing way for one place.
    const dedup = `${name.toLowerCase()}|${lon.toFixed(3)}|${lat.toFixed(3)}`;
    if (seen.has(dedup)) { dropped.duplicates++; continue; }
    seen.add(dedup);
    const id = `${key}-${el.id}`;
    features.push({ type: 'Feature', id, properties: { id, name: name.slice(0, 80) }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  }
  return { features, dropped };
}

export async function fetchPois(key: string, boundary: Polygon, signal?: AbortSignal, onWait?: (s: number) => void) {
  const def = POI_DEFS[key];
  if (!def) throw new Error(`There is no OpenStreetMap query for “${key}”.`);
  const elements = await overpass(`[out:json][timeout:120];( nwr${selectorOf(def)}(${bboxClause(boundary)}); );out center tags;`, signal, onWait);
  return parsePois(key, elements, boundary);
}

/**
 * Every category in one request.
 *
 * The pipeline asked twelve times, once per category, from a laptop with a
 * cache and all night to retry. A browser doing that trips Overpass's rate
 * limit by the fifth — it answers 429 and the rest of the board never
 * arrives. One query for the union, sorted by tag afterwards, is one slot.
 */
export async function fetchAllPois(boundary: Polygon, signal?: AbortSignal, onWait?: (s: number) => void) {
  const bb = bboxClause(boundary);
  const union = Object.values(POI_DEFS).map((def) => `nwr${selectorOf(def)}(${bb});`).join('');
  const elements = await overpass(`[out:json][timeout:180];(${union});out center tags;`, signal, onWait);
  return Object.fromEntries(Object.keys(POI_DEFS).map((key) => [key, parsePois(key, elements, boundary)]));
}

// -------------------------------------------------------------------- stations

function modesOf(tags: Record<string, string>): Mode[] {
  const m = new Set<Mode>();
  if (tags.amenity === 'ferry_terminal' || tags.ferry === 'yes') m.add('ferry');
  if (tags.railway === 'tram_stop' || tags.tram === 'yes' || tags.light_rail === 'yes' || tags.subway === 'yes' || tags.station === 'subway' || tags.station === 'light_rail') m.add('metro');
  if ((tags.railway === 'station' || tags.railway === 'halt') && !m.has('metro')) m.add('rail');
  if (tags.train === 'yes') m.add('rail');
  if (tags.highway === 'bus_stop' || tags.bus === 'yes' || tags.trolleybus === 'yes') m.add('bus');
  if (m.size === 0) m.add(tags.public_transport === 'station' ? 'rail' : 'bus');
  return [...m];
}

const MODE_RANK: Record<Mode, number> = { rail: 0, metro: 1, cablecar: 2, ferry: 3, bus: 4 };

/**
 * Transit stops as hiding stations. One stop on the ground is usually
 * several OSM nodes — a platform each way, an entrance, the station itself —
 * so same-named stops within 150 m are folded into one, at their average
 * position, with every mode any of them had.
 *
 * This is the short form of step 02. It does not recover route lists, and it
 * knows nothing of a city's own quirks (San Francisco's cable cars are tagged
 * as trams); stations can be corrected by hand afterwards.
 */
export function parseStations(elements: Element[], boundary: Polygon): { stations: MapStation[]; dropped: Dropped } {
  const within = boundaryFeature(boundary);
  const dropped: Dropped = { unnamed: 0, outside: 0, rejected: 0, duplicates: 0 };
  const raw: { name: string; lon: number; lat: number; modes: Mode[] }[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon === undefined || lat === undefined) continue;
    const name = tags.name ?? tags['name:en'];
    if (!name) { dropped.unnamed++; continue; }
    if (!booleanPointInPolygon([lon, lat], within)) { dropped.outside++; continue; }
    raw.push({ name: name.slice(0, 80), lon, lat, modes: modesOf(tags) });
  }
  if (!raw.length) return { stations: [], dropped };

  const proj = projectionAt(raw[0].lon, raw[0].lat);
  const groups: { name: string; xs: number[]; ys: number[]; modes: Set<Mode> }[] = [];
  const byName = new Map<string, typeof groups>();
  for (const r of raw) {
    const [x, y] = proj.toUTM([r.lon, r.lat]);
    const key = r.name.toLowerCase();
    const candidates = byName.get(key) ?? [];
    const near = candidates.find((g) => Math.hypot(g.xs[0] - x, g.ys[0] - y) < 150);
    if (near) {
      near.xs.push(x);
      near.ys.push(y);
      r.modes.forEach((m) => near.modes.add(m));
      dropped.duplicates++;
    } else {
      const g = { name: r.name, xs: [x], ys: [y], modes: new Set(r.modes) };
      groups.push(g);
      byName.set(key, [...candidates, g]);
    }
  }

  const used = new Set<string>();
  const stations = groups.map((g): MapStation => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const [lon, lat] = proj.toLngLat([mean(g.xs), mean(g.ys)]);
    const base = slugId(g.name);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return {
      id,
      name: g.name,
      lon: Math.round(lon * 1e6) / 1e6,
      lat: Math.round(lat * 1e6) / 1e6,
      modes: [...g.modes].sort((a, b) => MODE_RANK[a] - MODE_RANK[b]),
      routes: [],
    };
  });
  return { stations, dropped };
}

export async function fetchStations(boundary: Polygon, withBuses: boolean, signal?: AbortSignal, onWait?: (s: number) => void) {
  const bb = bboxClause(boundary);
  const elements = await overpass(
    `[out:json][timeout:120];(
       node["railway"~"^(station|halt|tram_stop)$"](${bb});
       node["public_transport"="station"](${bb});
       node["amenity"="ferry_terminal"](${bb});
       ${withBuses ? `node["highway"="bus_stop"](${bb});` : ''}
     );out;`,
    signal,
    onWait,
  );
  return parseStations(elements, boundary);
}

// ----------------------------------------------------------------- line layers

/** Step 05: one geometry per transit line, kept only if it actually touches the board. */
export function parseTransitLines(elements: Element[], boundary: Polygon): LayerFeature[] {
  const within = boundaryFeature(boundary);
  const seen = new Set<string>();
  const lines: LayerFeature[] = [];
  for (const rel of elements) {
    const t = rel.tags ?? {};
    const ref = t.ref ?? t.name;
    if (!ref || seen.has(ref)) continue; // one per line, not per direction
    const parts: Position[][] = [];
    for (const m of rel.members ?? []) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      parts.push(m.geometry.map((g) => [g.lon, g.lat]));
    }
    const inside = parts.flat().filter((c) => booleanPointInPolygon(c, within));
    if (inside.length < 2) continue;
    seen.add(ref);
    const id = `line-${ref}`;
    lines.push({ type: 'Feature', id, properties: { id, name: (t.name ?? ref).slice(0, 80) }, geometry: { type: 'MultiLineString', coordinates: parts } });
  }
  return lines;
}

export async function fetchTransitLines(boundary: Polygon, signal?: AbortSignal, onWait?: (s: number) => void) {
  const elements = await overpass(
    `[out:json][timeout:180];relation["type"="route"]["route"~"^(subway|light_rail|tram|train|ferry)$"](${bboxClause(boundary)});out geom;`,
    signal,
    onWait,
  );
  return parseTransitLines(elements, boundary);
}

/** Mapped coastline inside the board's bounding box, for a city that is not all shore. */
export function parseCoastline(elements: Element[]): LayerFeature[] {
  return elements
    .filter((el) => el.type === 'way' && (el.geometry?.length ?? 0) >= 2)
    .map((el) => {
      const id = `coast-${el.id}`;
      return { type: 'Feature', id, properties: { id, name: 'Coastline' }, geometry: { type: 'LineString', coordinates: el.geometry!.map((g) => [g.lon, g.lat]) } } as LayerFeature;
    });
}

export async function fetchCoastline(boundary: Polygon, signal?: AbortSignal, onWait?: (s: number) => void) {
  const elements = await overpass(`[out:json][timeout:120];way["natural"="coastline"](${bboxClause(boundary)});out geom;`, signal, onWait);
  return parseCoastline(elements);
}
