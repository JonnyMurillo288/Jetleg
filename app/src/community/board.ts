import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { FeatureCollection } from 'geojson';
import type { GameData } from '../data/load';
import type { Boundary, Station } from '../engine/types';
import { zoneOf } from '../engine/candidates';
import { metres } from '../engine/project';
import type { MapFile } from './format';

/** The one board this build ships. A map names the city it was drawn for. */
export const CITY = 'sf';

export type BoardProblem = { blocking: boolean; text: string };

/**
 * Can this map be played on this board?
 *
 * A station outside the boundary is blocking, not a warning: every answer's
 * region is clipped to the boundary, so a zone beyond it could never be
 * confirmed or ruled out — it would sit on the count forever.
 */
export function checkMap(map: MapFile, boundary: Boundary): BoardProblem[] {
  const problems: BoardProblem[] = [];
  if (map.city !== CITY) {
    problems.push({ blocking: true, text: `This map is for “${map.city}”, and this app only has the San Francisco board.` });
    return problems;
  }

  const outside = map.stations.filter((s) => !booleanPointInPolygon([s.lon, s.lat], boundary));
  if (outside.length) {
    const names = outside.slice(0, 3).map((s) => s.name).join(', ');
    problems.push({
      blocking: true,
      text: `${outside.length} station${outside.length === 1 ? ' is' : 's are'} outside the game boundary: ${names}${outside.length > 3 ? '…' : ''}`,
    });
  }

  // Same threshold the pipeline warns at: two zones on top of each other are
  // one zone the seekers have to eliminate twice.
  let tooClose = 0;
  for (let i = 0; i < map.stations.length; i++) {
    for (let j = i + 1; j < map.stations.length; j++) {
      const a = map.stations[i];
      const b = map.stations[j];
      if (Math.abs(a.lat - b.lat) > 0.001) continue;
      if (metres([a.lon, a.lat], [b.lon, b.lat]) < 50) tooClose++;
    }
  }
  if (tooClose) {
    problems.push({ blocking: false, text: `${tooClose} pair${tooClose === 1 ? '' : 's'} of stations are closer than 50 m apart.` });
  }
  return problems;
}

/**
 * The shipped board with a map's stations swapped in.
 *
 * Zones are built with `zoneOf` — the engine's own circle — rather than any
 * second construction, for the reason the pipeline gives: drawing one shape
 * and deciding on another is how a map comes to disagree with its own count.
 * Everything that is not the station set (boundary, POI layers, their cells)
 * is the base board's, untouched.
 */
export function applyMap(base: GameData, map: MapFile): GameData {
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
  return { ...base, stations, zones };
}
