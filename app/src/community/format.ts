import type { Feature, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import type { GameSize, Mode, Station } from '../engine/types';
import { LAYER_DEFS, VORONOI_KEYS } from '../data/layers';

/**
 * The community map file — `*.jetleg-map.json`.
 *
 * Two kinds, one format:
 *
 *  - `kind: 'stations'` — the part of a game a group actually argues about:
 *    which stations are hiding zones, and which house rules are on. It plays
 *    on a city board the app already ships.
 *  - `kind: 'pack'` — a whole board for any city: its boundary, its stations,
 *    every POI layer the questions ask about, and the Voronoi cells of each.
 *    Everything `pipeline/` produced for San Francisco, in one document, so
 *    the app needs nothing else to play there.
 *
 * A pack carries its cells rather than leaving each phone to compute them:
 * cutting a few hundred cells against a city boundary is seconds of work,
 * and it is the same reason the pipeline precomputed San Francisco's.
 *
 * This module is the one validator. The same function reads a file off disk,
 * a row from the server and a draft about to be published, so a map that
 * loads in one place cannot be malformed in another.
 */

export const MAP_FORMAT = 'jetleg-map';
export const MAP_FORMAT_VERSION = 1;
export const MAP_FILE_SUFFIX = '.jetleg-map.json';

/** A published map may not exceed this, serialized. A full San Francisco pack is about 1.6 MB. */
export const MAX_PACK_BYTES = 4_000_000;
const MAX_LAYER_FEATURES = 3_000;
const MAX_BOUNDARY_VERTICES = 40_000;

export const MIN_STATIONS = 2;
export const MAX_STATIONS = 600;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 2000;

const MODES: Mode[] = ['rail', 'metro', 'bus', 'cablecar', 'ferry'];
const SIZES: GameSize[] = ['small', 'medium', 'large'];

export type MapStation = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  modes: Mode[];
  routes: string[];
};

/** House rules a map can pin. Absent means "whatever the player has set". */
export type MapRules = {
  gameSize?: GameSize;
  supervisorDistrictsAsAdmin4?: boolean;
};

type MapCommon = {
  format: typeof MAP_FORMAT;
  formatVersion: typeof MAP_FORMAT_VERSION;
  /** A station map: the shipped board it plays on. A pack: a short label for its own city. */
  city: string;
  name: string;
  description: string;
  rules: MapRules;
  stations: MapStation[];
};

export type StationsMap = MapCommon & { kind: 'stations' };

export type LayerFeature = Feature<Point | LineString | MultiLineString, { id: string; name: string }>;
export type CellFeature = Feature<Polygon | MultiPolygon, { id: string; name: string; layer: string }>;

export type PackMap = MapCommon & {
  kind: 'pack';
  /** One landmass. Everything outside it is out of play. */
  boundary: Polygon;
  /** By layer key (data/layers.ts). A key that is absent is a category not in play. */
  layers: Record<string, LayerFeature[]>;
  /** Voronoi cells by point-layer key, clipped to the boundary. */
  voronoi: Record<string, CellFeature[]>;
  /**
   * Layers whose cells the author supplied by hand. Every other layer's cells
   * are rebuilt from its points whenever the pack is finalized, so they can
   * never drift from the points; these are left exactly as given.
   */
  customVoronoi: string[];
};

export type MapFile = StationsMap | PackMap;

export type Parsed = { ok: true; map: MapFile } | { ok: false; error: string };
const bad = (error: string): Parsed => ({ ok: false, error });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The pipeline's own id style: lowercase letters and digits, nothing else. */
export function slugId(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '') || 'station';
}

function readStations(raw: unknown): { ok: true; stations: MapStation[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'The map has no station list.' };
  if (raw.length < MIN_STATIONS) return { ok: false, error: `A map needs at least ${MIN_STATIONS} stations.` };
  if (raw.length > MAX_STATIONS) return { ok: false, error: `A map can have at most ${MAX_STATIONS} stations; this one has ${raw.length}.` };

  const used = new Set<string>();
  const stations: MapStation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!isObject(s)) return { ok: false, error: `Station ${i + 1} is not an object.` };
    const name = str(s.name, MAX_NAME);
    if (!name) return { ok: false, error: `Station ${i + 1} has no name.` };
    const { lon, lat } = s;
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)
      || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      return { ok: false, error: `Station “${name}” has no valid position.` };
    }
    // Ids are what a round's log refers to, so they must be unique and stable.
    // An id the file already carries is kept exactly if it is well-formed —
    // the shipped board has ids like `divisaderoeddy-2`, and a finished
    // round's log refers to them. Only a missing or odd one is derived.
    const given = str(s.id, MAX_NAME);
    const base = /^[a-z0-9][a-z0-9-]*$/.test(given) ? given : slugId(given || name);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}${n}`;
    used.add(id);

    // In the file's own order, so reading a map and writing it back changes nothing.
    const modes = Array.isArray(s.modes)
      ? [...new Set((s.modes as unknown[]).filter((m): m is Mode => MODES.includes(m as Mode)))]
      : [];
    const routes = Array.isArray(s.routes)
      ? (s.routes as unknown[]).filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 24)).slice(0, 40)
      : [];
    stations.push({ id, name, lon: round6(lon), lat: round6(lat), modes: modes.length ? modes : ['bus'], routes });
  }
  return { ok: true, stations };
}

export function parseMapFile(raw: unknown): Parsed {
  if (!isObject(raw)) return bad('This is not a JetLeg map file.');
  if (raw.format !== MAP_FORMAT) return bad('This is not a JetLeg map file.');
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > MAP_FORMAT_VERSION) {
    return bad('This map was made with a newer version of the app. Update to open it.');
  }
  if (raw.kind !== 'stations' && raw.kind !== 'pack') return bad('This map is of a kind this app does not know.');

  const name = str(raw.name, MAX_NAME);
  if (!name) return bad('The map has no name.');
  const city = str(raw.city, 24).toLowerCase();
  if (!city) return bad('The map does not say which city it is for.');

  const rules: MapRules = {};
  if (isObject(raw.rules)) {
    if (SIZES.includes(raw.rules.gameSize as GameSize)) rules.gameSize = raw.rules.gameSize as GameSize;
    if (typeof raw.rules.supervisorDistrictsAsAdmin4 === 'boolean') {
      rules.supervisorDistrictsAsAdmin4 = raw.rules.supervisorDistrictsAsAdmin4;
    }
  }

  const read = readStations(raw.stations);
  if (!read.ok) return bad(read.error);

  const common: MapCommon = {
    format: MAP_FORMAT,
    formatVersion: MAP_FORMAT_VERSION,
    city,
    name,
    description: str(raw.description, MAX_DESCRIPTION),
    rules,
    stations: read.stations,
  };
  if (raw.kind === 'stations') return { ok: true, map: { ...common, kind: 'stations' } };

  const boundary = readBoundary(raw.boundary);
  if (!boundary.ok) return bad(boundary.error);

  const layers: Record<string, LayerFeature[]> = {};
  const rawLayers = isObject(raw.layers) ? raw.layers : {};
  for (const def of LAYER_DEFS) {
    if (!(def.key in rawLayers)) continue;
    const got = readLayer(def.key, def.kind, rawLayers[def.key]);
    if (!got.ok) return bad(`${def.label}: ${got.error}`);
    layers[def.key] = got.features;
  }

  const voronoi: Record<string, CellFeature[]> = {};
  const rawCells = isObject(raw.voronoi) ? raw.voronoi : {};
  for (const key of VORONOI_KEYS) {
    if (!(key in rawCells)) continue;
    const got = readCells(key, rawCells[key]);
    if (!got.ok) return bad(`Voronoi cells for ${key}: ${got.error}`);
    voronoi[key] = got.cells;
  }

  const customVoronoi = Array.isArray(raw.customVoronoi)
    ? (VORONOI_KEYS as readonly string[]).filter((k) => (raw.customVoronoi as unknown[]).includes(k) && k in voronoi)
    : [];

  return { ok: true, map: { ...common, kind: 'pack', boundary: boundary.polygon, layers, voronoi, customVoronoi } };
}

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
  && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const pos = (p: Position): Position => [round6(p[0]), round6(p[1])];

function readRings(raw: unknown): Position[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rings: Position[][] = [];
  for (const ring of raw) {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) return null;
    const out = (ring as Position[]).map(pos);
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
    rings.push(out);
  }
  return rings;
}

/** A boundary is one polygon. Accepts a bare geometry or a Feature wrapping one. */
export function readBoundary(raw: unknown): { ok: true; polygon: Polygon } | { ok: false; error: string } {
  const geom = isObject(raw) && raw.type === 'Feature' ? raw.geometry : raw;
  if (!isObject(geom) || geom.type !== 'Polygon') {
    return { ok: false, error: 'The boundary must be a single polygon.' };
  }
  const rings = readRings(geom.coordinates);
  if (!rings) return { ok: false, error: 'The boundary polygon is malformed.' };
  const vertices = rings.reduce((n, r) => n + r.length, 0);
  if (vertices > MAX_BOUNDARY_VERTICES) {
    return { ok: false, error: `The boundary has ${vertices} points; simplify it to under ${MAX_BOUNDARY_VERTICES}.` };
  }
  return { ok: true, polygon: { type: 'Polygon', coordinates: rings } };
}

function featureIdentity(f: Record<string, unknown>, key: string, i: number, used: Set<string>): { id: string; name: string } {
  const p = isObject(f.properties) ? f.properties : {};
  const name = str(p.name ?? p.title ?? p.label, MAX_NAME) || str(p.id, MAX_NAME) || `${key} ${i + 1}`;
  const base = str(p.id, 120) || `${key}-${slugId(name)}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return { id, name };
}

/** One layer's features. Anything that is not the layer's own geometry type is an error, not skipped. */
export function readLayer(key: string, kind: 'point' | 'line', raw: unknown): { ok: true; features: LayerFeature[] } | { ok: false; error: string } {
  const list = isObject(raw) && raw.type === 'FeatureCollection' ? raw.features : raw;
  if (!Array.isArray(list)) return { ok: false, error: 'not a list of features.' };
  if (list.length > MAX_LAYER_FEATURES) return { ok: false, error: `${list.length} features; the limit is ${MAX_LAYER_FEATURES}.` };
  const used = new Set<string>();
  const features: LayerFeature[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!isObject(f) || !isObject(f.geometry)) return { ok: false, error: `feature ${i + 1} has no geometry.` };
    const g = f.geometry;
    let geometry: Point | LineString | MultiLineString;
    if (kind === 'point') {
      if (g.type !== 'Point' || !isPosition(g.coordinates)) return { ok: false, error: `feature ${i + 1} is not a point.` };
      geometry = { type: 'Point', coordinates: pos(g.coordinates) };
    } else if (g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2 && g.coordinates.every(isPosition)) {
      geometry = { type: 'LineString', coordinates: (g.coordinates as Position[]).map(pos) };
    } else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)
      && g.coordinates.every((l) => Array.isArray(l) && l.length >= 2 && l.every(isPosition))) {
      geometry = { type: 'MultiLineString', coordinates: (g.coordinates as Position[][]).map((l) => l.map(pos)) };
    } else {
      return { ok: false, error: `feature ${i + 1} is not a line.` };
    }
    const properties = featureIdentity(f, key, i, used);
    features.push({ type: 'Feature', id: properties.id, properties, geometry });
  }
  return { ok: true, features };
}

export function readCells(key: string, raw: unknown): { ok: true; cells: CellFeature[] } | { ok: false; error: string } {
  const list = isObject(raw) && raw.type === 'FeatureCollection' ? raw.features : raw;
  if (!Array.isArray(list)) return { ok: false, error: 'not a list of features.' };
  if (list.length > MAX_LAYER_FEATURES) return { ok: false, error: `${list.length} cells; the limit is ${MAX_LAYER_FEATURES}.` };
  const cells: CellFeature[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!isObject(f) || !isObject(f.geometry)) return { ok: false, error: `cell ${i + 1} has no geometry.` };
    const g = f.geometry;
    const p = isObject(f.properties) ? f.properties : {};
    // A cell is matched to its point by id, so one without an id is useless.
    const id = str(p.id, 120) || str(p.name, MAX_NAME);
    if (!id) return { ok: false, error: `cell ${i + 1} has no id to match it to a point.` };
    let geometry: Polygon | MultiPolygon;
    if (g.type === 'Polygon') {
      const rings = readRings(g.coordinates);
      if (!rings) return { ok: false, error: `cell “${id}” is malformed.` };
      geometry = { type: 'Polygon', coordinates: rings };
    } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
      const polys = (g.coordinates as unknown[]).map(readRings);
      if (polys.some((r) => !r)) return { ok: false, error: `cell “${id}” is malformed.` };
      geometry = { type: 'MultiPolygon', coordinates: polys as Position[][][] };
    } else {
      return { ok: false, error: `cell “${id}” is not a polygon.` };
    }
    cells.push({ type: 'Feature', id, properties: { id, name: str(p.name, MAX_NAME) || id, layer: key }, geometry });
  }
  return { ok: true, cells };
}

/**
 * A plain GeoJSON file of points — what QGIS, geojson.io or a GTFS export
 * gives you — read as a station list. The name comes from whichever of the
 * usual properties is present.
 */
export function mapFromGeoJSON(raw: unknown, name: string, city: string): Parsed {
  if (!isObject(raw) || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    return bad('This is not a GeoJSON feature collection.');
  }
  const stations: unknown[] = [];
  for (const f of raw.features as unknown[]) {
    if (!isObject(f) || !isObject(f.geometry) || f.geometry.type !== 'Point') continue;
    const c = f.geometry.coordinates;
    if (!Array.isArray(c)) continue;
    const p = isObject(f.properties) ? f.properties : {};
    stations.push({
      id: p.id,
      name: p.name ?? p.stop_name ?? p.station ?? p.title ?? p.label,
      lon: c[0],
      lat: c[1],
      modes: p.modes,
      routes: p.routes,
    });
  }
  if (stations.length === 0) return bad('That GeoJSON file has no point features to use as stations.');
  return parseMapFile({
    format: MAP_FORMAT, formatVersion: MAP_FORMAT_VERSION, kind: 'stations',
    city, name, description: '', rules: {}, stations,
  });
}

/** Reads either kind of file a player might pick: a map file, or bare GeoJSON points. */
export function readMapText(text: string, fallbackName: string, city: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('That file is not valid JSON.');
  }
  if (isObject(raw) && raw.type === 'FeatureCollection') return mapFromGeoJSON(raw, fallbackName, city);
  return parseMapFile(raw);
}

/** Fixed key order, so the same map always serializes to the same bytes. */
export function serializeMap(map: MapFile): string {
  const common = {
    format: map.format,
    formatVersion: map.formatVersion,
    kind: map.kind,
    city: map.city,
    name: map.name,
    description: map.description,
    rules: map.rules,
    stations: map.stations.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, modes: s.modes, routes: s.routes })),
  };
  if (map.kind === 'stations') return JSON.stringify(common, null, 1);
  // A pack is megabytes of coordinates; indenting it would double that.
  const byKey = <T,>(rec: Record<string, T>, order: readonly string[]) =>
    Object.fromEntries(order.filter((k) => k in rec).map((k) => [k, rec[k]]));
  return JSON.stringify({
    ...common,
    boundary: map.boundary,
    layers: byKey(map.layers, LAYER_DEFS.map((d) => d.key)),
    voronoi: byKey(map.voronoi, VORONOI_KEYS),
    customVoronoi: map.customVoronoi,
  });
}

/** The board currently on screen, as a map — the starting point for a new one. */
export function mapFromBoard(stations: Station[], rules: MapRules, name: string, city: string): StationsMap {
  return {
    format: MAP_FORMAT,
    formatVersion: MAP_FORMAT_VERSION,
    kind: 'stations',
    city,
    name,
    description: '',
    rules,
    stations: stations.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, modes: s.modes, routes: s.routes })),
  };
}

export type StationDiff = { added: MapStation[]; removed: MapStation[]; moved: MapStation[]; renamed: MapStation[] };

/** What changed between two versions of a map, station by station. */
export function diffStations(before: MapStation[], after: MapStation[]): StationDiff {
  const old = new Map(before.map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  const diff: StationDiff = { added: [], removed: [], moved: [], renamed: [] };
  for (const s of after) {
    const was = old.get(s.id);
    if (!was) diff.added.push(s);
    else if (was.lon !== s.lon || was.lat !== s.lat) diff.moved.push(s);
    else if (was.name !== s.name) diff.renamed.push(s);
  }
  for (const s of before) if (!now.has(s.id)) diff.removed.push(s);
  return diff;
}

export function describeDiff(d: StationDiff): string {
  const parts = [
    d.added.length && `${d.added.length} added`,
    d.removed.length && `${d.removed.length} removed`,
    d.moved.length && `${d.moved.length} moved`,
    d.renamed.length && `${d.renamed.length} renamed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no station changes';
}
