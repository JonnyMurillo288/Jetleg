import intersect from '@turf/intersect';
import { featureCollection } from '@turf/helpers';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
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

/**
 * Normalize the raw DataSF supervisor-district export into the shape the app
 * already uses for district display, and clip each district to the play
 * boundary in the same pass — so the map's "Supervisor districts" toggle and
 * the 4th-admin-division matching question read the exact same polygons.
 * Clipping here also drops island fragments (Treasure Island etc.) outside
 * the boundary, without a separate trimming step.
 */
function normalizeDistricts(raw: FeatureCollection, boundary: Boundary): Feature<Polygon | MultiPolygon>[] {
  const out: Feature<Polygon | MultiPolygon>[] = [];
  for (const f of raw.features) {
    const num = Number(f.properties?.sup_dist_num ?? f.properties?.sup_dist);
    if (!Number.isFinite(num)) continue;
    let clipped: Feature<Polygon | MultiPolygon> | null = null;
    try {
      clipped = intersect(featureCollection([f as any, boundary as any]) as any) as Feature<Polygon | MultiPolygon> | null;
    } catch {
      clipped = null;
    }
    if (!clipped) continue;
    clipped.properties = {
      id: `sd-${num}`,
      district: num,
      name: `District ${num}`,
      supervisor: (f.properties?.sup_name as string) ?? null,
    };
    out.push(clipped);
  }
  return out;
}

export async function loadGameData(): Promise<GameData> {
  const [boundaryFc, bbox, stationsDoc, zones, districtsRaw] = await Promise.all([
    json<FeatureCollection>('boundary.geojson'),
    json<[number, number, number, number]>('bbox.json'),
    json<{ stations: Station[] }>('stations.json'),
    json<FeatureCollection>('zones.geojson'),
    json<FeatureCollection>('districts-supervisor.geojson'),
  ]);

  const boundary = boundaryFc.features[0] as Boundary;
  const districtFeatures = normalizeDistricts(districtsRaw, boundary);
  const districts: FeatureCollection = { type: 'FeatureCollection', features: districtFeatures as any };

  const loaded = await Promise.all(
    LAYER_DEFS.map(async (def) => {
      const fc = await optional<FeatureCollection>(def.file);
      return [def.key, { key: def.key, label: def.label, kind: def.kind, features: fc?.features ?? [] }] as const;
    }),
  );

  const layers: Record<string, PoiLayer> = Object.fromEntries(loaded) as any;

  /**
   * Two synthetic layers, built from data already loaded rather than fetched:
   *
   * `admin4` — the same clipped district polygons as `data.districts`, so the
   * house-rule matching question and the map toggle can never disagree.
   *
   * `stationNames` — every hiding-zone station (all 192, not just the 56 in
   * `rail-stations.geojson`, which excludes bus-only stops) as a point layer,
   * so "Station Name's Length" carves cells the same way any other matching
   * question does, over the whole board rather than a rail-only subset.
   */
  layers.admin4 = { key: 'admin4', label: '4th Administrative Division', kind: 'polygon', features: districtFeatures };
  layers.stationNames = {
    key: 'stationNames',
    label: 'Stations (by name)',
    kind: 'point',
    features: stationsDoc.stations.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    } as Feature<Point>)),
  };

  const cells = await Promise.all(
    VORONOI_KEYS.map(async (key) => {
      const fc = await optional<FeatureCollection>(`voronoi-${key}.geojson`);
      return [key, fc ?? { type: 'FeatureCollection', features: [] }] as const;
    }),
  );
  const voronoi = Object.fromEntries(cells) as Record<string, FeatureCollection>;
  // Districts already partition the board, so their own polygons serve as
  // their own "Voronoi" layer for the map toggle — nothing to fetch or carve.
  voronoi.districts = districts;

  /*
   * Hand each layer its own cells.
   *
   * The map and the elimination engine then read the same polygons, rather than
   * each deriving its own and being expected to agree. They did not: the
   * runtime carve misclassified 9% of the ground around the de Young.
   */
  for (const [key, fc] of Object.entries(voronoi)) {
    if (layers[key] && fc.features.length) layers[key].cells = fc;
  }

  return {
    boundary,
    bbox,
    stations: stationsDoc.stations,
    zones,
    districts,
    layers,
    voronoi,
  };
}
