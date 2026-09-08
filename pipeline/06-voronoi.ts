/**
 * Voronoi cells for every point layer.
 *
 * A matching question — "is your nearest park the same as mine?" — is really a
 * question about Voronoi cells, so being able to see the cells is the
 * difference between guessing and reading the board.
 *
 * Computed here rather than in the app for two reasons: the cells never change,
 * and doing 278 park cells at runtime on a phone is exactly the kind of work
 * that froze the question list earlier.
 *
 * Cells are built in UTM 10N, not lon/lat. A Voronoi diagram is a metric
 * construct, and at San Francisco's latitude a degree of longitude is 0.79 of a
 * degree of latitude — cells computed in degree space would be visibly wrong,
 * and would disagree with the app's own matching geometry, which is exact in
 * UTM.
 */
import { Delaunay } from 'd3-delaunay';
import proj4 from 'proj4';
import intersect from '@turf/intersect';
import { featureCollection, polygon } from '@turf/helpers';
import type { Feature, Polygon, Position } from 'geojson';
import { writeOut, readOut, assert } from './lib.ts';

const UTM10N = '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs';
const toUTM = (ll: Position) => proj4('EPSG:4326', UTM10N, ll as [number, number]);
const toLL = (xy: [number, number]) => proj4(UTM10N, 'EPSG:4326', xy);

console.log('06-voronoi');

const boundary = readOut('boundary.geojson').features[0] as Feature<Polygon>;

/** Point layers worth a Voronoi diagram. One point has no cells to draw. */
const LAYERS = [
  ['parks', 'poi-parks.geojson'],
  ['libraries', 'poi-libraries.geojson'],
  ['museums', 'poi-museums.geojson'],
  ['hospitals', 'poi-hospitals.geojson'],
  ['movieTheaters', 'poi-movie-theaters.geojson'],
  ['consulates', 'poi-consulates.geojson'],
  ['golfCourses', 'poi-golf-courses.geojson'],
  ['aquariums', 'poi-aquariums.geojson'],
  ['mountains', 'poi-mountains.geojson'],
  ['water', 'poi-water.geojson'],
  ['railStations', 'rail-stations.geojson'],
] as const;

// A margin well past the city, so edge cells are closed before clipping.
const PAD = 40_000;

for (const [key, file] of LAYERS) {
  let src;
  try {
    src = readOut(file);
  } catch {
    console.warn(`  ! ${key}: ${file} missing, skipped`);
    continue;
  }

  const feats = (src.features ?? []).filter((f: any) => f.geometry?.type === 'Point');
  if (feats.length < 2) {
    console.log(`  ${key.padEnd(15)} ${feats.length} point(s) — no cells to draw, skipped`);
    continue;
  }

  const projected = feats.map((f: any) => toUTM(f.geometry.coordinates) as [number, number]);
  const xs = projected.map((p) => p[0]);
  const ys = projected.map((p) => p[1]);
  const bounds: [number, number, number, number] = [
    Math.min(...xs) - PAD, Math.min(...ys) - PAD,
    Math.max(...xs) + PAD, Math.max(...ys) + PAD,
  ];

  const voronoi = Delaunay.from(projected).voronoi(bounds);

  const cells: Feature<Polygon>[] = [];
  let clippedAway = 0;

  for (let i = 0; i < feats.length; i++) {
    const cell = voronoi.cellPolygon(i);
    if (!cell) continue;

    const ring = cell.map((xy) => toLL(xy as [number, number]) as Position);
    // d3 closes its polygons; make sure the ring is explicitly closed.
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

    const props = feats[i].properties ?? {};
    const cellFeature = polygon([ring], {
      id: props.id ?? String(i),
      name: props.name ?? props.id ?? String(i),
      layer: key,
    });

    // Only the part on the board is in play.
    let clipped: any = null;
    try {
      clipped = intersect(featureCollection([cellFeature, boundary]) as any);
    } catch {
      clipped = null;
    }
    if (!clipped) { clippedAway++; continue; }

    clipped.properties = cellFeature.properties;
    clipped.id = cellFeature.properties!.id;
    cells.push(clipped);
  }

  assert(cells.length > 0, `${key}: every Voronoi cell fell outside the boundary`);
  console.log(
    `  ${key.padEnd(15)} ${String(feats.length).padStart(4)} points -> ` +
    `${String(cells.length).padStart(4)} cells on the board` +
    (clippedAway ? ` (${clippedAway} entirely offshore)` : ''),
  );

  writeOut(`voronoi-${key}.geojson`, featureCollection(cells));
}
