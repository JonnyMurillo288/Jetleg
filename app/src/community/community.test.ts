import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import type { GameData } from '../data/load';
import type { AskEntry, Boundary, Station } from '../engine/types';
import { evaluate, previewSplit } from '../engine/candidates';
import { QUESTIONS, QUESTIONS_BY_ID } from '../engine/questions';
import { applyMap, checkMap } from './board';
import {
  MAX_STATIONS,
  describeDiff,
  diffStations,
  mapFromBoard,
  mapFromGeoJSON,
  parseMapFile,
  readMapText,
  serializeMap,
} from './format';

const DATA = join(__dirname, '../../public/data');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const stations = read<{ stations: Station[] }>('stations.json').stations;
const boundary = read<FeatureCollection>('boundary.geojson').features[0] as Boundary;
const base = { boundary, stations, zones: read<FeatureCollection>('zones.geojson'), layers: {} } as unknown as GameData;

const shipped = mapFromBoard(stations, { gameSize: 'medium' }, 'Shipped board', 'sf');

describe('map file', () => {
  it('round-trips through its own serialization, byte for byte', () => {
    const text = serializeMap(shipped);
    const back = parseMapFile(JSON.parse(text));
    expect(back.ok).toBe(true);
    if (back.ok) expect(serializeMap(back.map)).toBe(text);
  });

  it('rejects what it should', () => {
    const doc = JSON.parse(serializeMap(shipped));
    expect(parseMapFile({ ...doc, format: 'something-else' }).ok).toBe(false);
    expect(parseMapFile({ ...doc, name: '  ' }).ok).toBe(false);
    expect(parseMapFile({ ...doc, stations: [] }).ok).toBe(false);
    expect(parseMapFile({ ...doc, stations: [{ name: 'A', lon: 'x', lat: 1 }, doc.stations[0]] }).ok).toBe(false);
    expect(parseMapFile({ ...doc, stations: Array(MAX_STATIONS + 1).fill(doc.stations[0]) }).ok).toBe(false);
    expect(readMapText('not json', 'x', 'sf').ok).toBe(false);
  });

  it('names a newer format for what it is, rather than "invalid"', () => {
    const doc = JSON.parse(serializeMap(shipped));
    const newer = parseMapFile({ ...doc, formatVersion: 2 });
    expect(!newer.ok && /newer version/.test(newer.error)).toBe(true);
    const odd = parseMapFile({ ...doc, kind: 'hexgrid' });
    expect(!odd.ok && /kind/.test(odd.error)).toBe(true);
  });

  it('gives duplicate names distinct ids', () => {
    const doc = JSON.parse(serializeMap(shipped));
    const twin = { name: 'Same Stop', lon: -122.42, lat: 37.77 };
    const parsed = parseMapFile({ ...doc, stations: [twin, { ...twin, lat: 37.78 }] });
    expect(parsed.ok && parsed.map.stations.map((s) => s.id)).toEqual(['samestop', 'samestop2']);
  });

  it('reads bare GeoJSON points as stations', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { stop_name: 'Castro' }, geometry: { type: 'Point', coordinates: [-122.435, 37.7625] } },
        { type: 'Feature', properties: { name: 'Church' }, geometry: { type: 'Point', coordinates: [-122.4287, 37.7672] } },
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      ],
    };
    const parsed = mapFromGeoJSON(fc, 'Upper Market', 'sf');
    expect(parsed.ok && parsed.map.stations.map((s) => s.name)).toEqual(['Castro', 'Church']);
    expect(readMapText(JSON.stringify(fc), 'Upper Market', 'sf').ok).toBe(true);
  });

  it('describes what a new version changed', () => {
    const after = shipped.stations.slice(1).map((s, i) => (i === 0 ? { ...s, lat: s.lat + 0.001 } : s));
    after.push({ id: 'brandnew', name: 'Brand New', lon: -122.42, lat: 37.77, modes: ['bus'], routes: [] });
    expect(describeDiff(diffStations(shipped.stations, after))).toBe('1 added, 1 removed, 1 moved');
  });
});

describe('playing a map', () => {
  it('accepts the shipped board as a map', () => {
    expect(checkMap(shipped, boundary).filter((p) => p.blocking)).toEqual([]);
  });

  it('blocks a station outside the boundary, and a map for another city', () => {
    const adrift = { ...shipped, stations: [...shipped.stations, { ...shipped.stations[0], id: 'farallon', name: 'Farallon', lon: -123.0, lat: 37.7 }] };
    expect(checkMap(adrift, boundary).some((p) => p.blocking && /outside/.test(p.text))).toBe(true);
    expect(checkMap({ ...shipped, city: 'nyc' }, boundary).some((p) => p.blocking)).toBe(true);
  });

  it('draws one zone per station, the engine’s own circle', () => {
    const small = { ...shipped, stations: shipped.stations.slice(0, 12) };
    const board = applyMap(base, small);
    expect(board.stations).toHaveLength(12);
    expect(board.zones.features).toHaveLength(12);
    expect(board.stations[0].nameLength).toBe(board.stations[0].name.length);
    // Same geometry the pipeline wrote for this station on the shipped board.
    const shippedZone = base.zones.features.find((f) => f.properties?.id === small.stations[0].id)!;
    const [x, y] = (board.zones.features[0].geometry as any).coordinates[0][10];
    const [sx, sy] = (shippedZone.geometry as any).coordinates[0][10];
    expect(Math.abs(x - sx)).toBeLessThan(1e-6);
    expect(Math.abs(y - sy)).toBeLessThan(1e-6);
  });

  /**
   * The engine's caches were keyed on a station's id, and on how many
   * stations there were. Both hold for one fixed board and neither holds
   * once a map can be swapped in: this is the same number of stations, the
   * same ids, one of them moved across the city.
   */
  it('judges a swapped-in station by where it is on *this* map', () => {
    const radar = QUESTIONS.find((q) => q.category === 'radar' && q.distanceM === 1000)
      ?? QUESTIONS.find((q) => q.category === 'radar' && !!q.distanceM)!;
    const target = stations[0];
    const far = stations.reduce((a, b) =>
      (Math.hypot(b.lon - target.lon, b.lat - target.lat) > Math.hypot(a.lon - target.lon, a.lat - target.lat) ? b : a));
    const ask: AskEntry = {
      id: 'a1', questionId: radar.id, askedAt: 0,
      origin: [target.lon, target.lat], distanceM: radar.distanceM,
      answer: { kind: 'yesno', value: 'yes' },
    };

    const before = evaluate(stations, [ask], QUESTIONS_BY_ID, {}, boundary, 'strict');
    expect(before.alive.some((s) => s.id === target.id)).toBe(true);

    // Same id, same count — now standing where the farthest station is.
    const moved = applyMap(base, {
      ...shipped,
      stations: shipped.stations.map((s) => (s.id === target.id ? { ...s, lon: far.lon + 0.0005, lat: far.lat } : s)),
    });
    for (const strictness of ['strict', 'conservative'] as const) {
      const after = evaluate(moved.stations, [ask], QUESTIONS_BY_ID, {}, boundary, strictness);
      expect(after.alive.some((s) => s.id === target.id)).toBe(false);
    }
    // And the original board is still judged as itself afterwards.
    const again = evaluate(stations, [ask], QUESTIONS_BY_ID, {}, boundary, 'conservative');
    expect(again.alive.some((s) => s.id === target.id)).toBe(true);
  });

  it('previews a split for every station asked about, not just the first set seen', () => {
    const parks = { key: 'parks', label: 'Parks', kind: 'point' as const, features: read<FeatureCollection>('poi-parks.geojson').features };
    const q = QUESTIONS.find((x) => x.category === 'measuring' && x.layer === 'parks')!;
    const origin: [number, number] = [stations[0].lon, stations[0].lat];
    const few = previewSplit(q, origin, stations.slice(0, 5), { parks } as any)!;
    const all = previewSplit(q, origin, stations, { parks } as any)!;
    expect(few.yes + few.no).toBe(5);
    expect(all.yes + all.no).toBe(stations.length);
    // Every station has a real nearest park; none may be silently missing.
    const none = previewSplit(q, [-122.3, 37.9], stations, { parks } as any)!;
    expect(none.yes).toBeGreaterThan(0);
  });
});
