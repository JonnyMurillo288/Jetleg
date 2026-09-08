/**
 * Game boundary: San Francisco mainland only.
 *
 * Source is DataSF "Current Supervisor Districts (trimmed to remove water and
 * other non-populated City territories)" (hcgx-vtsb). The trimmed variant is
 * already clipped to the shoreline, so unioning all 11 districts gives SF's
 * land area without having to intersect a coastline ourselves.
 *
 * That union is a MultiPolygon: the mainland plus Treasure Island / Yerba Buena
 * and any other outlying territory. Per the game design, only the mainland is
 * in play, so we keep the largest ring and discard the rest.
 */
import area from '@turf/area';
import union from '@turf/union';
import simplify from '@turf/simplify';
import { featureCollection, polygon, feature } from '@turf/helpers';
import bbox from '@turf/bbox';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { cached, writeOut, assert } from './lib.ts';

const SOURCE = 'https://data.sfgov.org/resource/hcgx-vtsb.geojson?$limit=50';

console.log('01-boundary');

const raw = JSON.parse(await cached('districts-trimmed.geojson', SOURCE));
assert(raw.features?.length === 11, `expected 11 supervisor districts, got ${raw.features?.length}`);

// Union all districts into the city's land area.
const merged = union(featureCollection(raw.features as Feature<Polygon | MultiPolygon>[]));
assert(merged, 'union of supervisor districts produced nothing');

// Explode to individual rings and rank by area. The mainland dwarfs everything
// else, so "largest" is an unambiguous way to strip the islands.
const rings: Feature<Polygon>[] =
  merged.geometry.type === 'Polygon'
    ? [merged as Feature<Polygon>]
    : (merged.geometry as MultiPolygon).coordinates.map((c) => polygon(c));

const ranked = rings
  .map((r) => ({ ring: r, km2: area(r) / 1e6 }))
  .sort((a, b) => b.km2 - a.km2);

console.log(`  ${ranked.length} landmass(es) in the city boundary:`);
for (const { km2 } of ranked) console.log(`    ${km2.toFixed(2)} km²`);

const mainland = ranked[0];
assert(mainland.km2 > 100 && mainland.km2 < 140, `mainland area ${mainland.km2.toFixed(1)} km² is implausible for SF (~121)`);
assert(
  ranked.length === 1 || ranked[1].km2 < mainland.km2 / 10,
  'second-largest landmass is not clearly smaller than the mainland — the island filter may be wrong',
);
console.log(`  keeping the ${mainland.km2.toFixed(1)} km² mainland; dropping ${ranked.length - 1} island(s)`);

// Light simplification. At 1e-5 degrees (~1 m) this is visually identical but
// meaningfully cheaper to clip shaded regions against on every question.
const boundary = simplify(mainland.ring, { tolerance: 1e-5, highQuality: true, mutate: true });
boundary.properties = { name: 'San Francisco (mainland)', km2: Number(mainland.km2.toFixed(2)) };

writeOut('boundary.geojson', featureCollection([boundary]));
writeOut('bbox.json', bbox(boundary));
console.log(`  bbox: ${bbox(boundary).map((n) => n.toFixed(4)).join(', ')}`);
