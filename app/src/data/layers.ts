/*
 * Which layers a board can have. Kept apart from load.ts, which reads
 * `import.meta.env` and so cannot be imported by the Node scripts that share
 * the map-file validator (seed-community.ts, verify-community.ts).
 */

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
