import { toUTM } from './project';
import type { LngLat, PoiLayer } from './types';

/**
 * Pre-projected layer index.
 *
 * The question-quality indicator asks "how far is every station from its
 * nearest feature in this layer" for every layer in the open category. Done
 * naively that re-projects each coordinate once per station, through a
 * string-keyed memo — and `transitLines` has 19,542 vertices, so opening the
 * Matching tab meant roughly 5.4 million cache lookups and froze the UI for
 * 74 seconds.
 *
 * Projecting each layer once into flat Float64Arrays turns the inner loop into
 * pure arithmetic with no allocation, no string keys and no Map lookups.
 */

export type LineGeom = { id: string; name: string; xs: Float64Array; ys: Float64Array };

export type LayerIndex = {
  kind: PoiLayer['kind'];
  ids: string[];
  names: string[];
  /** point layers: parallel arrays of projected coordinates */
  px: Float64Array;
  py: Float64Array;
  /** line layers: one entry per feature */
  lines: LineGeom[];
};

const cache = new Map<string, LayerIndex>();

const idOf = (f: any, i: number): string => (f.properties?.id ?? f.properties?.name ?? String(i)) as string;
const nameOf = (f: any, i: number): string => (f.properties?.name ?? f.properties?.id ?? String(i)) as string;

export function layerIndex(layer: PoiLayer): LayerIndex {
  const hit = cache.get(layer.key);
  if (hit) return hit;

  const ids: string[] = [];
  const names: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const lines: LineGeom[] = [];

  layer.features.forEach((f: any, i) => {
    const g = f.geometry;
    if (!g) return;

    if (g.type === 'Point') {
      const [x, y] = toUTM(g.coordinates as LngLat);
      ids.push(idOf(f, i));
      names.push(nameOf(f, i));
      xs.push(x);
      ys.push(y);
      return;
    }

    const parts: LngLat[][] =
      g.type === 'LineString' ? [g.coordinates as LngLat[]]
      : g.type === 'MultiLineString' ? (g.coordinates as LngLat[][])
      : [];

    for (const part of parts) {
      if (part.length < 2) continue;
      const lx = new Float64Array(part.length);
      const ly = new Float64Array(part.length);
      for (let k = 0; k < part.length; k++) {
        const [x, y] = toUTM(part[k]);
        lx[k] = x;
        ly[k] = y;
      }
      lines.push({ id: idOf(f, i), name: nameOf(f, i), xs: lx, ys: ly });
    }
  });

  const idx: LayerIndex = {
    kind: layer.kind,
    ids,
    names,
    px: Float64Array.from(xs),
    py: Float64Array.from(ys),
    lines,
  };
  cache.set(layer.key, idx);
  return idx;
}

export function clearLayerIndex(): void {
  cache.clear();
}

export type Nearest = { id: string; name: string; distanceM: number };

/** Nearest feature to an already-projected point. */
export function nearestProjected(idx: LayerIndex, x: number, y: number): Nearest | null {
  let bestD = Infinity;
  let bestId = '';
  let bestName = '';

  // Points: measured to the map icon, per the rulebook.
  for (let i = 0; i < idx.px.length; i++) {
    const dx = idx.px[i] - x;
    const dy = idx.py[i] - y;
    const d = dx * dx + dy * dy; // squared; sqrt once at the end
    if (d < bestD) { bestD = d; bestId = idx.ids[i]; bestName = idx.names[i]; }
  }

  // Lines: nearest point on the polyline.
  for (const line of idx.lines) {
    const { xs, ys } = line;
    for (let k = 0; k < xs.length - 1; k++) {
      const d = segDistSq(x, y, xs[k], ys[k], xs[k + 1], ys[k + 1]);
      if (d < bestD) { bestD = d; bestId = line.id; bestName = line.name; }
    }
  }

  if (!Number.isFinite(bestD)) return null;
  return { id: bestId, name: bestName, distanceM: Math.sqrt(bestD) };
}

export function nearestTo(idx: LayerIndex, ll: LngLat): Nearest | null {
  const [x, y] = toUTM(ll);
  return nearestProjected(idx, x, y);
}

/** Squared distance from a point to a segment. Kept branch-light; it runs millions of times. */
function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = px - (ax + t * dx);
  const cy = py - (ay + t * dy);
  return cx * cx + cy * cy;
}
