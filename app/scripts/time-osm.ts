/**
 * How long the map studio takes to fill a board from OpenStreetMap, live.
 *
 *   npm run time:osm -- "San Francisco"
 *   npm run time:osm -- "Los Angeles, California"
 *
 * Runs the studio's own `osm.ts` in the order a person clicks: boundary set
 * (which starts the fetch), rail stops, all stops, every category, lines,
 * coastline. Every request to a mirror is logged with its status, time and
 * size, so a slow fill says whether it was the queue, the size of the
 * answer, or our own parsing. Hits the shared public services: run it to
 * measure, not in a loop.
 */
import { MAX_STATIONS } from '../src/community/format';
import { fetchAllPois, fetchCoastline, fetchStations, fetchTransitLines, prefetchBoard, searchPlaces, spaceOut } from '../src/community/osm';
import { boundaryStats, largestLandmass } from '../src/community/pack';

const realFetch = globalThis.fetch;
// Overpass refuses Node's default User-Agent (406); a browser sends its own.
globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const t = Date.now();
  const host = String(url).replace(/^https:\/\//, '').slice(0, 24).padEnd(24);
  try {
    const res = await realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'User-Agent': 'jetleg-time-osm/1.0' } });
    const body = await res.arrayBuffer();
    console.log(`    ${host} ${res.status} after ${((Date.now() - t) / 1000).toFixed(1)}s, ${(body.byteLength / 1e6).toFixed(2)} MB`);
    return new Response(body, { status: res.status, headers: res.headers });
  } catch (e) {
    console.log(`    ${host} ${(e as Error).name} after ${((Date.now() - t) / 1000).toFixed(1)}s`);
    throw e;
  }
}) as typeof fetch;

const start = Date.now();
const at = () => `${((Date.now() - start) / 1000).toFixed(1)}s`.padStart(7);
const wait = (s: number) => console.log(`    every mirror failed; retrying in ${s}s`);

const place = (await searchPlaces(process.argv[2] ?? 'San Francisco'))[0];
if (!place) throw new Error('No place with an outline by that name.');
const boundary = largestLandmass(place.geometry).polygon;
const stats = boundaryStats(boundary);
console.log(`${place.name}: ${Math.round(stats.km2)} km², ${stats.vertices} points in the outline`);

prefetchBoard(boundary);
const rail = await fetchStations(boundary, false, wait);
console.log(`${at()}  rail, metro, tram and ferry stops: ${rail.stations.length}`);
const all = await fetchStations(boundary, true, wait);
console.log(`${at()}  every stop: ${all.stations.length}`);
if (all.stations.length > MAX_STATIONS) {
  const t = performance.now();
  const kept = spaceOut(all.stations, MAX_STATIONS);
  const notBus = (s: { modes: string[] }) => s.modes.some((m) => m !== 'bus');
  console.log(`         spaced out to ${kept.length} (${kept.filter(notBus).length} of ${all.stations.filter(notBus).length} not bus-only kept) in ${(performance.now() - t).toFixed(0)} ms`);
}
const pois = await fetchAllPois(boundary, wait);
console.log(`${at()}  places: ${Object.entries(pois).map(([k, v]) => `${k} ${v.features.length}`).join(', ')}`);
const lines = await fetchTransitLines(boundary, wait);
console.log(`${at()}  transit lines: ${lines.length} (${(JSON.stringify(lines).length / 1e6).toFixed(2)} MB as a layer)`);
const coast = await fetchCoastline(boundary, wait);
console.log(`${at()}  coastline: ${coast.length} stretches`);
