import type { FeatureCollection } from 'geojson';
import type { Boundary, PoiLayer, Station } from '../engine/types';

const BASE = `${import.meta.env.BASE_URL}data`;

export type GameData = {
  boundary: Boundary;
  bbox: [number, number, number, number];
  stations: Station[];
  zones: FeatureCollection;
  districts: FeatureCollection;
  layers: Record<string, PoiLayer>;
  /**
   * Precomputed Voronoi cells per point layer, keyed by the same layer key.
   * A matching question is a question about these cells, so seeing them is the
   * difference between guessing and reading the board.
   */
  voronoi: Record<string, FeatureCollection>;
};

async function json<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}: HTTP ${res.status}`);
  return res.json();
}

/** Optional layers: absent files mean the category is not in play. */
async function optional<T>(name: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * POI layer definitions. `kind` decides how distance is measured: points
 * measure to the map icon, lines to the nearest point on the line.
 */
export const LAYER_DEFS: { key: string; label: string; kind: 'point' | 'line'; file: string }[] = [
  { key: 'parks', label: 'Parks', kind: 'point', file: 'poi-parks.geojson' },
  { key: 'libraries', label: 'Libraries', kind: 'point', file: 'poi-libraries.geojson' },
  { key: 'museums', label: 'Museums', kind: 'point', file: 'poi-museums.geojson' },
  { key: 'hospitals', label: 'Hospitals', kind: 'point', file: 'poi-hospitals.geojson' },
  { key: 'movieTheaters', label: 'Movie theaters', kind: 'point', file: 'poi-movie-theaters.geojson' },
  { key: 'consulates', label: 'Foreign consulates', kind: 'point', file: 'poi-consulates.geojson' },
  { key: 'golfCourses', label: 'Golf courses', kind: 'point', file: 'poi-golf-courses.geojson' },
  { key: 'aquariums', label: 'Aquariums', kind: 'point', file: 'poi-aquariums.geojson' },
  { key: 'zoos', label: 'Zoos', kind: 'point', file: 'poi-zoos.geojson' },
  { key: 'amusementParks', label: 'Amusement parks', kind: 'point', file: 'poi-amusement-parks.geojson' },
  { key: 'mountains', label: 'Mountains', kind: 'point', file: 'poi-mountains.geojson' },
  { key: 'water', label: 'Bodies of water', kind: 'point', file: 'poi-water.geojson' },
  { key: 'coastline', label: 'Coastline', kind: 'line', file: 'coastline.geojson' },
  { key: 'railStations', label: 'Rail stations', kind: 'point', file: 'rail-stations.geojson' },
  { key: 'transitLines', label: 'Transit lines', kind: 'line', file: 'transit-lines.geojson' },
  { key: 'admin2Border', label: 'County line', kind: 'line', file: 'county-line.geojson' },
];

/** Point layers that have a precomputed Voronoi diagram (2+ points). */
export const VORONOI_KEYS = [
  'parks', 'libraries', 'museums', 'hospitals', 'movieTheaters',
  'consulates', 'golfCourses', 'aquariums', 'mountains', 'water', 'railStations',
] as const;

export async function loadGameData(): Promise<GameData> {
  const [boundaryFc, bbox, stationsDoc, zones, districts] = await Promise.all([
    json<FeatureCollection>('boundary.geojson'),
    json<[number, number, number, number]>('bbox.json'),
    json<{ stations: Station[] }>('stations.json'),
    json<FeatureCollection>('zones.geojson'),
    json<FeatureCollection>('districts.geojson'),
  ]);

  const loaded = await Promise.all(
    LAYER_DEFS.map(async (def) => {
      const fc = await optional<FeatureCollection>(def.file);
      return [def.key, { key: def.key, label: def.label, kind: def.kind, features: fc?.features ?? [] }] as const;
    }),
  );

  const layers: Record<string, PoiLayer> = Object.fromEntries(loaded) as any;

  const cells = await Promise.all(
    VORONOI_KEYS.map(async (key) => {
      const fc = await optional<FeatureCollection>(`voronoi-${key}.geojson`);
      return [key, fc ?? { type: 'FeatureCollection', features: [] }] as const;
    }),
  );
  const voronoi = Object.fromEntries(cells) as Record<string, FeatureCollection>;

  return {
    boundary: boundaryFc.features[0] as Boundary,
    bbox,
    stations: stationsDoc.stations,
    zones,
    districts,
    layers,
    voronoi,
  };
}
