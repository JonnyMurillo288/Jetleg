import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { projectionAt, setProjectionCenter, toUTM, utmDefinition } from './project';
import { voronoiCells } from './voronoi';
import type { Boundary } from './types';

const DATA = join(__dirname, '../../public/data');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const boundary = read<FeatureCollection>('boundary.geojson').features[0] as Boundary;
const [w, s, e, n] = read<number[]>('bbox.json');

/**
 * The only honest test of a Voronoi cell: for a point on the ground, is the
 * cell it falls in the cell of its nearest feature? Scored over a grid, the
 * way the 9.2% bug was originally found.
 */
function misclassified(points: Feature<Point>[], cells: FeatureCollection, proj = projectionAt((w + e) / 2, (s + n) / 2), bb = [w, s, e, n], within = boundary) {
  const projected = points.map((p) => proj.toUTM(p.geometry.coordinates as [number, number]));
  let tested = 0;
  let wrong = 0;
  let uncovered = 0;
  const STEPS = 45;
  for (let i = 0; i < STEPS; i++) {
    for (let j = 0; j < STEPS; j++) {
      const ll: [number, number] = [bb[0] + ((bb[2] - bb[0]) * (i + 0.5)) / STEPS, bb[1] + ((bb[3] - bb[1]) * (j + 0.5)) / STEPS];
      if (!booleanPointInPolygon(ll, within)) continue;
      const [x, y] = proj.toUTM(ll);
      const dist = projected.map(([px, py]) => Math.hypot(px - x, py - y)).sort((a, b) => a - b);
      // Within 15 m of a bisector either answer is defensible; skip the knife edge.
      if (dist[1] - dist[0] < 15) continue;
      let best = 0;
      projected.forEach(([px, py], k) => { if (Math.hypot(px - x, py - y) < Math.hypot(projected[best][0] - x, projected[best][1] - y)) best = k; });
      const cell = cells.features.find((c) => booleanPointInPolygon(ll, c as any));
      tested++;
      if (!cell) uncovered++;
      else if (cell.properties?.id !== points[best].properties?.id) wrong++;
    }
  }
  return { tested, wrong, uncovered };
}

describe('projection follows the board', () => {
  it('gives San Francisco the zone the engine has always used', () => {
    expect(utmDefinition(-122.44, 37.76)).toBe('+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs');
  });

  it('gives other cities their own, including south of the equator', () => {
    expect(utmDefinition(-73.98, 40.75)).toContain('+zone=18 ');
    expect(utmDefinition(151.2, -33.87)).toContain('+zone=56 +south');
  });

  it('measures a known distance correctly far from San Francisco', () => {
    // Two points 1 km apart due north in Manhattan, by latitude.
    const a: [number, number] = [-73.98, 40.75];
    const b: [number, number] = [-73.98, 40.75 + 1000 / 111_045];
    const ny = projectionAt(a[0], a[1]);
    const [ax, ay] = ny.toUTM(a);
    const [bx, by] = ny.toUTM(b);
    expect(Math.abs(Math.hypot(bx - ax, by - ay) - 1000)).toBeLessThan(2);
    // The old constant zone, applied there, is what this change prevents.
    const sf = projectionAt(-122.44, 37.76);
    const [cx, cy] = sf.toUTM(a);
    const [dx, dy] = sf.toUTM(b);
    expect(Math.abs(Math.hypot(dx - cx, dy - cy) - 1000)).toBeGreaterThan(50);
  });

  it('re-centres the engine and back', () => {
    const before = toUTM([-122.42, 37.77]);
    expect(setProjectionCenter(-73.98, 40.75)).toBe(true);
    expect(toUTM([-122.42, 37.77])).not.toEqual(before);
    expect(setProjectionCenter(-122.44, 37.76)).toBe(true);
    expect(toUTM([-122.42, 37.77])).toEqual(before);
  });
});

describe('voronoiCells', () => {
  for (const [key, file] of [['libraries', 'poi-libraries.geojson'], ['parks', 'poi-parks.geojson'], ['hospitals', 'poi-hospitals.geojson']] as const) {
    it(`puts every sampled point of the board in its nearest ${key} feature's cell`, () => {
      const points = read<FeatureCollection>(file).features as Feature<Point>[];
      const cells = voronoiCells(key, points, boundary);
      const score = misclassified(points, cells);
      expect(score.tested).toBeGreaterThan(500);
      expect(score.uncovered).toBe(0);
      expect(score.wrong).toBe(0);
    });
  }

  it('agrees with the cells the pipeline shipped', () => {
    const points = read<FeatureCollection>('poi-libraries.geojson').features as Feature<Point>[];
    const shipped = read<FeatureCollection>('voronoi-libraries.geojson');
    const built = voronoiCells('libraries', points, boundary);
    expect(built.features.map((f) => f.properties?.id).sort()).toEqual(shipped.features.map((f) => f.properties?.id).sort());
    expect(misclassified(points, shipped).wrong).toBe(0);
  });

  it('builds correct cells in another city and hemisphere', () => {
    // A 12 km square around central Sydney, with a handful of points.
    const bb = [151.14, -33.93, 151.27, -33.82];
    const square: Boundary = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] } };
    const points = [[151.21, -33.87], [151.18, -33.89], [151.25, -33.85], [151.16, -33.84], [151.23, -33.91], [151.2, -33.83]]
      .map((c, i) => ({ type: 'Feature', properties: { id: `p${i}`, name: `P${i}` }, geometry: { type: 'Point', coordinates: c } })) as Feature<Point>[];
    const proj = projectionAt(151.2, -33.87);
    const cells = voronoiCells('parks', points, square, proj);
    expect(cells.features).toHaveLength(6);
    const score = misclassified(points, cells, proj, bb, square);
    expect(score.tested).toBeGreaterThan(1500);
    expect(score.wrong + score.uncovered).toBe(0);
  });

  it('has nothing to draw for fewer than two points', () => {
    const one = read<FeatureCollection>('poi-zoos.geojson').features.slice(0, 1) as Feature<Point>[];
    expect(voronoiCells('zoos', one, boundary).features).toEqual([]);
  });
});
