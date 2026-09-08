/**
 * Every transit stop in San Francisco, straight from GTFS.
 *
 * The main station file (02-stations.ts) is derived from OpenStreetMap and
 * filtered down to a playable board. This one is deliberately unfiltered: it is
 * the transit agencies' own record of every stop they serve, which makes it the
 * ground truth to check that board against.
 *
 * GTFS is better than OSM in two specific ways. `route_type` states the mode
 * outright — 5 really means cable car — where OSM tagging has to be inferred
 * and got Muni Metro confused with Caltrain. And `stop_times` gives the exact
 * set of routes serving each stop, rather than depending on whether a mapper
 * added the stop to a route relation.
 *
 * Sources, in order of preference:
 *
 *   1. FIVE11_KEY=<key>  — the 511 SF Bay regional feed, which covers every
 *      operator in one download (Muni, BART, Caltrain, ferries, and the rest).
 *      Free key: https://511.org/open-data/token
 *   2. pipeline/input/gtfs/*.zip — any GTFS zips you drop in yourself.
 *
 * Output matches stations.geojson exactly, so the two are directly comparable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
import { featureCollection, point } from '@turf/helpers';
import type { Feature, Polygon } from 'geojson';
import { writeOut, readOut, assert, CACHE } from './lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT = join(HERE, 'input', 'gtfs');
const WORK = join(CACHE, 'gtfs');

/** Collapse platforms this close together into one stop. */
const DEDUP_METRES = Number(process.env.GTFS_DEDUP_M ?? 40);

type Mode = 'rail' | 'metro' | 'bus' | 'cablecar' | 'ferry';

/** GTFS route_type. The extended 7xx/9xx values appear in regional feeds. */
function modeOfRouteType(t: number): Mode | null {
  if (t === 0 || (t >= 900 && t <= 906)) return 'metro';   // tram / light rail
  if (t === 1 || (t >= 400 && t <= 405)) return 'metro';   // subway / metro
  if (t === 2 || (t >= 100 && t <= 117)) return 'rail';    // heavy rail
  if (t === 3 || (t >= 700 && t <= 716) || t === 800) return 'bus';
  if (t === 4 || (t >= 1000 && t <= 1021)) return 'ferry';
  if (t === 5 || t === 6 || t === 7) return 'cablecar';    // cable car / aerial / funicular
  return null;
}

console.log('07-stations-gtfs');

const boundary = readOut('boundary.geojson').features[0] as Feature<Polygon>;

// ------------------------------------------------------------- get the feeds

mkdirSync(WORK, { recursive: true });
const zips: string[] = [];

const key = process.env.FIVE11_KEY;
if (key) {
  const dest = join(CACHE, 'gtfs-511-regional.zip');
  if (!existsSync(dest)) {
    console.log('  downloading the 511 regional feed …');
    const url = `https://api.511.org/transit/datafeeds?api_key=${key}&operator_id=RG`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  511 returned HTTP ${res.status}. Check FIVE11_KEY.`);
      process.exit(1);
    }
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } else {
    console.log('  cache hit   511 regional feed');
  }
  zips.push(dest);
}

if (existsSync(INPUT)) {
  for (const f of readdirSync(INPUT)) {
    if (f.toLowerCase().endsWith('.zip')) zips.push(join(INPUT, f));
  }
}

if (zips.length === 0) {
  console.error(`
  No GTFS source found.

  Either:
    FIVE11_KEY=<key> npm run stations-gtfs      (free: https://511.org/open-data/token)
  or drop agency GTFS zips into:
    ${INPUT}
`);
  process.exit(1);
}

// ---------------------------------------------------------------- parse

/** GTFS is CSV with quoted fields; a naive split on commas corrupts names. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, ''));
  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

type Stop = {
  id: string;
  name: string;
  lon: number; lat: number;
  parent: string;
  locationType: string;
  modes: Set<Mode>;
  routes: Set<string>;
};

const stops = new Map<string, Stop>();

for (const zip of zips) {
  const label = zip.split('/').pop()!;
  const dir = join(WORK, label.replace(/\.zip$/i, ''));
  if (!existsSync(join(dir, 'stops.txt'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }

  const read = (f: string) =>
    existsSync(join(dir, f)) ? parseCsv(readFileSync(join(dir, f), 'utf8')) : [];

  const rawStops = read('stops.txt');
  const routes = read('routes.txt');
  const trips = read('trips.txt');
  const stopTimes = read('stop_times.txt');

  // route_id -> { label, mode }
  const routeInfo = new Map<string, { label: string; mode: Mode | null }>();
  for (const r of routes) {
    routeInfo.set(r.route_id, {
      label: r.route_short_name || r.route_long_name || r.route_id,
      mode: modeOfRouteType(Number(r.route_type)),
    });
  }
  // trip_id -> route_id
  const tripRoute = new Map<string, string>();
  for (const t of trips) tripRoute.set(t.trip_id, t.route_id);

  // stop_id -> the routes that actually call there
  const serving = new Map<string, Set<string>>();
  for (const st of stopTimes) {
    const rid = tripRoute.get(st.trip_id);
    if (!rid) continue;
    let set = serving.get(st.stop_id);
    if (!set) serving.set(st.stop_id, (set = new Set()));
    set.add(rid);
  }

  let added = 0;
  for (const s of rawStops) {
    const lon = Number(s.stop_lon);
    const lat = Number(s.stop_lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    // Entrances (2), generic nodes (3) and boarding areas (4) are not stops.
    if (s.location_type && !['0', '1', ''].includes(s.location_type)) continue;
    if (!booleanPointInPolygon(point([lon, lat]), boundary)) continue;

    // Namespace ids so two agencies cannot collide.
    const uid = `${label}:${s.stop_id}`;
    const rec: Stop = stops.get(uid) ?? {
      id: uid,
      name: s.stop_name || s.stop_id,
      lon, lat,
      parent: s.parent_station ? `${label}:${s.parent_station}` : '',
      locationType: s.location_type || '0',
      modes: new Set(),
      routes: new Set(),
    };
    for (const rid of serving.get(s.stop_id) ?? []) {
      const info = routeInfo.get(rid);
      if (!info) continue;
      rec.routes.add(info.label);
      if (info.mode) rec.modes.add(info.mode);
    }
    stops.set(uid, rec);
    added++;
  }

  console.log(`  ${label.padEnd(34)} ${String(added).padStart(5)} stops in SF  ` +
    `(${rawStops.length} total, ${routes.length} routes)`);
}

assert(stops.size > 0, 'no GTFS stops fell inside the San Francisco boundary');

// --------------------------------------------------- roll platforms up

/**
 * GTFS models a station as a parent with child platforms. Keep the parent and
 * fold its children's routes into it, so a multi-platform station is one entry
 * rather than four stacked on the same spot.
 */
const all = [...stops.values()];
const byId = new Map(all.map((s) => [s.id, s]));
let folded = 0;

for (const s of all) {
  if (!s.parent) continue;
  const parent = byId.get(s.parent);
  if (!parent) continue;
  for (const r of s.routes) parent.routes.add(r);
  for (const m of s.modes) parent.modes.add(m);
  stops.delete(s.id);
  folded++;
}
if (folded) console.log(`  folded ${folded} platform(s) into their parent station`);

// Then collapse anything still sitting on top of something else.
const ordered = [...stops.values()].sort((a, b) => b.routes.size - a.routes.size);
const kept: Stop[] = [];
const used = new Set<string>();

for (const s of ordered) {
  if (used.has(s.id)) continue;
  used.add(s.id);
  for (const o of ordered) {
    if (used.has(o.id)) continue;
    if (distance([s.lon, s.lat], [o.lon, o.lat], { units: 'meters' }) > DEDUP_METRES) continue;
    // Only merge stops that are plausibly the same place.
    const sameish = norm(o.name) === norm(s.name) || o.routes.size === 0;
    if (!sameish) continue;
    used.add(o.id);
    for (const r of o.routes) s.routes.add(r);
    for (const m of o.modes) s.modes.add(m);
  }
  kept.push(s);
}

function norm(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, '');
}

console.log(`  ${stops.size} stops -> ${kept.length} after merging co-located platforms`);

// ---------------------------------------------------------------- emit

const slugged = new Map<string, number>();
const features = kept
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((s) => {
    let slug = norm(s.name) || norm(s.id);
    const seen = slugged.get(slug) ?? 0;
    slugged.set(slug, seen + 1);
    if (seen) slug = `${slug}-${seen + 1}`;

    const modes = [...(s.modes.size ? s.modes : new Set<Mode>(['bus']))].sort();
    return point([s.lon, s.lat], {
      id: slug,
      name: s.name,
      modes,
      routes: [...s.routes].sort(),
      nameLength: s.name.length,
      gtfsId: s.id,
    }, { id: slug });
  });

const byMode = new Map<string, number>();
for (const f of features) for (const m of f.properties!.modes as string[]) {
  byMode.set(m, (byMode.get(m) ?? 0) + 1);
}
console.log('  by mode: ' + [...byMode].sort().map(([m, n]) => `${m}=${n}`).join('  '));

const routeless = features.filter((f) => (f.properties!.routes as string[]).length === 0).length;
if (routeless) console.log(`  ${routeless} stop(s) have no route info (no trips serve them in this feed)`);

writeOut('stations_v2.geojson', featureCollection(features));
console.log(`\n  stations_v2.geojson: ${features.length} stops`);
console.log(`  (stations.geojson, the curated OSM board, has ${readOut('stations.geojson').features.length})`);
