import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection, Polygon } from 'geojson';
import type { GameData } from '../data/load';
import { LAYER_DEFS, VORONOI_KEYS } from '../data/layers';
import type { AskEntry, Boundary, PoiLayer, Station } from '../engine/types';
import { evaluate } from '../engine/candidates';
import { QUESTIONS, QUESTIONS_BY_ID } from '../engine/questions';
import { enterBoard } from '../engine/reset';
import { applyMap, checkMap } from './board';
import { parseMapFile, serializeMap, type PackMap } from './format';
import { parsePois, parseStations, parseTransitLines } from './osm';
import {
  auditPack,
  boundaryStats,
  clipToBoundary,
  coastlineFromBoundary,
  finalizePack,
  largestLandmass,
  newPack,
  packFromBoard,
  polygonFromTaps,
  simplifyBoundary,
} from './pack';

const DATA = join(__dirname, '../../public/data');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const tryRead = (f: string): FeatureCollection => { try { return read(f); } catch { return { type: 'FeatureCollection', features: [] }; } };

/** The shipped board, assembled the way data/load.ts does it. */
function shippedBoard(): GameData {
  const layers: Record<string, PoiLayer> = {};
  for (const d of LAYER_DEFS) layers[d.key] = { key: d.key, label: d.label, kind: d.kind, features: tryRead(d.file).features as any };
  const voronoi: Record<string, FeatureCollection> = {};
  for (const k of VORONOI_KEYS) {
    voronoi[k] = tryRead(`voronoi-${k}.geojson`);
    if (voronoi[k].features.length) layers[k].cells = voronoi[k];
  }
  return {
    boundary: read<FeatureCollection>('boundary.geojson').features[0] as Boundary,
    bbox: read('bbox.json'),
    stations: read<{ stations: Station[] }>('stations.json').stations,
    zones: read('zones.geojson'),
    districts: read('districts.geojson'),
    layers,
    voronoi,
  };
}

const base = shippedBoard();
const sfPack = packFromBoard(base, 'San Francisco', 'sf', { gameSize: 'medium' });

describe('a full city pack', () => {
  it('round-trips through its own serialization', () => {
    const text = serializeMap(sfPack);
    const back = parseMapFile(JSON.parse(text));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.map.kind).toBe('pack');
      expect(serializeMap(back.map)).toBe(serializeMap(parseMapFile(JSON.parse(serializeMap(back.map))).ok ? back.map : sfPack));
      expect((back.map as PackMap).layers.parks.length).toBe(base.layers.parks.features.length);
    }
  });

  it('rejects a pack with no boundary, a bad layer, or a cell with no id', () => {
    const doc = JSON.parse(serializeMap(sfPack));
    expect(parseMapFile({ ...doc, boundary: undefined }).ok).toBe(false);
    expect(parseMapFile({ ...doc, boundary: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }).ok).toBe(false);
    const lineInPoints = parseMapFile({ ...doc, layers: { parks: [{ type: 'Feature', properties: { name: 'x' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }] } });
    expect(!lineInPoints.ok && /Parks/.test(lineInPoints.error)).toBe(true);
    const noId = parseMapFile({ ...doc, voronoi: { parks: [{ type: 'Feature', properties: {}, geometry: doc.boundary }] } });
    expect(!noId.ok && /no id/.test(noId.error)).toBe(true);
  });

  /**
   * The claim a pack makes: it *is* the board. San Francisco played as a
   * pack must eliminate exactly the zones San Francisco as shipped does,
   * for every kind of question — matching (which reads the cells),
   * measuring (the layers), radar and thermometer (the boundary).
   */
  it('plays San Francisco identically to the shipped board', () => {
    const packed = applyMap(base, sfPack);
    const origin: [number, number] = [-122.4194, 37.7793];
    const pick = (category: string, layer?: string) =>
      QUESTIONS.find((q) => q.category === category && (!layer || q.layer === layer) && q.sizes.includes('medium'))!;
    const asks: AskEntry[] = [
      { id: 'm', questionId: pick('matching', 'libraries').id, askedAt: 0, origin, answer: { kind: 'yesno', value: 'no' } },
      { id: 'd', questionId: pick('measuring', 'parks').id, askedAt: 0, origin, answer: { kind: 'closerFurther', value: 'closer' } },
      { id: 'r', questionId: QUESTIONS.find((q) => q.category === 'radar' && !!q.distanceM && q.distanceM >= 2000)!.id, askedAt: 0, origin, answer: { kind: 'yesno', value: 'yes' } },
      { id: 't', questionId: pick('thermometer').id, askedAt: 0, origin, destination: [-122.44, 37.76], answer: { kind: 'hotterColder', value: 'hotter' } },
    ];
    for (const strictness of ['conservative', 'strict'] as const) {
      for (const n of [1, 4]) {
        enterBoard(base.bbox);
        const a = evaluate(base.stations, asks.slice(0, n), QUESTIONS_BY_ID, base.layers, base.boundary, strictness);
        enterBoard(packed.bbox);
        const b = evaluate(packed.stations, asks.slice(0, n), QUESTIONS_BY_ID, packed.layers, packed.boundary, strictness);
        expect(b.alive.map((s) => s.id)).toEqual(a.alive.map((s) => s.id));
        // The comparison means something only if the questions bite.
        if (n === 4) expect(a.alive.length).toBeLessThan(base.stations.length / 2);
      }
    }
  });

  it('is a board of its own: nothing of San Francisco leaks into another city', () => {
    const square: Polygon = { type: 'Polygon', coordinates: [[[151.14, -33.93], [151.27, -33.93], [151.27, -33.82], [151.14, -33.82], [151.14, -33.93]]] };
    const sydney = newPack('Sydney test', 'sydney', square);
    sydney.stations = [
      { id: 'central', name: 'Central', lon: 151.2069, lat: -33.8832, modes: ['rail'], routes: [] },
      { id: 'townhall', name: 'Town Hall', lon: 151.2069, lat: -33.8736, modes: ['rail'], routes: [] },
      { id: 'bondijn', name: 'Bondi Junction', lon: 151.2475, lat: -33.8914, modes: ['rail', 'bus'], routes: [] },
      { id: 'busonly', name: 'Some Bus Stop', lon: 151.18, lat: -33.9, modes: ['bus'], routes: [] },
    ];
    sydney.layers.libraries = [[151.2113, -33.8663, 'State Library'], [151.1793, -33.8847, 'Glebe Library'], [151.2437, -33.8935, 'Waverley Library']]
      .map(([lon, lat, name]) => ({ type: 'Feature', id: `l-${name}`, properties: { id: `l-${name}`, name: String(name) }, geometry: { type: 'Point', coordinates: [lon as number, lat as number] } }));

    const { pack, notes } = finalizePack(sydney);
    expect(notes).toEqual([]);
    // Rail stations follow the stations that are not bus-only, as step 04 did.
    expect(pack.layers.railStations.map((f) => f.properties.name)).toEqual(['Central', 'Town Hall', 'Bondi Junction']);
    expect(pack.voronoi.libraries).toHaveLength(3);
    expect(pack.voronoi.railStations).toHaveLength(3);
    expect(checkMap(pack, base.boundary).filter((p) => p.blocking)).toEqual([]);

    const board = applyMap(base, pack);
    expect(board.bbox[0]).toBeGreaterThan(150);
    expect(board.districts.features).toEqual([]);
    expect(board.layers.parks.features).toEqual([]);
    expect(board.layers.libraries.cells?.features).toHaveLength(3);
    expect(board.stations).toHaveLength(4);

    // And it plays: standing at Town Hall, "is your nearest library the same
    // as mine?" answered yes keeps Central and drops Bondi Junction.
    enterBoard(board.bbox);
    const q = QUESTIONS.find((x) => x.category === 'matching' && x.layer === 'libraries')!;
    const ask: AskEntry = { id: 'a', questionId: q.id, askedAt: 0, origin: [151.2069, -33.8736], answer: { kind: 'yesno', value: 'yes' } };
    const out = evaluate(board.stations, [ask], QUESTIONS_BY_ID, board.layers, board.boundary, 'strict');
    expect(out.alive.map((s) => s.id).sort()).toEqual(['central', 'townhall']);
    enterBoard(base.bbox);
  });

  it('keeps hand-made cells as given, and says when they match nothing', () => {
    const stray = { ...sfPack.voronoi.libraries[0], properties: { id: 'not-an-aquarium', name: 'x', layer: 'aquariums' } };
    const pack = { ...sfPack, voronoi: { ...sfPack.voronoi, aquariums: [stray] }, customVoronoi: ['aquariums'] };
    const started = Date.now();
    const done = finalizePack(pack as PackMap);
    expect(done.pack.voronoi.aquariums[0].properties.id).toBe('not-an-aquarium');
    expect(done.notes.some((n) => /aquariums: 1 hand-made cell/.test(n))).toBe(true);
    expect(done.notes.some((n) => /aquariums: 2 points have no hand-made cell/.test(n))).toBe(true);
    // Every other layer was rebuilt from its points, and matches what shipped.
    expect(done.pack.voronoi.parks.length).toBe(sfPack.voronoi.parks.length);
    // Rebuilding a whole San Francisco must stay something a person will wait for.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('audits what each layer does to the questions', () => {
    const audit = auditPack(sfPack);
    const by = Object.fromEntries(audit.layers.map((a) => [a.key, a]));
    expect(by.amusementParks.verdict).toMatch(/null/);
    expect(by.zoos.verdict).toMatch(/always/);
    expect(by.parks.verdict).toBe('in play');
    expect(audit.tooBig).toBe(false);
    expect(audit.bytes).toBeGreaterThan(500_000);
  });
});

describe('boundary tools', () => {
  it('keeps the largest landmass and counts what it dropped', () => {
    const big = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
    const islet = [[[2, 2], [2.01, 2], [2.01, 2.01], [2, 2.01], [2, 2]]];
    const out = largestLandmass({ type: 'MultiPolygon', coordinates: [islet, big] });
    expect(out.dropped).toBe(1);
    expect(out.polygon.coordinates).toEqual(big);
  });

  it('simplifies without losing the outline', () => {
    const before = boundaryStats(sfPack.boundary);
    const after = boundaryStats(simplifyBoundary(sfPack.boundary, 20));
    expect(after.vertices).toBeLessThan(before.vertices / 2);
    expect(Math.abs(after.km2 - before.km2) / before.km2).toBeLessThan(0.01);
  });

  it('closes a tapped outline and refuses fewer than three corners', () => {
    expect(polygonFromTaps([[0, 0], [1, 0]])).toBeNull();
    expect(polygonFromTaps([[0, 0], [1, 0], [1, 1]])!.coordinates[0]).toHaveLength(4);
  });

  it('clips points to the boundary and makes a coastline of its edge', () => {
    const feats = [[-122.42, 37.77], [-123.5, 37.7]].map(([lon, lat], i) => ({ type: 'Feature' as const, id: `p${i}`, properties: { id: `p${i}`, name: `P${i}` }, geometry: { type: 'Point' as const, coordinates: [lon, lat] } }));
    expect(clipToBoundary(feats, sfPack.boundary)).toMatchObject({ outside: 1 });
    expect(coastlineFromBoundary(sfPack.boundary)[0].geometry.type).toBe('LineString');
  });
});

describe('reading OpenStreetMap', () => {
  const b = sfPack.boundary;
  it('applies the rulebook’s tests to places', () => {
    const { features, dropped } = parsePois('consulates', [
      { type: 'node', id: 1, lat: 37.79, lon: -122.42, tags: { office: 'diplomatic', name: 'Consulate of Somewhere' } },
      { type: 'node', id: 2, lat: 37.79, lon: -122.42, tags: { office: 'diplomatic', name: 'Consulate of Somewhere' } },
      { type: 'node', id: 3, lat: 37.78, lon: -122.41, tags: { office: 'diplomatic', name: 'Honorary One', diplomatic: 'honorary_consulate' } },
      { type: 'node', id: 4, lat: 37.78, lon: -122.43, tags: { office: 'diplomatic' } },
      { type: 'way', id: 5, center: { lat: 37.9, lon: -122.3 }, tags: { office: 'diplomatic', name: 'Across the Bay' } },
      { type: 'way', id: 6, center: { lat: 37.77, lon: -122.44 }, tags: { office: 'diplomatic', name: 'A Real Consulate' } },
      // From the same combined answer, but another category's: not counted here at all.
      { type: 'node', id: 7, lat: 37.77, lon: -122.43, tags: { amenity: 'library', name: 'A Library' } },
    ] as any, b);
    expect(features.map((f) => f.properties.name)).toEqual(['Consulate of Somewhere', 'A Real Consulate']);
    expect(dropped).toEqual({ unnamed: 1, outside: 1, rejected: 1, duplicates: 1 });
  });

  it('folds the nodes of one stop into one station, with all its modes', () => {
    const { stations, dropped } = parseStations([
      { type: 'node', id: 1, lat: 37.7793, lon: -122.4139, tags: { name: 'Civic Center', railway: 'station' } },
      { type: 'node', id: 2, lat: 37.7796, lon: -122.4142, tags: { name: 'Civic Center', highway: 'bus_stop' } },
      { type: 'node', id: 3, lat: 37.7955, lon: -122.3937, tags: { name: 'Ferry Building', amenity: 'ferry_terminal' } },
      { type: 'node', id: 4, lat: 37.76, lon: -122.47, tags: { name: 'Civic Center', highway: 'bus_stop' } },
      { type: 'node', id: 5, lat: 37.76, lon: -122.45, tags: { highway: 'bus_stop' } },
    ] as any, b);
    expect(stations.map((s) => [s.name, s.modes.join('+')])).toEqual([['Civic Center', 'rail+bus'], ['Ferry Building', 'ferry'], ['Civic Center', 'bus']]);
    expect(new Set(stations.map((s) => s.id)).size).toBe(3);
    expect(dropped.duplicates).toBe(1);
    expect(dropped.unnamed).toBe(1);
  });

  it('keeps one geometry per transit line, only if it touches the board', () => {
    const way = (pts: number[][]) => ({ type: 'way', geometry: pts.map(([lon, lat]) => ({ lon, lat })) });
    const lines = parseTransitLines([
      { type: 'relation', id: 1, tags: { ref: 'N', name: 'N Judah' }, members: [way([[-122.42, 37.77], [-122.45, 37.765]])] },
      { type: 'relation', id: 2, tags: { ref: 'N', name: 'N Judah (inbound)' }, members: [way([[-122.45, 37.765], [-122.42, 37.77]])] },
      { type: 'relation', id: 3, tags: { ref: 'BART-far' }, members: [way([[-121.9, 37.5], [-121.8, 37.4]])] },
    ] as any, b);
    expect(lines.map((l) => l.properties.id)).toEqual(['line-N']);
  });
});
