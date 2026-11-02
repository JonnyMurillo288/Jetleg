import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Polygon } from 'geojson';
import type { MapStation } from './format';
import { fetchAllPois, fetchStations, overpass, spaceOut } from './osm';

/**
 * The fetching half against a stand-in for Overpass: which mirror is asked,
 * when the next is tried, and that one request serves every tool.
 */

const square = (w: number, s: number, e: number, n: number): Polygon => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const node = (id: number, lon: number, lat: number, tags: Record<string, string>) => ({ type: 'node', id, lon, lat, tags });
const section = (name: string) => ({ type: 'section', id: 1, tags: { name } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('overpass', () => {
  it('moves to the next mirror at once when one is at capacity', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url);
      return asked.length === 1 ? new Response('at capacity', { status: 502 }) : json({ elements: [node(1, 0, 0, {})] });
    }));
    const t = Date.now();
    expect(await overpass('q')).toHaveLength(1);
    expect(new Set(asked).size).toBe(2);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('refuses a partial answer that Overpass marked as a runtime error', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? json({ elements: [node(1, 0, 0, {})], remark: 'runtime error: Query timed out in "query" at line 1 after 181 seconds.' })
      : json({ elements: [node(1, 0, 0, {}), node(2, 0, 0, {})] }))));
    expect(await overpass('q')).toHaveLength(2);
  });

  it('asks a second mirror alongside one that has gone quiet, and takes whichever answers', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      asked.push(url);
      if (asked.length === 1) {
        // Accepts the connection and never replies, until cancelled.
        return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return Promise.resolve(json({ elements: [] }));
    }));
    const answer = overpass('q');
    await vi.advanceTimersByTimeAsync(44_000);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await answer).toEqual([]);
    expect(asked).toHaveLength(2);
  });

  it('stops at a request Overpass cannot read rather than retrying it everywhere', async () => {
    const f = vi.fn(async () => new Response('parse error', { status: 400 }));
    vi.stubGlobal('fetch', f);
    await expect(overpass('nonsense')).rejects.toThrow(/400/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('the board', () => {
  it('is one request shared by every tool, and rail-only leaves bus stops out', async () => {
    const f = vi.fn(async () => json({
      elements: [
        node(11, 0.01, 0.01, { name: 'A Library', amenity: 'library' }),
        section('stations'),
        node(1, 0.02, 0.02, { name: 'Central', railway: 'station' }),
        node(2, 0.0201, 0.0201, { name: 'Central', highway: 'bus_stop' }),
        node(3, 0.05, 0.05, { name: 'Corner', highway: 'bus_stop' }),
        section('coastline'),
        section('lines'),
      ],
    }));
    vi.stubGlobal('fetch', f);
    const boundary = square(0, 0, 0.1, 0.1);
    const rail = await fetchStations(boundary, false);
    const all = await fetchStations(boundary, true);
    // A boundary inside the one fetched is answered from it too.
    const pois = await fetchAllPois(square(0.005, 0.005, 0.09, 0.09));
    expect(f).toHaveBeenCalledTimes(1);
    expect(rail.stations.map((s) => [s.name, s.modes.join('+')])).toEqual([['Central', 'rail']]);
    expect(all.stations.map((s) => [s.name, s.modes.join('+')])).toEqual([['Central', 'rail+bus'], ['Corner', 'bus']]);
    expect(pois.libraries.features.map((x) => x.properties.name)).toEqual(['A Library']);
  });

  it('forgets a failed fetch, so the next click asks again', async () => {
    vi.useFakeTimers();
    let up = false;
    const f = vi.fn(async () => (up ? json({ elements: [section('stations'), section('coastline'), section('lines')] }) : new Response('', { status: 504 })));
    vi.stubGlobal('fetch', f);
    const boundary = square(10, 10, 10.1, 10.1);
    const failed = expect(fetchStations(boundary, true)).rejects.toThrow(/not answering/);
    await vi.runAllTimersAsync();
    await failed;
    up = true;
    expect((await fetchStations(boundary, true)).stations).toEqual([]);
  });
});

describe('spaceOut', () => {
  // A deterministic scatter over roughly 20 × 20 km of San Francisco-ish ground.
  const scatter = (n: number, seed = 1): MapStation[] => {
    let r = seed;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, name: `Stop ${i}`, lon: -122.5 + rand() * 0.22, lat: 37.7 + rand() * 0.18,
      modes: i % 25 === 0 ? ['rail'] : ['bus'], routes: [],
    }));
  };
  // Metres between each kept station and its nearest kept neighbour, smallest first.
  const spacing = (s: MapStation[]) => s.map((a) => Math.min(...s.filter((b) => b !== a).map((b) =>
    Math.hypot((a.lon - b.lon) * 88_000, (a.lat - b.lat) * 111_000)))).sort((x, y) => x - y);

  it('leaves a map under the cap alone', () => {
    const s = scatter(100);
    expect(spaceOut(s, 600)).toBe(s);
  });

  it('pares down to the cap, keeping every rail stop and spreading the rest', () => {
    const all = scatter(5000);
    const kept = spaceOut(all, 600);
    expect(kept).toHaveLength(600);
    expect(all.filter((s) => s.modes.includes('rail')).every((s) => kept.includes(s))).toBe(true);
    // Original order, so nothing downstream sees a reshuffle.
    expect(kept.map((s) => all.indexOf(s))).toEqual([...kept.map((s) => all.indexOf(s))].sort((a, b) => a - b));
    // Even: the closest pair is far further apart than in the first 600 by list order.
    expect(spacing(kept)[0]).toBeGreaterThan(5 * spacing(all.slice(0, 600))[0]);
  });

  it('is quick on a whole metro area of stops', () => {
    const all = scatter(30_000, 7);
    const t = performance.now();
    expect(spaceOut(all, 600)).toHaveLength(600);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
