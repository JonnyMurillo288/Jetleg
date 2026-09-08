/**
 * POI layers, from OpenStreetMap via Overpass.
 *
 * Everything is emitted as a POINT, because the rulebook measures to the map
 * icon rather than to the nearest edge of a feature. It says so explicitly, and
 * acknowledges the oddity: you can be standing inside Golden Gate Park and
 * still be nearest to a smaller park's icon. That is the objective rule, and
 * the engine matches it.
 *
 * Ways and relations get Overpass's `out center`, which is the bbox centre.
 *
 * The rulebook's legitimacy test — "5 or more Google Reviews" — is not
 * available offline, so the frozen file IS the ruling. If you disagree with an
 * entry, edit the GeoJSON before the game starts, not during it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { featureCollection, point } from '@turf/helpers';
import type { Feature, Polygon } from 'geojson';
import { overpass, writeOut, readOut, assert, expectRange } from './lib.ts';

console.log('04-pois');

/**
 * Manual corrections to OSM categorization. The rulebook resolves these with
 * the "5 or more Google Reviews" test or by player agreement; neither is
 * available offline, so overrides.json is where that ruling is recorded.
 */
const OVERRIDES: Record<string, { exclude?: string[] }> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'overrides.json'), 'utf8'),
);

const boundary = readOut('boundary.geojson').features[0] as Feature<Polygon>;
const [w, s, e, n] = readOut<number[]>('bbox.json');
const BB = `${s},${w},${n},${e}`;

type Def = {
  key: string;
  file: string;
  selector: string;
  /** Expected count range in SF; a miss means the query or the data changed. */
  expect: [number, number];
  requireName?: boolean;
  /** Genuinely absent in SF; an empty layer is the correct answer, not a bug. */
  allowEmpty?: boolean;
  reject?: (tags: Record<string, string>) => boolean;
};

const DEFS: Def[] = [
  { key: 'parks', file: 'poi-parks.geojson', selector: '["leisure"="park"]', expect: [100, 400] },
  { key: 'libraries', file: 'poi-libraries.geojson', selector: '["amenity"="library"]', expect: [20, 60] },
  { key: 'museums', file: 'poi-museums.geojson', selector: '["tourism"="museum"]', expect: [15, 80] },
  { key: 'hospitals', file: 'poi-hospitals.geojson', selector: '["amenity"="hospital"]', expect: [5, 40] },
  { key: 'movieTheaters', file: 'poi-movie-theaters.geojson', selector: '["amenity"="cinema"]', expect: [5, 40] },
  {
    key: 'consulates', file: 'poi-consulates.geojson', selector: '["office"="diplomatic"]', expect: [20, 120],
    // The rulebook excludes honorary consulates.
    reject: (t) => t.diplomatic === 'honorary_consulate' || t.consulate === 'honorary',
  },
  {
    key: 'golfCourses', file: 'poi-golf-courses.geojson', selector: '["leisure"="golf_course"]', expect: [2, 15],
    // Outdoor courses only; mini-golf and driving ranges do not count.
    reject: (t) => t.golf === 'miniature' || t.leisure === 'miniature_golf' || t.golf === 'driving_range',
  },
  { key: 'aquariums', file: 'poi-aquariums.geojson', selector: '["tourism"="aquarium"]', expect: [0, 6] },
  { key: 'zoos', file: 'poi-zoos.geojson', selector: '["tourism"="zoo"]', expect: [0, 4] },
  { key: 'amusementParks', file: 'poi-amusement-parks.geojson', selector: '["tourism"="theme_park"]', expect: [0, 4], allowEmpty: true },
  { key: 'mountains', file: 'poi-mountains.geojson', selector: '["natural"="peak"]', expect: [2, 60] },
  {
    key: 'water', file: 'poi-water.geojson', selector: '["natural"="water"]', expect: [3, 60],
    // "Any named body of water, excluding pools."
    reject: (t) => t.water === 'pool' || t.leisure === 'swimming_pool' || t.water === 'reflecting_pool',
  },
];

const summary: { key: string; count: number }[] = [];

for (const def of DEFS) {
  const raw = await overpass(
    `osm-${def.key}`,
    `[out:json][timeout:180];
     ( nwr${def.selector}(${BB}); );
     out center tags;`,
  );

  const excluded = new Set(OVERRIDES[def.key]?.exclude ?? []);
  const seen = new Set<string>();
  const feats = [];
  let noName = 0;
  let outside = 0;
  let rejected = 0;
  let overridden = 0;

  for (const el of raw.elements) {
    const tags: Record<string, string> = el.tags ?? {};
    // Nodes carry lat/lon; ways and relations carry `center`.
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon === undefined || lat === undefined) continue;

    if (def.reject?.(tags)) { rejected++; continue; }

    const name = tags.name ?? tags['name:en'];
    if (!name) { noName++; continue; }
    if (excluded.has(name)) { overridden++; continue; }

    if (!booleanPointInPolygon(point([lon, lat]), boundary)) { outside++; continue; }

    // OSM often carries both a node and an enclosing way for one place.
    const dedupKey = `${name.toLowerCase()}|${lon.toFixed(3)}|${lat.toFixed(3)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    feats.push(point([lon, lat], { id: `${def.key}-${el.id}`, name }, { id: `${def.key}-${el.id}` }));
  }

  console.log(
    `  ${def.key.padEnd(15)} ${String(feats.length).padStart(4)}  ` +
    `(dropped ${noName} unnamed, ${outside} out of bounds, ${rejected} rejected, ${overridden} overridden)`,
  );
  expectRange(`  ${def.key}`, feats.length, def.expect[0], def.expect[1]);

  writeOut(def.file, featureCollection(feats));
  summary.push({ key: def.key, count: feats.length });
}

// Rail stations for the measuring question come from the station file, which is
// already deduplicated and boundary-clipped.
const stations = readOut<{ stations: any[] }>('stations.json').stations;
const rail = stations.filter((st) => st.modes.some((m: string) => m !== 'bus'));
writeOut('rail-stations.geojson', featureCollection(
  rail.map((st) => point([st.lon, st.lat], { id: st.id, name: st.name }, { id: st.id })),
));
console.log(`  rail-stations   ${String(rail.length).padStart(4)}`);

assert(summary.find((x) => x.key === 'parks')!.count > 50, 'parks layer is suspiciously empty');
assert(summary.find((x) => x.key === 'libraries')!.count > 10, 'libraries layer is suspiciously empty');

// ---------------------------------------------------------------- SF audit
console.log('\n  San Francisco question audit:');
for (const { key, count } of summary) {
  if (count === 0) console.log(`    ${key}: NULL — no such feature on the board`);
  else if (count === 1) console.log(`    ${key}: always-yes for matching — only one on the board`);
}
