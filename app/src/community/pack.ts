import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import simplify from '@turf/simplify';
import turfBbox from '@turf/bbox';
import type { Feature, MultiPolygon, Point, Polygon, Position } from 'geojson';
import type { GameData } from '../data/load';
import { LAYER_DEFS, VORONOI_KEYS } from '../data/layers';
import { projectionAt } from '../engine/project';
import { voronoiCells } from '../engine/voronoi';
import type { Boundary } from '../engine/types';
import {
  MAP_FORMAT,
  MAP_FORMAT_VERSION,
  MAX_PACK_BYTES,
  serializeMap,
  type CellFeature,
  type LayerFeature,
  type MapRules,
  type MapStation,
  type PackMap,
} from './format';

/**
 * The pipeline's own steps, as functions a browser can run on any city.
 *
 *   01-boundary   largestLandmass, simplifyBoundary
 *   04-pois       clipToBoundary (the fetch itself is in osm.ts)
 *   06-voronoi    finalizePack -> voronoiCells
 *   audits        auditPack
 *
 * Nothing here touches the network or the page; osm.ts fetches, the studio
 * draws, and this decides.
 */

export const boundaryFeature = (polygon: Polygon): Boundary => ({ type: 'Feature', properties: {}, geometry: polygon });
export const centerOf = (polygon: Polygon): [number, number] => {
  const [w, s, e, n] = turfBbox(polygon);
  return [(w + e) / 2, (s + n) / 2];
};

/**
 * A city's outline usually arrives as several pieces — the mainland plus
 * islands, piers, an exclave. The game is played on one connected piece, so
 * keep the largest and say what was dropped. (Step 01 did exactly this to
 * strip Treasure Island from San Francisco.)
 */
export function largestLandmass(geometry: Polygon | MultiPolygon): { polygon: Polygon; dropped: number; km2: number } {
  const parts: Position[][][] = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const ranked = parts
    .map((coordinates) => ({ coordinates, m2: area({ type: 'Polygon', coordinates }) }))
    .sort((a, b) => b.m2 - a.m2);
  return {
    polygon: { type: 'Polygon', coordinates: ranked[0].coordinates },
    dropped: ranked.length - 1,
    km2: ranked[0].m2 / 1e6,
  };
}

/** Thin a boundary to roughly `toleranceM` metres. Cheaper to clip against on every question. */
export function simplifyBoundary(polygon: Polygon, toleranceM: number): Polygon {
  const out = simplify(boundaryFeature(polygon), { tolerance: toleranceM / 111_000, highQuality: true, mutate: false });
  const g = out.geometry as Polygon;
  // Simplifying must never collapse the outline into nothing.
  return g.coordinates[0]?.length >= 4 ? g : polygon;
}

export function boundaryStats(polygon: Polygon): { km2: number; vertices: number } {
  return { km2: area(polygon) / 1e6, vertices: polygon.coordinates.reduce((n, r) => n + r.length, 0) };
}

/** A boundary drawn by tapping: at least three corners, closed for you. */
export function polygonFromTaps(points: [number, number][]): Polygon | null {
  if (points.length < 3) return null;
  return { type: 'Polygon', coordinates: [[...points, points[0]]] };
}

/** Points must be on the board; a line counts if any of it is. */
export function clipToBoundary(features: LayerFeature[], polygon: Polygon): { kept: LayerFeature[]; outside: number } {
  const boundary = boundaryFeature(polygon);
  const inside = (c: Position) => booleanPointInPolygon(c, boundary);
  const kept = features.filter((f) => {
    const g = f.geometry;
    if (g.type === 'Point') return inside(g.coordinates);
    const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    return lines.some((l) => l.some(inside));
  });
  return { kept, outside: features.length - kept.length };
}

/** The boundary's own outline, as the coastline layer — right for a peninsula or an island, as it was for SF. */
export function coastlineFromBoundary(polygon: Polygon): LayerFeature[] {
  return [{
    type: 'Feature',
    id: 'coastline-boundary',
    properties: { id: 'coastline-boundary', name: 'Coastline' },
    geometry: { type: 'LineString', coordinates: polygon.coordinates[0] },
  }];
}

export function newPack(name: string, city: string, boundary: Polygon, rules: MapRules = {}): PackMap {
  return {
    format: MAP_FORMAT,
    formatVersion: MAP_FORMAT_VERSION,
    kind: 'pack',
    city,
    name,
    description: '',
    rules,
    stations: [],
    boundary,
    layers: {},
    voronoi: {},
    customVoronoi: [],
  };
}

/** A loaded board as a pack — the shipped San Francisco board, opened up to be changed. */
export function packFromBoard(data: GameData, name: string, city: string, rules: MapRules): PackMap {
  const g = data.boundary.geometry;
  const pack = newPack(name, city, g.type === 'Polygon' ? g : largestLandmass(g).polygon, rules);
  pack.stations = data.stations.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, modes: s.modes, routes: s.routes }));
  for (const def of LAYER_DEFS) {
    const feats = data.layers[def.key]?.features ?? [];
    if (!feats.length) continue;
    pack.layers[def.key] = feats.map((f, i) => {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const id = String(p.id ?? p.name ?? `${def.key}-${i}`);
      return { type: 'Feature', id, properties: { id, name: String(p.name ?? id) }, geometry: f.geometry } as LayerFeature;
    });
  }
  for (const key of VORONOI_KEYS) {
    const cells = data.voronoi[key]?.features ?? [];
    if (cells.length) pack.voronoi[key] = cells as CellFeature[];
  }
  return pack;
}

const isBusOnly = (s: MapStation) => s.modes.every((m) => m === 'bus');

/**
 * "Rail stations" is a layer the questions ask about, and on the shipped
 * board it is simply the stations that are not bus-only (step 04). It is
 * derived the same way here — unless the author has put their own features
 * in it, which is recognised by ids that are not station ids.
 */
function railLayer(pack: PackMap): LayerFeature[] | null {
  const existing = pack.layers.railStations ?? [];
  const stationIds = new Set(pack.stations.map((s) => s.id));
  if (existing.some((f) => !stationIds.has(f.properties.id))) return null; // hand-made: leave it
  return pack.stations.filter((s) => !isBusOnly(s)).map((s) => ({
    type: 'Feature',
    id: s.id,
    properties: { id: s.id, name: s.name },
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
  }));
}

/**
 * Make a pack consistent with itself, the way running the whole pipeline did:
 * the derived rail-station layer follows the stations, and every layer's
 * Voronoi cells are rebuilt from its points and cut to the boundary.
 *
 * Cells the author supplied by hand (`customVoronoi`) are left alone, and
 * reported if they name a point the layer does not have.
 */
export function finalizePack(draft: PackMap): { pack: PackMap; notes: string[] } {
  const notes: string[] = [];
  const layers = { ...draft.layers };
  const rail = railLayer(draft);
  if (rail) {
    if (rail.length) layers.railStations = rail;
    else delete layers.railStations;
  }

  const boundary = boundaryFeature(draft.boundary);
  const [lon, lat] = centerOf(draft.boundary);
  const proj = projectionAt(lon, lat);
  const voronoi: Record<string, CellFeature[]> = {};
  const custom = draft.customVoronoi.filter((k) => draft.voronoi[k]?.length);

  for (const key of VORONOI_KEYS) {
    const points = (layers[key] ?? []).filter((f): f is Feature<Point, LayerFeature['properties']> => f.geometry.type === 'Point');
    if (custom.includes(key)) {
      const ids = new Set(points.map((p) => p.properties.id));
      const strays = draft.voronoi[key].filter((c) => !ids.has(c.properties.id));
      if (strays.length) {
        notes.push(`${key}: ${strays.length} hand-made cell${strays.length === 1 ? '' : 's'} match no point in the layer (e.g. “${strays[0].properties.id}”).`);
      }
      const missing = points.filter((p) => !draft.voronoi[key].some((c) => c.properties.id === p.properties.id));
      if (missing.length) {
        notes.push(`${key}: ${missing.length} point${missing.length === 1 ? ' has' : 's have'} no hand-made cell (e.g. “${missing[0].properties.name}”).`);
      }
      voronoi[key] = draft.voronoi[key];
      continue;
    }
    const cells = voronoiCells(key, points, boundary, proj).features as CellFeature[];
    if (cells.length) voronoi[key] = cells;
  }

  return { pack: { ...draft, layers, voronoi, customVoronoi: custom }, notes };
}

export type LayerAudit = {
  key: string;
  label: string;
  kind: 'point' | 'line';
  count: number;
  outside: number;
  cells: number;
  customCells: boolean;
  /** What this count means for the questions, in the pipeline audit's words. */
  verdict: string;
};

/** The pipeline's closing audit: what each layer's count does to the questions about it. */
export function auditPack(pack: PackMap): { layers: LayerAudit[]; bytes: number; tooBig: boolean } {
  const layers = LAYER_DEFS.map((def): LayerAudit => {
    const feats = pack.layers[def.key] ?? [];
    const count = feats.length;
    return {
      key: def.key,
      label: def.label,
      kind: def.kind,
      count,
      outside: count - clipToBoundary(feats, pack.boundary).kept.length,
      cells: pack.voronoi[def.key]?.length ?? 0,
      customCells: pack.customVoronoi.includes(def.key),
      verdict: count === 0 ? 'none — questions about it answer “null”'
        : count === 1 && def.kind === 'point' ? 'only one — a matching question is always “yes”'
        : 'in play',
    };
  });
  const bytes = new Blob([serializeMap(pack)]).size;
  return { layers, bytes, tooBig: bytes > MAX_PACK_BYTES };
}
