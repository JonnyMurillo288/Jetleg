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

export { LAYER_DEFS, VORONOI_KEYS } from './layers';
import { LAYER_DEFS, VORONOI_KEYS } from './layers';

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
    boundary: boundaryFc.features[0] as Boundary,
    bbox,
    stations: stationsDoc.stations,
    zones,
    districts,
    layers,
    voronoi,
  };
}
