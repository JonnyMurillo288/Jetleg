import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection, Polygon } from 'geojson';
import type { GameData } from '../data/load';
import type { AskEntry, Boundary, Station } from '../engine/types';
import { ZONE_RADIUS_M, evaluate, zoneRadius } from '../engine/candidates';
import { QUESTIONS_BY_ID } from '../engine/questions';
import { enterBoard } from '../engine/reset';
import { applyMap, radiusOf } from './board';
import { mapFromBoard, parseMapFile, serializeMap } from './format';

const DATA = join(__dirname, '../../public/data');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const stations = read<{ stations: Station[] }>('stations.json').stations;
const boundary = read<FeatureCollection>('boundary.geojson').features[0] as Boundary;
const bbox = read<[number, number, number, number]>('bbox.json');
const base = { boundary, bbox, stations, zones: read<FeatureCollection>('zones.geojson'), layers: {}, voronoi: {}, districts: { type: 'FeatureCollection', features: [] }, zoneRadiusM: ZONE_RADIUS_M } as unknown as GameData;

const haversine = (a: number[], b: number[]) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};

afterAll(() => enterBoard(bbox));

describe('a map’s own hiding-zone radius', () => {
  it('is kept in the file, clamped to sense, and left out when it is the default', () => {
    const map = mapFromBoard(stations, { zoneRadiusM: 800 }, 'Wide zones', 'sf');
    const round = parseMapFile(JSON.parse(serializeMap(map)));
    expect(round.ok && round.map.rules.zoneRadiusM).toBe(800);
    const silly = parseMapFile({ ...JSON.parse(serializeMap(map)), rules: { zoneRadiusM: 99999 } });
    expect(silly.ok && silly.map.rules.zoneRadiusM).toBe(2000);
    const plain = mapFromBoard(stations, {}, 'Plain', 'sf');
    expect(serializeMap(plain)).not.toContain('zoneRadiusM');
    expect(radiusOf(plain)).toBe(500);
  });

  it('draws every zone at that radius', () => {
    const board = applyMap(base, mapFromBoard(stations, { zoneRadiusM: 800 }, 'Wide zones', 'sf'));
    expect(board.zoneRadiusM).toBe(800);
    for (const f of board.zones.features.slice(0, 20)) {
      const s = stations.find((x) => x.id === f.properties!.id)!;
      const ring = (f.geometry as Polygon).coordinates[0];
      for (const p of ring.slice(0, 8)) expect(Math.abs(haversine([s.lon, s.lat], p) - 800)).toBeLessThan(2);
    }
  });

  it('decides elimination at that radius, and never reuses another radius’s verdicts', () => {
    // Radar 1 km "no" from Civic Center, judged by whole zones: a wider zone
    // reaches further into the ruled-out disk, so fewer zones lie wholly in it.
    const ask: AskEntry = { id: 'r', questionId: 'radar-1000', askedAt: 0, origin: [-122.4194, 37.7793], answer: { kind: 'yesno', value: 'no' } };
    const alive = (r: number) => {
      enterBoard(bbox, r);
      expect(zoneRadius()).toBe(r);
      return evaluate(stations, [ask], QUESTIONS_BY_ID, {}, boundary, 'conservative').alive.length;
    };
    const at500 = alive(500);
    const at250 = alive(250);
    const again500 = alive(500);
    expect(at250).toBeLessThan(at500);
    expect(again500).toBe(at500);
  });
});
