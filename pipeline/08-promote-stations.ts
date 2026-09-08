/**
 * Promote a hand-built station set to production.
 *
 * Takes app/public/data/stations_versions/stations_<v>.geojson — buffers drawn
 * in QGIS against GTFS stops — and emits the three files the app actually
 * reads, in exactly the shape the OSM-derived pipeline produced:
 *
 *   stations.json     the engine's source of truth (id, name, lon, lat, modes, routes)
 *   zones.geojson     the hiding-zone circles the map draws
 *   stations.geojson  station points, kept in step for reference
 *
 * Two things are deliberately NOT taken from the input file.
 *
 * The station point is the matched GTFS stop (`stop_lon`/`stop_lat`), not the
 * buffer centre. The two sit a median of 16 m apart, and the GTFS coordinate is
 * the agency's own record of where the stop is.
 *
 * The zones are rebuilt as true 500 m geodesic circles rather than reusing the
 * input polygons. Those were buffered in degree space, which on the ground is
 * an ellipse roughly 405 m north-south by 320 m east-west — and, more
 * importantly, the elimination engine computes every zone as a 500 m circle
 * from the station point (ZONE_RADIUS_M). Shipping different geometry for
 * drawing than for deciding would make the map disagree with the zone count.
 *
 *   npm run promote            # promotes stations_v2.geojson
 *   VERSION=v3 npm run promote
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import circle from '@turf/circle';
import distance from '@turf/distance';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { featureCollection, point } from '@turf/helpers';
import type { Feature, Polygon } from 'geojson';
import { writeOut, readOut, assert, expectRange, OUT } from './lib.ts';

const VERSION = process.env.VERSION ?? 'v2';
const ZONE_RADIUS_M = 500;   // must match ZONE_RADIUS_M in app/src/engine/candidates.ts
const RECOVER_WITHIN_M = 150;

type Mode = 'rail' | 'metro' | 'bus' | 'cablecar' | 'ferry';

console.log(`08-promote-stations  (${VERSION})`);

const src = join(OUT, 'stations_versions', `stations_${VERSION}.geojson`);
assert(existsSync(src), `no such file: ${src}`);
const input = JSON.parse(readFileSync(src, 'utf8'));
assert(input.features?.length, `${src} has no features`);
console.log(`  ${input.features.length} features in stations_${VERSION}.geojson`);

const boundary = readOut('boundary.geojson').features[0] as Feature<Polygon>;

/**
 * The previous production set, used only to recover `modes` and `routes` —
 * the QGIS export leaves both empty. Without them the hider's zone card is
 * blank and the Rail Station question goes null, because rail-stations.geojson
 * is filtered on mode.
 */
const prevPath = join(OUT, 'stations_versions', 'old_prod', 'stations.json');
const previous: any[] = existsSync(prevPath)
  ? JSON.parse(readFileSync(prevPath, 'utf8')).stations
  : [];
console.log(`  ${previous.length} stations in the previous set, for mode/route recovery`);

const norm = (s: string) =>
  s.toLowerCase()
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|road|rd|station|stn)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

let outside = 0;
let recovered = 0;
const slugged = new Map<string, number>();

const stations = input.features.map((f: any, i: number) => {
  const p = f.properties ?? {};
  const lon = Number(p.stop_lon ?? p.feature_x);
  const lat = Number(p.stop_lat ?? p.feature_y);
  assert(Number.isFinite(lon) && Number.isFinite(lat), `feature ${i} has no usable coordinate`);

  const name: string = String(p.name ?? `Stop ${i}`).trim();
  if (!booleanPointInPolygon(point([lon, lat]), boundary)) outside++;

  // Recover mode and route info from the nearest previous station.
  let modes: Mode[] = [];
  let routes: string[] = [];
  let best: { d: number; s: any } | null = null;
  for (const s of previous) {
    const d = distance([lon, lat], [s.lon, s.lat], { units: 'meters' });
    if (d <= RECOVER_WITHIN_M && (!best || d < best.d)) best = { d, s };
  }
  if (best) {
    modes = best.s.modes ?? [];
    routes = best.s.routes ?? [];
    recovered++;
  }
  if (modes.length === 0) modes = ['bus'];

  // Stable, unique slug — the input's `id` column is empty for every row.
  let id = norm(name) || `stop${i}`;
  const seen = slugged.get(id) ?? 0;
  slugged.set(id, seen + 1);
  if (seen) id = `${id}-${seen + 1}`;

  return { id, name, lon, lat, modes, routes, nameLength: name.length };
});

console.log(`  ${recovered}/${stations.length} recovered modes+routes from the previous set`);
if (outside) console.warn(`  ! ${outside} station(s) fall outside the game boundary`);

// No two zones should sit on top of each other.
let tooClose = 0;
for (let i = 0; i < stations.length; i++) {
  for (let j = i + 1; j < stations.length; j++) {
    if (distance([stations[i].lon, stations[i].lat], [stations[j].lon, stations[j].lat], { units: 'meters' }) < 50) tooClose++;
  }
}
if (tooClose) console.warn(`  ! ${tooClose} station pair(s) closer than 50 m`);

const byMode = new Map<string, number>();
for (const s of stations) for (const m of s.modes) byMode.set(m, (byMode.get(m) ?? 0) + 1);
console.log('  by mode: ' + [...byMode].sort().map(([m, n]) => `${m}=${n}`).join('  '));

expectRange('stations', stations.length, 100, 500);
assert(new Set(stations.map((s: any) => s.id)).size === stations.length, 'station ids are not unique');

writeOut('stations.json', {
  generated: new Date().toISOString(),
  source: `stations_${VERSION}.geojson`,
  zoneRadiusM: ZONE_RADIUS_M,
  count: stations.length,
  stations,
});

writeOut('stations.geojson', featureCollection(
  stations.map((s: any) => point([s.lon, s.lat], {
    id: s.id, name: s.name, modes: s.modes, routes: s.routes, nameLength: s.nameLength,
  }, { id: s.id })),
));

writeOut('zones.geojson', featureCollection(
  stations.map((s: any) => ({
    type: 'Feature' as const,
    id: s.id,
    properties: { id: s.id, name: s.name, modes: s.modes },
    geometry: circle([s.lon, s.lat], ZONE_RADIUS_M, { steps: 64, units: 'meters' }).geometry,
  })),
));

console.log(`\n  promoted ${stations.length} stations to production`);
