import { Delaunay } from 'd3-delaunay';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import intersect from '@turf/intersect';
import { featureCollection, polygon } from '@turf/helpers';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { currentProjection, type Projection } from './project';
import type { Boundary } from './types';

/**
 * Voronoi cells for one point layer, clipped to the board.
 *
 * This is pipeline/06-voronoi.ts, moved to where a browser can run it: the
 * map studio builds a city's cells the same way the pipeline built San
 * Francisco's. Same construction — a Delaunay triangulation in the board's
 * UTM zone, cells closed by a margin well past the city, then cut to the
 * boundary — with one difference.
 *
 * A cell edge is straight in UTM, which makes it a curve in lon/lat, and turf
 * reads a polygon edge as straight in degree space. The pipeline unprojected
 * only the corners; here every edge is walked in steps of at most a kilometre
 * before unprojecting, so a long outer edge does not bow away from the true
 * bisector. (regions.ts has the measured cost of skipping this: 9.2% of the
 * ground on the wrong side of a matching answer.)
 */

// A margin well past the city, so edge cells are closed before clipping.
const PAD_M = 40_000;
const MAX_EDGE_M = 1_000;

export type CellFeature = Feature<Polygon | MultiPolygon, { id: string; name: string; layer: string }>;

function ringToLngLat(cell: ArrayLike<[number, number]>, proj: Projection): Position[] {
  const ring: Position[] = [];
  const n = cell.length - 1; // d3 repeats the first vertex at the end
  for (let i = 0; i < n; i++) {
    const a = cell[i];
    const b = cell[i + 1];
    const steps = Math.min(64, Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / MAX_EDGE_M)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      ring.push(proj.toLngLat([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
    }
  }
  ring.push(ring[0]);
  return ring;
}

/** Every edge of the boundary, projected once, with its bounding box. */
type Edges = { ax: Float64Array; ay: Float64Array; bx: Float64Array; by: Float64Array };

function projectEdges(boundary: Boundary, proj: Projection): Edges {
  const g = boundary.geometry;
  const rings: Position[][] = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  const n = rings.reduce((sum, r) => sum + Math.max(0, r.length - 1), 0);
  const e: Edges = { ax: new Float64Array(n), ay: new Float64Array(n), bx: new Float64Array(n), by: new Float64Array(n) };
  let k = 0;
  for (const ring of rings) {
    let prev = proj.toUTM(ring[0] as [number, number]);
    for (let i = 1; i < ring.length; i++) {
      const next = proj.toUTM(ring[i] as [number, number]);
      e.ax[k] = prev[0]; e.ay[k] = prev[1]; e.bx[k] = next[0]; e.by[k] = next[1];
      k++;
      prev = next;
    }
  }
  return e;
}

const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/**
 * Does any part of the boundary's outline pass through this cell?
 *
 * Cutting a cell to the boundary is by far the slow step — a real polygon
 * intersection against a few thousand boundary vertices, once per cell,
 * which for San Francisco's 278 parks alone was fifteen seconds. But most
 * cells of a city are nowhere near its edge, and for those there is nothing
 * to cut: the cell is already the answer. A Voronoi cell is convex, so "does
 * the outline touch it" is exact and cheap in the plane it was built in.
 */
function outlineTouches(cell: ArrayLike<[number, number]>, edges: Edges): boolean {
  const n = cell.length - 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = cell[i];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Orientation of the (convex) cell, so "inside" has one sign.
  let area2 = 0;
  for (let i = 0; i < n; i++) area2 += cell[i][0] * cell[i + 1][1] - cell[i + 1][0] * cell[i][1];
  const sign = area2 >= 0 ? 1 : -1;
  const inside = (x: number, y: number) => {
    for (let i = 0; i < n; i++) {
      if (sign * cross(cell[i][0], cell[i][1], cell[i + 1][0], cell[i + 1][1], x, y) < 0) return false;
    }
    return true;
  };

  for (let k = 0; k < edges.ax.length; k++) {
    const ax = edges.ax[k], ay = edges.ay[k], bx = edges.bx[k], by = edges.by[k];
    if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX) || (ay < minY && by < minY) || (ay > maxY && by > maxY)) continue;
    if (inside(ax, ay) || inside(bx, by)) return true;
    // Neither end is inside: the edge touches the cell only if it crosses one of its sides.
    for (let i = 0; i < n; i++) {
      const cx = cell[i][0], cy = cell[i][1], dx = cell[i + 1][0], dy = cell[i + 1][1];
      const d1 = cross(ax, ay, bx, by, cx, cy);
      const d2 = cross(ax, ay, bx, by, dx, dy);
      const d3 = cross(cx, cy, dx, dy, ax, ay);
      const d4 = cross(cx, cy, dx, dy, bx, by);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      if (d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) return true; // touching counts: take the slow, exact path
    }
  }
  return false;
}

/**
 * Fewer than two points have no cells to draw: one point's "cell" is the
 * whole board, which is what an always-yes matching question means.
 */
export function voronoiCells(
  layer: string,
  points: Feature<Point>[],
  boundary: Boundary,
  proj: Projection = currentProjection(),
): FeatureCollection<Polygon | MultiPolygon> {
  const feats = points.filter((f) => f.geometry?.type === 'Point');
  if (feats.length < 2) return featureCollection([]);

  const projected = feats.map((f) => proj.toUTM(f.geometry.coordinates as [number, number]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of projected) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const voronoi = Delaunay.from(projected).voronoi([minX - PAD_M, minY - PAD_M, maxX + PAD_M, maxY + PAD_M]);

  const edges = projectEdges(boundary, proj);
  const cells: CellFeature[] = [];
  for (let i = 0; i < feats.length; i++) {
    // Two points on the same spot share one cell; d3 gives the later one none.
    const cell = voronoi.cellPolygon(i);
    if (!cell) continue;

    const props = (feats[i].properties ?? {}) as Record<string, unknown>;
    const id = String(props.id ?? props.name ?? i);
    const properties = { id, name: String(props.name ?? props.id ?? i), layer };

    const ring = ringToLngLat(cell, proj);

    // The outline never touches this cell, so it lies wholly on one side of
    // it: on the board (keep it as it is) or off it (nothing to keep).
    if (!outlineTouches(cell, edges)) {
      if (booleanPointInPolygon(ring[0], boundary)) cells.push({ type: 'Feature', id, properties, geometry: { type: 'Polygon', coordinates: [ring] } });
      continue;
    }

    // Only the part on the board is in play.
    let clipped: Feature<Polygon | MultiPolygon> | null = null;
    try {
      clipped = intersect(featureCollection([polygon([ring]), boundary as Feature<Polygon | MultiPolygon>]));
    } catch {
      clipped = null;
    }
    if (!clipped) continue;
    cells.push({ type: 'Feature', id, properties, geometry: clipped.geometry });
  }
  return featureCollection(cells);
}
