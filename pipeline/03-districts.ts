/**
 * SF Board of Supervisors districts (11), from the same trimmed DataSF dataset
 * as the boundary.
 *
 * Two uses in the app:
 *   - a display layer for orientation
 *   - the optional house rule that fills the dead 4th Administrative Division
 *     slot (see the SF rules audit); off by default, since it deviates from the
 *     printed rules and both sides must agree before the round starts.
 *
 * Island fragments are stripped here too, so districts tile the game board
 * exactly. District 6 contains Treasure Island, which is out of play.
 */
import area from '@turf/area';
import simplify from '@turf/simplify';
import { featureCollection, polygon } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { cached, writeOut, assert } from './lib.ts';

const SOURCE = 'https://data.sfgov.org/resource/hcgx-vtsb.geojson?$limit=50';

console.log('03-districts');

const raw = JSON.parse(await cached('districts-trimmed.geojson', SOURCE));
assert(raw.features?.length === 11, `expected 11 districts, got ${raw.features?.length}`);

const out: Feature<Polygon>[] = [];

for (const f of raw.features as Feature<Polygon | MultiPolygon>[]) {
  const num = Number(f.properties?.sup_dist_num);
  assert(num >= 1 && num <= 11, `bad district number ${f.properties?.sup_dist_num}`);

  // Keep only the largest ring per district, discarding island fragments.
  const rings: Feature<Polygon>[] =
    f.geometry.type === 'Polygon'
      ? [f as Feature<Polygon>]
      : (f.geometry as MultiPolygon).coordinates.map((c) => polygon(c));
  const ranked = rings.map((r) => ({ r, km2: area(r) / 1e6 })).sort((a, b) => b.km2 - a.km2);
  if (ranked.length > 1) {
    const dropped = ranked.slice(1).reduce((s, x) => s + x.km2, 0);
    console.log(`  district ${num}: dropped ${ranked.length - 1} island fragment(s), ${dropped.toFixed(2)} km²`);
  }

  const simplified = simplify(ranked[0].r, { tolerance: 1e-5, highQuality: true, mutate: true });
  simplified.properties = {
    id: `sd-${num}`,
    district: num,
    name: `District ${num}`,
    supervisor: f.properties?.sup_name ?? null,
    km2: Number(ranked[0].km2.toFixed(2)),
  };
  out.push(simplified);
}

out.sort((a, b) => (a.properties!.district as number) - (b.properties!.district as number));

const total = out.reduce((s, f) => s + (f.properties!.km2 as number), 0);
console.log(`  11 districts, ${total.toFixed(1)} km² total`);
assert(total > 115 && total < 125, `district areas sum to ${total.toFixed(1)} km², expected ~120`);

writeOut('districts.geojson', featureCollection(out));
