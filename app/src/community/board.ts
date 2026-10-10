import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBbox from '@turf/bbox';
import type { FeatureCollection } from 'geojson';
import type { GameData } from '../data/load';
import { LAYER_DEFS, VORONOI_KEYS } from '../data/layers';
import type { Boundary, PoiLayer, Station } from '../engine/types';
import { zoneOf } from '../engine/candidates';
import { projectionAt } from '../engine/project';
import type { MapFile, MapStation } from './format';

/** The one board this build ships. A station map names the city it was drawn for. */
export const CITY = 'sf';

export type BoardProblem = { blocking: boolean; text: string };

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** The boundary a map is played inside: its own for a pack, the shipped board's otherwise. */
export function boundaryOf(map: MapFile, base: Boundary): Boundary {
  return map.kind === 'pack'
    ? { type: 'Feature', properties: { name: map.name }, geometry: map.boundary }
    : base;
}

/**
 * Can this map be played?
 *
 * A station outside the boundary is blocking, not a warning: every answer's
 * region is clipped to the boundary, so a zone beyond it could never be
 * confirmed or ruled out — it would sit on the count forever.
 */
export function checkMap(map: MapFile, baseBoundary: Boundary): BoardProblem[] {
  const problems: BoardProblem[] = [];
  if (map.kind === 'stations' && map.city !== CITY) {
    problems.push({ blocking: true, text: `This station map is for “${map.city}”, and this app only ships the San Francisco board.` });
    return problems;
  }
  const boundary = boundaryOf(map, baseBoundary);

  const outside = map.stations.filter((s) => !booleanPointInPolygon([s.lon, s.lat], boundary));
  if (outside.length) {
    const names = outside.slice(0, 3).map((s) => s.name).join(', ');
    problems.push({
      blocking: true,
      text: `${outside.length} station${outside.length === 1 ? ' is' : 's are'} outside the game boundary: ${names}${outside.length > 3 ? '…' : ''}`,
    });
  }

  // Same threshold the pipeline warns at: two zones on top of each other are
  // one zone the seekers have to eliminate twice. Measured in the map's own
  // UTM zone, not whichever board happens to be loaded.
  const tooClose = closePairs(map.stations, 50);
  if (tooClose) {
    problems.push({ blocking: false, text: `${tooClose} pair${tooClose === 1 ? '' : 's'} of stations are closer than 50 m apart.` });
  }
  return problems;
}

function closePairs(stations: MapStation[], withinM: number): number {
  if (stations.length < 2) return 0;
  const proj = projectionAt(stations[0].lon, stations[0].lat);
  const pts = stations.map((s) => proj.toUTM([s.lon, s.lat])).sort((a, b) => a[0] - b[0]);
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length && pts[j][0] - pts[i][0] < withinM; j++) {
      if (Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) < withinM) n++;
    }
  }
  return n;
}

function stationsOf(map: MapFile): { stations: Station[]; zones: FeatureCollection } {
  const stations: Station[] = map.stations.map((s) => ({
    id: s.id,
    name: s.name,
    lon: s.lon,
    lat: s.lat,
    modes: s.modes,
    routes: s.routes,
    nameLength: s.name.length,
  }));
  const zones: FeatureCollection = {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      id: s.id,
      properties: { id: s.id, name: s.name, modes: s.modes },
      geometry: zoneOf(s).geometry,
    })),
  };
  return { stations, zones };
}

/**
 * The board a map is played on.
 *
 * A station map is the shipped board with its stations swapped in. A pack is
 * a board of its own: nothing of the shipped one is kept, and a layer the
 * pack does not carry is simply a category not in play there.
 *
 * Zones are built with `zoneOf` — the engine's own circle — rather than any
 * second construction, for the reason the pipeline gives: drawing one shape
 * and deciding on another is how a map comes to disagree with its own count.
 *
 * The caller must point the engine at the result (`enterBoard`, engine/
 * reset.ts) before evaluating anything on it; a pack's zones are circles on
 * the ground and are computed in the engine's current projection.
 */
export function applyMap(base: GameData, map: MapFile): GameData {
  if (map.kind === 'stations') return { ...base, ...stationsOf(map) };

  const boundary = boundaryOf(map, base.boundary);
  const layers: Record<string, PoiLayer> = {};
  const voronoi: Record<string, FeatureCollection> = {};
  for (const def of LAYER_DEFS) {
    layers[def.key] = { key: def.key, label: def.label, kind: def.kind, features: map.layers[def.key] ?? [] };
  }
  for (const key of VORONOI_KEYS) {
    const cells = map.voronoi[key];
    voronoi[key] = cells?.length ? { type: 'FeatureCollection', features: cells } : EMPTY;
    // The engine answers matching questions from the same cells the map draws.
    if (cells?.length && layers[key]) layers[key].cells = voronoi[key];
  }
  return {
    boundary,
    bbox: turfBbox(boundary) as [number, number, number, number],
    districts: EMPTY,
    layers,
    voronoi,
    ...stationsOf(map),
  };
}
