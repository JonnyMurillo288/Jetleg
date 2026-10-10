import type { GameSize, Mode, Station } from '../engine/types';

/**
 * The community map file — `*.jetleg-map.json`.
 *
 * A map is the part of a game a group actually argues about: which stations
 * are hiding zones, and which house rules are on. Version 1 carries exactly
 * that (`kind: 'stations'`) and plays on a city board the app already ships.
 *
 * `kind: 'pack'` is reserved for a whole city — boundary, stations and every
 * POI layer — which needs the pipeline to build. It is named here, and in the
 * database's own check constraint, so that adding it later is a new branch
 * in this file rather than a new format: every map published today already
 * says which kind it is.
 *
 * This module is the one validator. The same function reads a file off disk,
 * a row from the server and a draft about to be published, so a map that
 * loads in one place cannot be malformed in another.
 */

export const MAP_FORMAT = 'jetleg-map';
export const MAP_FORMAT_VERSION = 1;
export const MAP_FILE_SUFFIX = '.jetleg-map.json';

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

export type MapFile = {
  format: typeof MAP_FORMAT;
  formatVersion: typeof MAP_FORMAT_VERSION;
  kind: 'stations';
  /** Which shipped board this plays on. */
  city: string;
  name: string;
  description: string;
  rules: MapRules;
  stations: MapStation[];
};

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
  if (raw.kind === 'pack') return bad('This is a full city pack. This version of the app can only open station maps.');
  if (raw.kind !== 'stations') return bad('This map is of a kind this app does not know.');

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

  return {
    ok: true,
    map: {
      format: MAP_FORMAT,
      formatVersion: MAP_FORMAT_VERSION,
      kind: 'stations',
      city,
      name,
      description: str(raw.description, MAX_DESCRIPTION),
      rules,
      stations: read.stations,
    },
  };
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
  return JSON.stringify(
    {
      format: map.format,
      formatVersion: map.formatVersion,
      kind: map.kind,
      city: map.city,
      name: map.name,
      description: map.description,
      rules: map.rules,
      stations: map.stations.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, modes: s.modes, routes: s.routes })),
    },
    null,
    1,
  );
}

/** The board currently on screen, as a map — the starting point for a new one. */
export function mapFromBoard(stations: Station[], rules: MapRules, name: string, city: string): MapFile {
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
