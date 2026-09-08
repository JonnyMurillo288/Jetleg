/**
 * Transit stations — the candidate set. Every hiding zone in the game is
 * centered on one of these, so this file defines the entire game board.
 *
 * Rule:
 *   - ALL rail, metro, tram, cable car and ferry stops are in play.
 *   - Bus stops are in play only if served by BUS_MIN_ROUTES or more distinct
 *     routes. OSM has ~3,500 bus stop nodes in SF; without a threshold the
 *     board is unplayable.
 *
 * "Distinct routes" is counted by route *ref* (the user-visible number, e.g.
 * "38"), not by relation. OSM models each direction as its own relation, so
 * counting relations would roughly double every stop's score.
 *
 * Deduplication is mandatory. OSM commonly models one real station as several
 * nodes: a stop_position on the rail line, one or more platforms, and a station
 * node. Left alone, Powell St becomes three overlapping hiding zones.
 *
 * Tune with:  BUS_MIN_ROUTES=4 npm run stations
 */
import circle from '@turf/circle';
import distance from '@turf/distance';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { featureCollection, point } from '@turf/helpers';
import type { Feature, Polygon } from 'geojson';
import { overpass, writeOut, readOut, assert, expectRange } from './lib.ts';

const BUS_MIN_ROUTES = Number(process.env.BUS_MIN_ROUTES ?? 5);
const DEDUP_METRES = 80;
const ZONE_RADIUS_M = 500; // small and medium games, per the rulebook

type Mode = 'rail' | 'metro' | 'bus' | 'cablecar' | 'ferry';

console.log(`02-stations  (BUS_MIN_ROUTES=${BUS_MIN_ROUTES})`);

const boundary = readOut('boundary.geojson').features[0] as Feature<Polygon>;
const [w, s, e, n] = readOut<number[]>('bbox.json');
const BB = `${s},${w},${n},${e}`;

// ---------------------------------------------------------------- fetch

const stopsRaw = await overpass(
  'osm-stops',
  `[out:json][timeout:180];
   (
     node["railway"~"^(station|halt|tram_stop)$"](${BB});
     node["public_transport"="station"](${BB});
     node["amenity"="ferry_terminal"](${BB});
     node["highway"="bus_stop"](${BB});
   );
   out body;`,
);

const routesRaw = await overpass(
  'osm-routes',
  `[out:json][timeout:180];
   relation["type"="route"]["route"~"^(bus|trolleybus|tram|subway|light_rail|train|ferry|cable_car|funicular)$"](${BB});
   out body;`,
);

// Route relations usually reference the stop_position node on the track rather
// than the named platform node we keep as a station. Without these, most rail
// stations come out with an empty route list and the Transit Line question is
// unanswerable. Fetched separately as position donors, not as candidates.
const donorsRaw = await overpass(
  'osm-stop-positions',
  `[out:json][timeout:180];
   node["public_transport"="stop_position"](${BB});
   out body;`,
);

console.log(`  ${stopsRaw.elements.length} candidate stop nodes, ${routesRaw.elements.length} route relations, ${donorsRaw.elements.length} stop positions`);

// ------------------------------------------------- routes serving each node

/**
 * Mode comes from the route relations that serve a stop, not from the stop's
 * own tags. OSM tags stop nodes inconsistently, but route relations carry a
 * reliable `route` type.
 *
 * The one special case is `route=tram`: in SF that covers both the three cable
 * car lines (refs C, PH, PM) and the F Market historic streetcar, which is an
 * ordinary tram. Split them on ref.
 */
const CABLE_CAR_REFS = new Set(['C', 'PH', 'PM']);

function modeOfRoute(routeType: string, ref: string | undefined): Mode | null {
  switch (routeType) {
    case 'subway':
    case 'light_rail':
      return 'metro';
    case 'tram':
      return ref && CABLE_CAR_REFS.has(ref) ? 'cablecar' : 'metro';
    case 'train':
      return 'rail';
    case 'ferry':
      return 'ferry';
    case 'bus':
    case 'trolleybus':
      return 'bus';
    default:
      return null;
  }
}

/** node id -> distinct route refs, and the modes those routes imply */
const servedBy = new Map<number, { refs: Set<string>; modes: Set<Mode>; busRefs: Set<string> }>();

for (const rel of routesRaw.elements) {
  const t = rel.tags ?? {};
  const mode = modeOfRoute(t.route, t.ref);
  if (!mode) continue;
  // Prefer ref ("38"); fall back to name so unnumbered routes still count once.
  // Strip the inbound/outbound suffix so the two directions collapse to one.
  const key = t.ref ?? String(t.name ?? '').replace(/:.*$/, '').trim();
  if (!key) continue;

  for (const m of rel.members ?? []) {
    if (m.type !== 'node') continue;
    let rec = servedBy.get(m.ref);
    if (!rec) servedBy.set(m.ref, (rec = { refs: new Set(), modes: new Set(), busRefs: new Set() }));
    rec.refs.add(key);
    rec.modes.add(mode);
    if (mode === 'bus') rec.busRefs.add(key);
  }
}

/**
 * Fall back to the node's own tags when no route relation references it.
 *
 * The subtlety is `railway=station`: OSM uses it for Muni Metro surface stops
 * as well as Caltrain, distinguished only by `station=light_rail`. Treating a
 * bare `railway=station` as heavy rail labelled 63 Muni stops as Caltrain,
 * which has exactly two stations in SF. Check the light-rail markers first.
 */
function modesFromTags(tags: Record<string, string>): Mode[] {
  const m = new Set<Mode>();
  if (tags.amenity === 'ferry_terminal') m.add('ferry');

  const lightish =
    tags.station === 'light_rail' || tags.station === 'subway' ||
    tags.light_rail === 'yes' || tags.tram === 'yes' || tags.subway === 'yes' ||
    tags.railway === 'tram_stop';
  if (lightish) m.add('metro');

  const isStation = tags.railway === 'station' || tags.railway === 'halt';
  if (tags.train === 'yes' || (isStation && !lightish && tags.train !== 'no')) m.add('rail');

  if (tags.highway === 'bus_stop' || tags.bus === 'yes' || tags.trolleybus === 'yes') m.add('bus');
  if (m.size === 0) m.add('bus');
  return [...m];
}

// ---------------------------------------------------------------- filter

type Cand = {
  osmId: number;
  name: string;
  lon: number; lat: number;
  modes: Mode[];
  routes: string[];
  railish: boolean;
  /** A real station node, as opposed to a platform or bus pole beside it. */
  isStationNode: boolean;
  tags: Record<string, string>;
};

const histogram = new Map<number, number>();
const candidates: Cand[] = [];
let outOfBounds = 0;
let unnamed = 0;

for (const el of stopsRaw.elements) {
  if (el.type !== 'node') continue;
  const tags: Record<string, string> = el.tags ?? {};

  // Mainland only. The bbox is rectangular; the boundary is not.
  if (!booleanPointInPolygon(point([el.lon, el.lat]), boundary)) { outOfBounds++; continue; }

  const rec = servedBy.get(el.id);
  const modes = rec && rec.modes.size ? [...rec.modes] : modesFromTags(tags);
  const refs = rec?.refs ?? new Set<string>();
  const busRefs = rec?.busRefs ?? new Set<string>();

  // "All train stops" — rail, metro, cable car and ferry are always in play.
  const railish = modes.some((m) => m !== 'bus');

  if (!railish) {
    histogram.set(busRefs.size, (histogram.get(busRefs.size) ?? 0) + 1);
    if (busRefs.size < BUS_MIN_ROUTES) continue;
  }

  const name = tags.name ?? tags['name:en'] ?? null;
  if (!name) { unnamed++; continue; } // Station Name's Length needs a name

  candidates.push({
    osmId: el.id, name, lon: el.lon, lat: el.lat,
    modes, routes: [...refs].sort(), railish, tags,
    isStationNode:
      tags.public_transport === 'station' ||
      tags.railway === 'station' || tags.railway === 'halt' ||
      tags.amenity === 'ferry_terminal',
  });
}

console.log(`  ${outOfBounds} nodes outside the mainland boundary, ${unnamed} unnamed dropped`);
console.log('  bus stops by distinct route count:');
const counts = [...histogram.entries()].sort((a, b) => a[0] - b[0]);
let running = counts.reduce((s, [, c]) => s + c, 0);
for (const [routes, n] of counts) {
  console.log(`    ${String(routes).padStart(2)} routes: ${String(n).padStart(4)} stops   (>=${routes}: ${running})`);
  running -= n;
}

// ---------------------------------------------------------------- dedup

/**
 * Cluster purely by distance. Merging on name as well was too strict: OSM names
 * the two sides of one intersection differently ("2nd & King" vs "King Street &
 * 2nd Street"), so name-matching left both in and produced two near-identical
 * hiding zones. Two genuinely distinct stations are never this close, and
 * opposite-direction stops across an intersection are one stop for game
 * purposes anyway.
 */
const norm = (s: string) =>
  s.toLowerCase()
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|road|rd|station|stn)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

const MODE_RANK: Record<Mode, number> = { rail: 0, metro: 1, cablecar: 2, ferry: 3, bus: 4 };
const rank = (c: Cand) => Math.min(...c.modes.map((m) => MODE_RANK[m]));

const clusters: Cand[][] = [];
const used = new Set<number>();

/**
 * Station nodes anchor clusters, ahead of everything else.
 *
 * Ranking by route count first was wrong: BART's station node carries no route
 * relations (they reference the stop_positions on the platform), while the bus
 * pole on the corner carries a dozen. That let "Market Street & 8th Street"
 * outrank and swallow "Civic Center", losing four downtown station names.
 */
const ordered = [...candidates].sort(
  (a, b) =>
    Number(b.isStationNode) - Number(a.isStationNode) ||
    rank(a) - rank(b) ||
    b.routes.length - a.routes.length ||
    b.name.length - a.name.length,
);

for (const c of ordered) {
  if (used.has(c.osmId)) continue;
  used.add(c.osmId);
  const group = [c];
  for (const o of ordered) {
    if (used.has(o.osmId)) continue;
    if (distance([c.lon, c.lat], [o.lon, o.lat], { units: 'meters' }) > DEDUP_METRES) continue;
    used.add(o.osmId);
    group.push(o);
  }
  clusters.push(group);
}

console.log(`  ${candidates.length} candidates -> ${clusters.length} after dedup`);

// ---------------------------------------------------------------- emit

// Route donors: every stop_position with known routes, kept as bare points so
// each station can absorb the routes of whatever sits on the track beside it.
const donors = (donorsRaw.elements as any[])
  .filter((el) => el.type === 'node' && servedBy.has(el.id))
  .map((el) => ({
    lon: el.lon, lat: el.lat,
    refs: servedBy.get(el.id)!.refs,
    modes: servedBy.get(el.id)!.modes,
  }));
console.log(`  ${donors.length} stop positions carry route info`);

const slugged = new Map<string, number>();
let enriched = 0;
const stations = clusters.map((group) => {
  const head = group[0];
  const modes = new Set(group.flatMap((g) => g.modes));
  const routes = new Set(group.flatMap((g) => g.routes));
  // Centroid of the cluster, so a station split across platforms sits between them.
  const lon = group.reduce((s, g) => s + g.lon, 0) / group.length;
  const lat = group.reduce((s, g) => s + g.lat, 0) / group.length;

  const before = routes.size;
  for (const d of donors) {
    if (distance([lon, lat], [d.lon, d.lat], { units: 'meters' }) > DEDUP_METRES) continue;
    for (const r of d.refs) routes.add(r);
    for (const m of d.modes) modes.add(m);
  }
  if (routes.size > before) enriched++;

  let slug = norm(head.name) || `stop${head.osmId}`;
  const seen = slugged.get(slug) ?? 0;
  slugged.set(slug, seen + 1);
  if (seen) slug = `${slug}-${seen + 1}`;

  const zone = circle([lon, lat], ZONE_RADIUS_M, { steps: 64, units: 'meters' });

  return {
    id: slug,
    name: head.name,
    lon, lat,
    modes: [...modes].sort() as Mode[],
    routes: [...routes].sort(),
    nameLength: head.name.length, // hyphens and spaces count, per the rulebook
    osmIds: group.map((g) => g.osmId),
    zone: zone.geometry,
  };
});

console.log(`  ${enriched} stations gained routes from nearby stop positions`);

/**
 * Second dedup pass, on final positions.
 *
 * Clustering anchors on a node but emits the cluster's centroid, and absorbing
 * members drags that centroid. Two anchors more than DEDUP_METRES apart can
 * therefore end up with centroids closer than that — which is how "Balboa Park"
 * survived as two stations 64 m apart. Merge on the emitted geometry and
 * iterate to a fixed point.
 */
type Station = (typeof stations)[number];

function mergePass(input: Station[]): { out: Station[]; merged: number } {
  const out: Station[] = [];
  const consumed = new Set<number>();
  let merged = 0;

  for (let i = 0; i < input.length; i++) {
    if (consumed.has(i)) continue;
    const group = [input[i]];
    consumed.add(i);
    for (let j = i + 1; j < input.length; j++) {
      if (consumed.has(j)) continue;
      const d = distance([input[i].lon, input[i].lat], [input[j].lon, input[j].lat], { units: 'meters' });
      if (d > DEDUP_METRES) continue;
      consumed.add(j);
      group.push(input[j]);
      merged++;
    }
    if (group.length === 1) { out.push(group[0]); continue; }

    // Weight the new centre by how many OSM nodes each side represents.
    const w = group.map((g) => g.osmIds.length);
    const total = w.reduce((a, b) => a + b, 0);
    const lon = group.reduce((s, g, k) => s + g.lon * w[k], 0) / total;
    const lat = group.reduce((s, g, k) => s + g.lat * w[k], 0) / total;

    out.push({
      ...group[0], // already the highest-priority mode, per the ordering above
      lon, lat,
      modes: [...new Set(group.flatMap((g) => g.modes))].sort() as Mode[],
      routes: [...new Set(group.flatMap((g) => g.routes))].sort(),
      osmIds: group.flatMap((g) => g.osmIds),
      zone: circle([lon, lat], ZONE_RADIUS_M, { steps: 64, units: 'meters' }).geometry,
    });
  }
  return { out, merged };
}

let final = stations;
for (let pass = 1; pass <= 5; pass++) {
  const { out, merged } = mergePass(final);
  final = out;
  if (!merged) break;
  console.log(`  merge pass ${pass}: collapsed ${merged} duplicate station(s) -> ${final.length}`);
}

const routeless = final.filter((s) => s.routes.length === 0).length;
console.log(`  ${routeless} stations still have no known routes`);

// ---------------------------------------------------------------- verify

const byMode = new Map<string, number>();
for (const st of final) for (const m of st.modes) byMode.set(m, (byMode.get(m) ?? 0) + 1);
console.log('  by mode: ' + [...byMode].map(([m, n]) => `${m}=${n}`).join('  '));

// No two stations within the dedup radius — catches a dedup failure.
let tooClose = 0;
for (let i = 0; i < final.length; i++) {
  for (let j = i + 1; j < final.length; j++) {
    const d = distance([final[i].lon, final[i].lat], [final[j].lon, final[j].lat], { units: 'meters' });
    if (d < DEDUP_METRES) {
      if (tooClose < 5) console.warn(`  ! ${final[i].name} / ${final[j].name} are ${d.toFixed(0)} m apart`);
      tooClose++;
    }
  }
}
if (tooClose) console.warn(`  ! ${tooClose} station pair(s) closer than ${DEDUP_METRES} m (differing names, kept intentionally)`);

expectRange('stations', final.length, 200, 350);
assert(final.length > 50, 'station count is far too low — the Overpass query probably failed');
assert(byMode.get('metro') || byMode.get('rail'), 'no rail or metro stations found');

writeOut('stations.geojson', featureCollection(
  final.map((st) => point([st.lon, st.lat], {
    id: st.id, name: st.name, modes: st.modes, routes: st.routes, nameLength: st.nameLength,
  }, { id: st.id })),
));

writeOut('zones.geojson', featureCollection(
  final.map((st) => ({
    type: 'Feature' as const,
    id: st.id,
    properties: { id: st.id, name: st.name, modes: st.modes },
    geometry: st.zone,
  })),
));

writeOut('stations.json', {
  generated: new Date().toISOString(),
  busMinRoutes: BUS_MIN_ROUTES,
  zoneRadiusM: ZONE_RADIUS_M,
  count: final.length,
  stations: final.map(({ zone, ...rest }) => rest),
});
