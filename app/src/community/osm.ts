import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBbox from '@turf/bbox';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { Mode } from '../engine/types';
import { projectionAt } from '../engine/project';
import { countryCode, slugId, type LayerFeature, type MapStation } from './format';
import { boundaryFeature } from './pack';

/**
 * OpenStreetMap, from the browser — the fetching half of the pipeline.
 *
 * `pipeline/` built San Francisco by asking Overpass for each kind of place
 * and keeping what passed the rulebook's tests. These are the same queries
 * and the same tests (named features only, honorary consulates out, pools
 * out, one entry per place), pointed at whatever boundary the studio has
 * open. The parsing is separate from the fetching so it can be tested
 * without a network.
 *
 * Two public services are used, both free and both rate-limited: Nominatim
 * to find a place's outline by name, Overpass for everything inside it. A
 * busy Overpass answers 429 or 504; that is routine, and retried.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Public instances that answer a browser's cross-origin POST. Under load one
// may answer 502 at once and another hang for minutes; no single one is
// reliable, so a request moves between them rather than waiting on one.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export type Place = {
  name: string;
  /** ISO 3166-1 alpha-2, lowercase, when OpenStreetMap says which country it is in. */
  country?: string;
  geometry: Polygon | MultiPolygon;
  bbox: [number, number, number, number];
};

/** Places matching a name that have an outline — a city, a borough, an island. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `${NOMINATIM}?format=jsonv2&polygon_geojson=1&addressdetails=1&limit=6&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}).`);
  const rows = (await res.json()) as { display_name: string; geojson?: { type: string }; boundingbox?: string[]; address?: { country_code?: string } }[];
  return rows
    .filter((r) => r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon') && r.boundingbox?.length === 4)
    .map((r) => {
      const [s, n, w, e] = r.boundingbox!.map(Number);
      const country = countryCode(r.address?.country_code);
      return { name: r.display_name, geometry: r.geojson as Polygon | MultiPolygon, bbox: [w, s, e, n], ...(country ? { country } : {}) };
    });
}

type Element = {
  /** `section` is this module's own marker between the parts of a combined answer. */
  type: 'node' | 'way' | 'relation' | 'section';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  /** Clipped output (`out geom(bbox)`) has null wherever a point falls outside the box. */
  members?: { type: string; geometry?: ({ lat: number; lon: number } | null)[] }[];
};

/** A mirror that has not answered by now gets a second mirror asked alongside it. */
const HEDGE_S = 45;
/** A little over the queries' own `[timeout:180]`: past this the server has given up too. */
const ATTEMPT_S = 200;
/** Then say so, rather than leave the studio saying "Fetching…" for half an hour. */
const GIVE_UP_S = 360;

/**
 * One query, answered by whichever mirror answers first.
 *
 * A fetch to a busy mirror used to have no limit at all: one that accepted
 * the connection and never replied held the studio for minutes per attempt,
 * five attempts per tool, four tools. Now a mirror that fails fast is left
 * at once for the next, one that is slow gets a second asked alongside it,
 * and the whole thing gives up after six minutes.
 */
export async function overpass(query: string, signal?: AbortSignal, onWait?: (seconds: number) => void): Promise<Element[]> {
  const body = 'data=' + encodeURIComponent(query);
  const deadline = Date.now() + GIVE_UP_S * 1000;
  let last = '';

  // The elements, or why this mirror did not give them. Throws only when no
  // mirror could: a query Overpass cannot parse, or the caller giving up.
  const ask = async (url: string, stop: AbortSignal): Promise<Element[] | string> => {
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    stop.addEventListener('abort', cancel);
    signal?.addEventListener('abort', cancel);
    const timer = setTimeout(cancel, Math.max(0, Math.min(ATTEMPT_S * 1000, deadline - Date.now())));
    try {
      const res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (res.status === 400) throw new Error('OpenStreetMap could not read the request (HTTP 400).');
      if (!res.ok) return `HTTP ${res.status}`;
      const parsed = (await res.json()) as { elements?: Element[]; remark?: string };
      // Out of time or memory still answers 200, with whatever it had so far
      // and a remark saying so. Taking that would be a silently partial board.
      if (parsed.remark && /runtime error/i.test(parsed.remark)) return 'too large';
      return parsed.elements ?? 'nothing usable';
    } catch (e) {
      if (signal?.aborted || (e instanceof Error && /HTTP 400/.test(e.message))) throw e;
      return ctl.signal.aborted ? 'no answer' : 'no connection';
    } finally {
      clearTimeout(timer);
      stop.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', cancel);
    }
  };

  // Every mirror once, overlapping when one is slow; the first answer wins
  // and the others are cancelled.
  const round = () => new Promise<Element[] | null>((resolve, reject) => {
    const stop = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let next = 0;
    let running = 0;
    let settled = false;
    const finish = (els: Element[] | null, err?: unknown) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      stop.abort();
      if (err) reject(err); else resolve(els);
    };
    const launch = () => {
      if (settled) return;
      if (next >= OVERPASS.length || Date.now() >= deadline) { if (!running) finish(null); return; }
      running++;
      timers.push(setTimeout(launch, HEDGE_S * 1000));
      ask(OVERPASS[next++], stop.signal).then((got) => {
        running--;
        if (typeof got !== 'string') { finish(got); return; }
        if (!settled) last = got;
        launch();
      }, (e) => finish(null, e));
    };
    launch();
  });

  const waits = [5, 15, 30];
  for (let attempt = 0; ; attempt++) {
    const elements = await round();
    if (elements) return elements;
    const wait = waits[attempt];
    if (wait === undefined || Date.now() + wait * 1000 >= deadline) break;
    onWait?.(wait);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  if (last === 'too large') throw new Error('This area is too large for OpenStreetMap to answer in one request. Try a smaller boundary.');
  throw new Error(`OpenStreetMap is not answering (${last}). It is a shared free service — try again in a minute.`);
}

// ------------------------------------------------------------------- the board

type Bbox = [number, number, number, number];

/** About a kilometre, so a boundary nudged or simplified afterwards still fits inside what was fetched. */
const PAD = 0.01;

const bboxClause = ([w, s, e, n]: Bbox) => `${s},${w},${n},${e}`;

const STATION_SELECTORS = ['node["railway"~"^(station|halt|tram_stop)$"]', 'node["public_transport"="station"]', 'node["amenity"="ferry_terminal"]'];
const BUS_SELECTOR = 'node["highway"="bus_stop"]';

/** What the "rail, metro, tram and ferry" button asks for: everything the bus-stop selector adds is left out. */
const isStation = (t: Record<string, string>) =>
  /^(station|halt|tram_stop)$/.test(t.railway ?? '') || t.public_transport === 'station' || t.amenity === 'ferry_terminal';

/**
 * Everything the studio fetches, in one request: places, stops (buses
 * included), coastline and transit lines, told apart by `make section`
 * markers between them.
 *
 * Four requests cost four turns in a shared queue that is the whole of the
 * wait — each took 30–40 s on a busy day whatever its size — and four
 * chances at a 429. Transit lines are clipped to the box: a route relation
 * is the whole route, and a national rail line crossing a city brought 15 MB
 * of track from elsewhere into every San Francisco fetch.
 */
export function boardQuery(bbox: Bbox): string {
  const bb = bboxClause(bbox);
  const pois = Object.values(POI_DEFS).map((def) => `nwr${selectorOf(def)}(${bb});`).join('');
  const stops = [...STATION_SELECTORS, BUS_SELECTOR].map((sel) => `${sel}(${bb});`).join('');
  return `[out:json][timeout:180];
(${pois});out center tags;
make section name="stations";out;
(${stops});out;
make section name="coastline";out;
way["natural"="coastline"](${bb});out geom;
make section name="lines";out;
relation["type"="route"]["route"~"^(subway|light_rail|tram|train|ferry)$"](${bb});out geom(${bb});`;
}

export type BoardElements = { pois: Element[]; stations: Element[]; coastline: Element[]; lines: Element[] };

export function splitBoard(elements: Element[]): BoardElements {
  const board: BoardElements = { pois: [], stations: [], coastline: [], lines: [] };
  let into = board.pois;
  for (const el of elements) {
    if (el.type !== 'section') { into.push(el); continue; }
    into = board[el.tags?.name as keyof BoardElements];
    if (!into) throw new Error('OpenStreetMap answered in a shape the studio does not know.');
  }
  return board;
}

/**
 * Fetches made this session, newest last. Any whose box contains a boundary
 * answers for it — the parsers cut to the boundary itself — so the four
 * tools, a simplified outline and a re-drawn one inside the old all share
 * one request. A failed fetch is forgotten, so the next click asks again.
 */
const fetches: { bbox: Bbox; board: Promise<BoardElements>; waiting: Set<(s: number) => void> }[] = [];

export function fetchBoard(boundary: Polygon, onWait?: (s: number) => void): Promise<BoardElements> {
  const [w, s, e, n] = turfBbox(boundary);
  let f = fetches.find(({ bbox }) => bbox[0] <= w && bbox[1] <= s && bbox[2] >= e && bbox[3] >= n);
  if (!f) {
    const bbox: Bbox = [w - PAD, s - PAD, e + PAD, n + PAD];
    const waiting = new Set<(s: number) => void>();
    const board = overpass(boardQuery(bbox), undefined, (sec) => waiting.forEach((cb) => cb(sec))).then(splitBoard);
    const entry = { bbox, board, waiting };
    f = entry;
    fetches.push(entry);
    if (fetches.length > 3) fetches.shift();
    board.catch(() => { const i = fetches.indexOf(entry); if (i >= 0) fetches.splice(i, 1); });
  }
  if (onWait) {
    const { waiting } = f;
    waiting.add(onWait);
    f.board.finally(() => waiting.delete(onWait)).catch(() => {});
  }
  return f.board;
}

/** Start fetching as soon as there is a boundary, so the tools find it waiting. */
export function prefetchBoard(boundary: Polygon): void {
  fetchBoard(boundary).catch(() => { /* the tool that needs it will ask again, and say why */ });
}

// ------------------------------------------------------------------ POI layers

type PoiDef = { tag: [string, string]; reject?: (tags: Record<string, string>) => boolean };

/** Step 04's layer definitions: the same tags, the same exclusions. */
export const POI_DEFS: Record<string, PoiDef> = {
  parks: { tag: ['leisure', 'park'] },
  libraries: { tag: ['amenity', 'library'] },
  museums: { tag: ['tourism', 'museum'] },
  hospitals: { tag: ['amenity', 'hospital'] },
  movieTheaters: { tag: ['amenity', 'cinema'] },
  // The rulebook excludes honorary consulates.
  consulates: { tag: ['office', 'diplomatic'], reject: (t) => t.diplomatic === 'honorary_consulate' || t.consulate === 'honorary' },
  // Outdoor courses only; mini-golf and driving ranges do not count.
  golfCourses: { tag: ['leisure', 'golf_course'], reject: (t) => t.golf === 'miniature' || t.leisure === 'miniature_golf' || t.golf === 'driving_range' },
  aquariums: { tag: ['tourism', 'aquarium'] },
  zoos: { tag: ['tourism', 'zoo'] },
  amusementParks: { tag: ['tourism', 'theme_park'] },
  mountains: { tag: ['natural', 'peak'] },
  // "Any named body of water, excluding pools."
  water: { tag: ['natural', 'water'], reject: (t) => t.water === 'pool' || t.leisure === 'swimming_pool' || t.water === 'reflecting_pool' },
};

const selectorOf = (def: PoiDef) => `["${def.tag[0]}"="${def.tag[1]}"]`;

export type Dropped = { unnamed: number; outside: number; rejected: number; duplicates: number };

/**
 * Everything is a POINT, because the rulebook measures to the map icon, not
 * to the nearest edge of a feature. Ways and relations arrive with Overpass's
 * `center`.
 */
export function parsePois(key: string, elements: Element[], boundary: Polygon): { features: LayerFeature[]; dropped: Dropped } {
  const def = POI_DEFS[key];
  const within = boundaryFeature(boundary);
  const seen = new Set<string>();
  const features: LayerFeature[] = [];
  const dropped: Dropped = { unnamed: 0, outside: 0, rejected: 0, duplicates: 0 };

  for (const el of elements) {
    const tags = el.tags ?? {};
    // A combined fetch returns every category at once; take only this one's.
    if (def && tags[def.tag[0]] !== def.tag[1]) continue;
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon === undefined || lat === undefined) continue;
    if (def?.reject?.(tags)) { dropped.rejected++; continue; }
    const name = tags.name ?? tags['name:en'];
    if (!name) { dropped.unnamed++; continue; }
    if (!booleanPointInPolygon([lon, lat], within)) { dropped.outside++; continue; }
    // OSM often carries both a node and an enclosing way for one place.
    const dedup = `${name.toLowerCase()}|${lon.toFixed(3)}|${lat.toFixed(3)}`;
    if (seen.has(dedup)) { dropped.duplicates++; continue; }
    seen.add(dedup);
    const id = `${key}-${el.id}`;
    features.push({ type: 'Feature', id, properties: { id, name: name.slice(0, 80) }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  }
  return { features, dropped };
}

export async function fetchPois(key: string, boundary: Polygon, onWait?: (s: number) => void) {
  if (!POI_DEFS[key]) throw new Error(`There is no OpenStreetMap query for “${key}”.`);
  return parsePois(key, (await fetchBoard(boundary, onWait)).pois, boundary);
}

/**
 * Every category at once. The pipeline asked twelve times, once per
 * category, from a laptop with a cache and all night to retry; a browser
 * doing that trips Overpass's rate limit by the fifth. The board's one
 * request carries the union, sorted by tag here.
 */
export async function fetchAllPois(boundary: Polygon, onWait?: (s: number) => void) {
  const { pois } = await fetchBoard(boundary, onWait);
  return Object.fromEntries(Object.keys(POI_DEFS).map((key) => [key, parsePois(key, pois, boundary)]));
}

// -------------------------------------------------------------------- stations

function modesOf(tags: Record<string, string>): Mode[] {
  const m = new Set<Mode>();
  if (tags.amenity === 'ferry_terminal' || tags.ferry === 'yes') m.add('ferry');
  if (tags.railway === 'tram_stop' || tags.tram === 'yes' || tags.light_rail === 'yes' || tags.subway === 'yes' || tags.station === 'subway' || tags.station === 'light_rail') m.add('metro');
  if ((tags.railway === 'station' || tags.railway === 'halt') && !m.has('metro')) m.add('rail');
  if (tags.train === 'yes') m.add('rail');
  if (tags.highway === 'bus_stop' || tags.bus === 'yes' || tags.trolleybus === 'yes') m.add('bus');
  if (m.size === 0) m.add(tags.public_transport === 'station' ? 'rail' : 'bus');
  return [...m];
}

const MODE_RANK: Record<Mode, number> = { rail: 0, metro: 1, cablecar: 2, ferry: 3, bus: 4 };

/**
 * Transit stops as hiding stations. One stop on the ground is usually
 * several OSM nodes — a platform each way, an entrance, the station itself —
 * so same-named stops within 150 m are folded into one, at their average
 * position, with every mode any of them had.
 *
 * This is the short form of step 02. It does not recover route lists, and it
 * knows nothing of a city's own quirks (San Francisco's cable cars are tagged
 * as trams); stations can be corrected by hand afterwards.
 */
export function parseStations(elements: Element[], boundary: Polygon): { stations: MapStation[]; dropped: Dropped } {
  const within = boundaryFeature(boundary);
  const dropped: Dropped = { unnamed: 0, outside: 0, rejected: 0, duplicates: 0 };
  const raw: { name: string; lon: number; lat: number; modes: Mode[] }[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon === undefined || lat === undefined) continue;
    const name = tags.name ?? tags['name:en'];
    if (!name) { dropped.unnamed++; continue; }
    if (!booleanPointInPolygon([lon, lat], within)) { dropped.outside++; continue; }
    raw.push({ name: name.slice(0, 80), lon, lat, modes: modesOf(tags) });
  }
  if (!raw.length) return { stations: [], dropped };

  const proj = projectionAt(raw[0].lon, raw[0].lat);
  const groups: { name: string; xs: number[]; ys: number[]; modes: Set<Mode> }[] = [];
  const byName = new Map<string, typeof groups>();
  for (const r of raw) {
    const [x, y] = proj.toUTM([r.lon, r.lat]);
    const key = r.name.toLowerCase();
    const candidates = byName.get(key) ?? [];
    const near = candidates.find((g) => Math.hypot(g.xs[0] - x, g.ys[0] - y) < 150);
    if (near) {
      near.xs.push(x);
      near.ys.push(y);
      r.modes.forEach((m) => near.modes.add(m));
      dropped.duplicates++;
    } else {
      const g = { name: r.name, xs: [x], ys: [y], modes: new Set(r.modes) };
      groups.push(g);
      byName.set(key, [...candidates, g]);
    }
  }

  const used = new Set<string>();
  const stations = groups.map((g): MapStation => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const [lon, lat] = proj.toLngLat([mean(g.xs), mean(g.ys)]);
    const base = slugId(g.name);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return {
      id,
      name: g.name,
      lon: Math.round(lon * 1e6) / 1e6,
      lat: Math.round(lat * 1e6) / 1e6,
      modes: [...g.modes].sort((a, b) => MODE_RANK[a] - MODE_RANK[b]),
      routes: [],
    };
  });
  return { stations, dropped };
}

/**
 * At most `max` stations, spread as evenly as the board allows.
 *
 * A city's bus stops alone can run to thousands; a map takes 600. Dropping
 * the overflow by list order would leave whole neighbourhoods with no zone,
 * so this keeps, one at a time, whichever station is farthest from every
 * station kept so far (farthest-point sampling, in the board's UTM plane).
 * Rail, metro, tram and ferry stops go first — the game is played at them —
 * and bus stops fill the gaps between. What is kept stays in its original
 * order, so ids and folding are unchanged. O(n × max): milliseconds for
 * tens of thousands of stops.
 */
export function spaceOut(stations: MapStation[], max: number): MapStation[] {
  const n = stations.length;
  if (n <= max) return stations;
  const proj = projectionAt(stations[0].lon, stations[0].lat);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  stations.forEach((s, i) => { [xs[i], ys[i]] = proj.toUTM([s.lon, s.lat]); });
  // 0: rail, metro, tram or ferry — kept first. 1: bus only.
  const tier = new Uint8Array(n);
  stations.forEach((s, i) => { tier[i] = s.modes.some((m) => m !== 'bus') ? 0 : 1; });
  // Squared distance from each station to the nearest one kept.
  const gap = new Float64Array(n).fill(Infinity);
  const kept = new Uint8Array(n);

  // The first pick has nothing to be far from: take the most central.
  const central = (upTo: number) => {
    let mx = 0, my = 0, m = 0;
    for (let i = 0; i < n; i++) if (tier[i] <= upTo) { mx += xs[i]; my += ys[i]; m++; }
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (xs[i] - mx / m) ** 2 + (ys[i] - my / m) ** 2;
      if (tier[i] <= upTo && d < bestD) { best = i; bestD = d; }
    }
    return best;
  };
  const farthest = (upTo: number) => {
    let best = -1;
    for (let i = 0; i < n; i++) if (!kept[i] && tier[i] <= upTo && (best < 0 || gap[i] > gap[best])) best = i;
    return best;
  };
  // Keeps one, and finds the next in the same pass that updates the gaps.
  const keep = (i: number, upTo: number) => {
    kept[i] = 1;
    const x = xs[i], y = ys[i];
    let best = -1, bestGap = -1;
    for (let j = 0; j < n; j++) {
      const dx = xs[j] - x, dy = ys[j] - y;
      const d = dx * dx + dy * dy;
      if (d < gap[j]) gap[j] = d;
      if (!kept[j] && tier[j] <= upTo && gap[j] > bestGap) { best = j; bestGap = gap[j]; }
    }
    return best;
  };

  let upTo = tier.includes(0) ? 0 : 1;
  let next = central(upTo);
  for (let count = 0; count < max; ) {
    if (next < 0) {
      if (upTo === 1) break;
      upTo = 1; // every rail stop is in; bus stops fill the gaps
      next = farthest(upTo);
      continue;
    }
    next = keep(next, upTo);
    count++;
  }
  return stations.filter((_, i) => kept[i]);
}

export async function fetchStations(boundary: Polygon, withBuses: boolean, onWait?: (s: number) => void) {
  const { stations } = await fetchBoard(boundary, onWait);
  return parseStations(withBuses ? stations : stations.filter((el) => isStation(el.tags ?? {})), boundary);
}

// ----------------------------------------------------------------- line layers

/** Step 05: one geometry per transit line, kept only if it actually touches the board. */
export function parseTransitLines(elements: Element[], boundary: Polygon): LayerFeature[] {
  const within = boundaryFeature(boundary);
  const seen = new Set<string>();
  const lines: LayerFeature[] = [];
  for (const rel of elements) {
    const t = rel.tags ?? {};
    const ref = t.ref ?? t.name;
    if (!ref || seen.has(ref)) continue; // one per line, not per direction
    const parts: Position[][] = [];
    for (const m of rel.members ?? []) {
      if (m.type !== 'way' || !m.geometry) continue;
      // Clipping leaves gaps; each unbroken run is its own part.
      let run: Position[] = [];
      for (const g of [...m.geometry, null]) {
        if (g) { run.push([g.lon, g.lat]); continue; }
        if (run.length >= 2) parts.push(run);
        run = [];
      }
    }
    const inside = parts.flat().filter((c) => booleanPointInPolygon(c, within));
    if (inside.length < 2) continue;
    seen.add(ref);
    const id = `line-${ref}`;
    lines.push({ type: 'Feature', id, properties: { id, name: (t.name ?? ref).slice(0, 80) }, geometry: { type: 'MultiLineString', coordinates: parts } });
  }
  return lines;
}

export async function fetchTransitLines(boundary: Polygon, onWait?: (s: number) => void) {
  return parseTransitLines((await fetchBoard(boundary, onWait)).lines, boundary);
}

/** Mapped coastline inside the board's bounding box, for a city that is not all shore. */
export function parseCoastline(elements: Element[]): LayerFeature[] {
  return elements
    .filter((el) => el.type === 'way' && (el.geometry?.length ?? 0) >= 2)
    .map((el) => {
      const id = `coast-${el.id}`;
      return { type: 'Feature', id, properties: { id, name: 'Coastline' }, geometry: { type: 'LineString', coordinates: el.geometry!.map((g) => [g.lon, g.lat]) } } as LayerFeature;
    });
}

export async function fetchCoastline(boundary: Polygon, onWait?: (s: number) => void) {
  return parseCoastline((await fetchBoard(boundary, onWait)).coastline);
}
