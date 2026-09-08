/**
 * Line layers: coastline, transit lines, and the county boundary.
 *
 * These are measured to the nearest point on the line, not to an icon — the
 * rulebook's "closer to or further from a coastline" is a distance to the line
 * itself.
 */
import lineIntersect from '@turf/line-intersect';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { featureCollection, lineString, point } from '@turf/helpers';
import type { Feature, LineString, Polygon, Position } from 'geojson';
import { overpass, writeOut, readOut, assert } from './lib.ts';

console.log('05-linear');

const boundary = readOut('boundary.geojson').features[0] as Feature<Polygon>;
const [w, s, e, n] = readOut<number[]>('bbox.json');
const BB = `${s},${w},${n},${e}`;

// ------------------------------------------------------------- coastline
/**
 * The rulebook's coastline rule: land meeting the ocean, a great lake, or a
 * waterway flowing into one that is never less than 2 km across. In SF that is
 * the Pacific and the Bay — both far wider than 2 km — so every OSM coastline
 * way inside the boundary qualifies. Narrow channels would need filtering in a
 * city with them; SF has none on the mainland.
 *
 * The city's own boundary ring IS its shoreline (the DataSF trimmed districts
 * are clipped to water), so the boundary doubles as the coastline. That is more
 * reliable than stitching OSM coastline ways, which run continuously up the
 * whole California coast and would need clipping anyway.
 */
const coastRing = (boundary.geometry.coordinates[0] as Position[]);
writeOut('coastline.geojson', featureCollection([
  lineString(coastRing, { id: 'sf-shoreline', name: 'San Francisco shoreline' }),
]));
console.log(`  coastline       ${coastRing.length} vertices (the city shoreline)`);

// ------------------------------------------------------ county line (land)
/**
 * 2nd Administrative Division Border. San Francisco's county line is almost
 * entirely in water; only the southern edge — against San Mateo County — is on
 * land and reachable. Extract just that portion: boundary vertices that are not
 * on the shoreline, which here means the southern land border.
 *
 * Approximated as the southernmost span of the ring, which for SF is exactly
 * the San Mateo line.
 */
const minLat = Math.min(...coastRing.map((c) => c[1]));
const landBorder = coastRing.filter((c) => c[1] < minLat + 0.004);
if (landBorder.length >= 2) {
  writeOut('county-line.geojson', featureCollection([
    lineString(landBorder, { id: 'sf-sanmateo', name: 'San Francisco / San Mateo county line' }),
  ]));
  console.log(`  county-line     ${landBorder.length} vertices (San Mateo land border)`);
} else {
  writeOut('county-line.geojson', featureCollection([]));
  console.warn('  ! could not isolate a land county border');
}

// ----------------------------------------------------------- transit lines
const routesRaw = await overpass(
  'osm-route-geom',
  `[out:json][timeout:300];
   relation["type"="route"]["route"~"^(subway|light_rail|tram|train|ferry)$"](${BB});
   out geom;`,
);

const lines: Feature<LineString>[] = [];
const seenRefs = new Set<string>();

for (const rel of routesRaw.elements ?? []) {
  const t = rel.tags ?? {};
  const ref = t.ref ?? t.name;
  if (!ref) continue;
  // One geometry per line, not per direction.
  if (seenRefs.has(ref)) continue;

  const coords: Position[] = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    for (const g of m.geometry) coords.push([g.lon, g.lat]);
  }
  if (coords.length < 2) continue;

  // Keep only lines that actually touch the board.
  const inside = coords.filter((c) => booleanPointInPolygon(point(c), boundary));
  if (inside.length < 2) continue;

  seenRefs.add(ref);
  lines.push(lineString(coords, { id: `line-${ref}`, name: t.name ?? ref, ref, mode: t.route }));
}

console.log(`  transit-lines   ${lines.length} distinct lines: ${[...seenRefs].sort().join(' ')}`);
assert(lines.length > 3, 'transit line extraction found almost nothing');
writeOut('transit-lines.geojson', featureCollection(lines));
