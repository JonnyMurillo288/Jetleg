import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { QUESTIONS, QUESTIONS_BY_ID } from './questions';
import { evaluate, resolveAsk, ZONE_RADIUS_M } from './candidates';
import { planCandidate } from './plan';
import { thermometerRegion, nearestFeature, measuringRegion } from './regions';
import { metres } from './project';
import type { AskEntry, Answer, Boundary, LngLat, PoiLayer, Station } from './types';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';

const DATA = new URL('../../public/data/', import.meta.url).pathname;
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

let boundary: Boundary;
let stations: Station[];
let layers: Record<string, PoiLayer>;

beforeAll(() => {
  boundary = read<FeatureCollection>('boundary.geojson').features[0] as Boundary;
  stations = read<{ stations: Station[] }>('stations.json').stations;

  const load = (key: string, file: string, kind: 'point' | 'line' = 'point'): PoiLayer => ({
    key, label: key, kind,
    features: read<FeatureCollection>(file).features as any,
  });

  layers = {
    parks: load('parks', 'poi-parks.geojson'),
    libraries: load('libraries', 'poi-libraries.geojson'),
    museums: load('museums', 'poi-museums.geojson'),
    hospitals: load('hospitals', 'poi-hospitals.geojson'),
    zoos: load('zoos', 'poi-zoos.geojson'),
    amusementParks: load('amusementParks', 'poi-amusement-parks.geojson'),
    aquariums: load('aquariums', 'poi-aquariums.geojson'),
    coastline: load('coastline', 'coastline.geojson', 'line'),
    railStations: load('railStations', 'rail-stations.geojson'),
  };
});

const ask = (questionId: string, origin: LngLat, answer: Answer, destination?: LngLat): AskEntry => ({
  id: `t-${questionId}-${Math.random()}`,
  questionId,
  askedAt: 0,
  origin,
  destination,
  answer,
});

const run = (asks: AskEntry[], strict: 'conservative' | 'strict' = 'conservative') =>
  evaluate(stations, asks, QUESTIONS_BY_ID, layers, boundary, strict);

// Civic Center, roughly.
const CIVIC: LngLat = [-122.4194, 37.7793];

describe('catalog', () => {
  it('has exactly the 80 questions the rulebook counts', () => {
    expect(QUESTIONS.length).toBe(80);
  });

  it('splits into the six categories with the right counts', () => {
    const by = (c: string) => QUESTIONS.filter((q) => q.category === c).length;
    expect(by('matching')).toBe(20);
    expect(by('measuring')).toBe(20);
    expect(by('radar')).toBe(10);
    expect(by('thermometer')).toBe(4);
    expect(by('photo')).toBe(18);
    expect(by('tentacle')).toBe(8);
  });

  it('bans tentacle questions in small games, per the rulebook', () => {
    const small = QUESTIONS.filter((q) => q.sizes.includes('small'));
    expect(small.some((q) => q.category === 'tentacle')).toBe(false);
  });
});

describe('projection', () => {
  it('measures a known SF distance correctly', () => {
    // Ferry Building to Civic Center is about 2.5 km.
    const d = metres([-122.3937, 37.7955], CIVIC);
    expect(d).toBeGreaterThan(2200);
    expect(d).toBeLessThan(2900);
  });

  it('does not distort north-south vs east-west', () => {
    // 0.01 degrees of latitude is ~1111 m anywhere.
    const ns = metres([-122.42, 37.77], [-122.42, 37.78]);
    expect(ns).toBeGreaterThan(1100);
    expect(ns).toBeLessThan(1120);
  });
});

describe('thermometer', () => {
  /**
   * The worked example from the brief: travel half a mile due north, ask hotter
   * or colder. The dividing line must run exactly east-west through the
   * midpoint, and "colder" must keep the southern half.
   */
  const HALF_MILE_DEG = 804.672 / 111_320;
  const start: LngLat = [-122.44, 37.75];
  const end: LngLat = [-122.44, 37.75 + HALF_MILE_DEG];
  const midLat = (start[1] + end[1]) / 2;

  it('puts the boundary at the midpoint, running east-west', () => {
    const colder = thermometerRegion(start, end, false, boundary)!;
    expect(colder).toBeTruthy();

    // A point just south of the midpoint is colder-side; just north is not.
    const justSouth = point([-122.44, midLat - 0.004]);
    const justNorth = point([-122.44, midLat + 0.004]);
    expect(booleanPointInPolygon(justSouth, colder as any)).toBe(true);
    expect(booleanPointInPolygon(justNorth, colder as any)).toBe(false);

    // East-west orientation: the cut must be at the same latitude far to the
    // east and west, which is what "perpendicular to a due-north move" means.
    for (const lon of [-122.50, -122.46, -122.42, -122.38]) {
      const south = point([lon, midLat - 0.006]);
      const north = point([lon, midLat + 0.006]);
      const inSouth = booleanPointInPolygon(south, colder as any);
      const inNorth = booleanPointInPolygon(north, colder as any);
      // Either the point is off the board entirely, or it obeys the split.
      if (inSouth || inNorth) {
        expect(inSouth).toBe(true);
        expect(inNorth).toBe(false);
      }
    }
  });

  it('keeps the northern half when hotter', () => {
    const hotter = thermometerRegion(start, end, true, boundary)!;
    expect(booleanPointInPolygon(point([-122.44, midLat + 0.004]), hotter as any)).toBe(true);
    expect(booleanPointInPolygon(point([-122.44, midLat - 0.004]), hotter as any)).toBe(false);
  });

  it('handles a diagonal move — the cut is perpendicular to travel, not axis-aligned', () => {
    const a: LngLat = [-122.46, 37.74];
    const b: LngLat = [-122.42, 37.78];
    const hotter = thermometerRegion(a, b, true, boundary)!;
    expect(booleanPointInPolygon(point(b), hotter as any)).toBe(true);
    expect(booleanPointInPolygon(point(a), hotter as any)).toBe(false);
  });
});

describe('radar', () => {
  /**
   * The containment rule. A zone straddling the radar edge must survive BOTH a
   * hit and a miss, because the hider may stand anywhere in their 500 m circle.
   * Getting this wrong eliminates the true zone and sends seekers across town.
   */
  it('keeps a straddling zone alive on either answer, conservatively', () => {
    const RADIUS = 2000;
    const straddler = stations.find((s) => {
      const d = metres(CIVIC, [s.lon, s.lat]);
      return Math.abs(d - RADIUS) < 200; // circle crosses the radar edge
    });
    expect(straddler, 'expected a station near the 2 km radar edge').toBeTruthy();

    const hit = run([ask('radar-2000', CIVIC, { kind: 'yesno', value: 'yes' })]);
    const miss = run([ask('radar-2000', CIVIC, { kind: 'yesno', value: 'no' })]);

    expect(hit.alive.map((s) => s.id)).toContain(straddler!.id);
    expect(miss.alive.map((s) => s.id)).toContain(straddler!.id);
  });

  it('still eliminates zones that are unambiguously outside on a hit', () => {
    const far = stations.find((s) => metres(CIVIC, [s.lon, s.lat]) > 4000)!;
    const hit = run([ask('radar-2000', CIVIC, { kind: 'yesno', value: 'yes' })]);
    expect(hit.alive.map((s) => s.id)).not.toContain(far.id);
  });

  it('strict mode narrows harder than conservative', () => {
    const a = ask('radar-2000', CIVIC, { kind: 'yesno', value: 'yes' });
    const cons = run([a], 'conservative').alive.length;
    const strict = run([a], 'strict').alive.length;
    expect(strict).toBeLessThanOrEqual(cons);
  });
});

describe('measuring', () => {
  it('builds the union-of-disks region and splits the board', () => {
    const m = measuringRegion(CIVIC, layers.libraries, boundary)!;
    expect(m).toBeTruthy();
    expect(m.radiusM).toBeGreaterThan(0);

    // The seeker's own position sits exactly on the boundary of that region,
    // so test a library itself: it must be inside the "closer" area.
    const lib = layers.libraries.features[0];
    expect(booleanPointInPolygon(lib as any, m.region as any)).toBe(true);
  });

  it('a "closer" answer always narrows the board', () => {
    const closer = run([ask('meas-library', CIVIC, { kind: 'closerFurther', value: 'closer' })]);
    expect(closer.alive.length).toBeGreaterThan(0);
    expect(closer.alive.length).toBeLessThan(stations.length);
  });

  /**
   * A consequence of the conservative rule that is easy to mistake for a bug.
   *
   * "Further" eliminates a zone only when the whole 500 m circle is provably
   * closer than the seeker. If the seeker is standing 320 m from a library —
   * as they are at Civic Center — the closer-region is a union of 320 m disks,
   * and no 500 m circle can fit inside one. So "further" correctly removes
   * nothing, and asking it from there is a wasted turn. The question-quality
   * indicator exists precisely to warn about this before you spend the ask.
   */
  it('“further” is uninformative when the seeker is closer to the feature than a zone radius', () => {
    const r = nearestFeature(CIVIC, layers.libraries)!.distanceM;
    expect(r).toBeLessThan(ZONE_RADIUS_M);

    const further = run([ask('meas-library', CIVIC, { kind: 'closerFurther', value: 'further' })]);
    expect(further.alive.length).toBe(stations.length);
  });

  it('“further” does narrow once the seeker is well clear of the feature', () => {
    // Deep in the Presidio the nearest library is about 1.9 km away, so the
    // closer-region is a union of 1.9 km disks and zones can sit inside them.
    const PRESIDIO: LngLat = [-122.4662, 37.7989];
    expect(nearestFeature(PRESIDIO, layers.libraries)!.distanceM).toBeGreaterThan(ZONE_RADIUS_M);

    const further = run([ask('meas-library', PRESIDIO, { kind: 'closerFurther', value: 'further' })]);
    expect(further.alive.length).toBeGreaterThan(0);
    expect(further.alive.length).toBeLessThan(stations.length);
  });
});

describe('matching', () => {
  it('resolves a point to the cell of its own nearest POI', () => {
    const lib = layers.libraries.features[3];
    const at = (lib.geometry as any).coordinates as LngLat;
    const near = nearestFeature(at, layers.libraries)!;
    // Standing on a library, the nearest library is that library.
    expect(near.feature.properties!.id).toBe(lib.properties!.id);
    expect(near.distanceM).toBeLessThan(1);
  });

  it('a yes answer keeps only zones near the seeker’s nearest park', () => {
    const yes = run([ask('match-park', CIVIC, { kind: 'yesno', value: 'yes' })]);
    const no = run([ask('match-park', CIVIC, { kind: 'yesno', value: 'no' })]);
    expect(yes.alive.length).toBeGreaterThan(0);
    expect(yes.alive.length).toBeLessThan(no.alive.length);
  });
});

describe('null answers', () => {
  it('amusement parks are genuinely absent from San Francisco', () => {
    expect(layers.amusementParks.features.length).toBe(0);
  });

  it('a null layer produces no region and eliminates nothing', () => {
    const r = resolveAsk(
      ask('match-amusement-park', CIVIC, { kind: 'yesno', value: 'yes' }),
      QUESTIONS_BY_ID['match-amusement-park'],
      layers,
      boundary,
    );
    expect(r.region).toBeNull();

    const after = run([ask('match-amusement-park', CIVIC, { kind: 'yesno', value: 'yes' })]);
    expect(after.alive.length).toBe(stations.length);
  });

  it('an explicit null answer eliminates nothing', () => {
    const after = run([ask('meas-park', CIVIC, { kind: 'null' })]);
    expect(after.alive.length).toBe(stations.length);
  });
});

describe('ask log', () => {
  const log = (): AskEntry[] => [
    ask('radar-5000', CIVIC, { kind: 'yesno', value: 'yes' }),
    ask('meas-library', CIVIC, { kind: 'closerFurther', value: 'closer' }),
    ask('match-park', CIVIC, { kind: 'yesno', value: 'no' }),
    ask('radar-2000', CIVIC, { kind: 'yesno', value: 'no' }),
    ask('meas-hospital', CIVIC, { kind: 'closerFurther', value: 'further' }),
  ];

  it('is order-independent and replay-stable', () => {
    const entries = log();
    const full = run(entries).alive.map((s) => s.id).sort();

    // Undo the last two, then re-apply: the same set must come back.
    const partial = run(entries.slice(0, 3));
    const restored = run([...entries.slice(0, 3), ...entries.slice(3)]).alive.map((s) => s.id).sort();
    expect(restored).toEqual(full);
    expect(partial.alive.length).toBeGreaterThanOrEqual(full.length);

    // Reordering answers cannot change the result — they are constraints, not steps.
    const shuffled = run([...entries].reverse()).alive.map((s) => s.id).sort();
    expect(shuffled).toEqual(full);
  });

  it('disabled entries stop constraining', () => {
    const entries = log();
    const constrained = run(entries).alive.length;
    const relaxed = run(entries.map((e) => ({ ...e, disabled: true }))).alive.length;
    expect(relaxed).toBe(stations.length);
    expect(constrained).toBeLessThan(relaxed);
  });
});

describe('property: a hider is never eliminated by their own truthful answers', () => {
  /**
   * The strongest check in the suite. For each station, generate the answers a
   * hider standing at that station would truthfully give, feed them in as a
   * seeker, and confirm that station is still standing. Any station that
   * eliminates itself is a bug in the geometry.
   */
  it('holds for every station on the board', () => {
    const seekerAt: LngLat = CIVIC;
    const failures: string[] = [];

    for (const st of stations) {
      const hider: LngLat = [st.lon, st.lat];
      const asks: AskEntry[] = [];

      // Radar: truthful yes/no at several ranges.
      for (const radius of [1000, 2000, 5000, 10000]) {
        const within = metres(seekerAt, hider) <= radius;
        asks.push(ask(`radar-${radius}`, seekerAt, { kind: 'yesno', value: within ? 'yes' : 'no' }));
      }

      // Measuring: truthful closer/further for a few layers.
      for (const [qid, key] of [['meas-library', 'libraries'], ['meas-park', 'parks'], ['meas-hospital', 'hospitals']] as const) {
        const mine = nearestFeature(seekerAt, layers[key])!.distanceM;
        const theirs = nearestFeature(hider, layers[key])!.distanceM;
        asks.push(ask(qid, seekerAt, { kind: 'closerFurther', value: theirs < mine ? 'closer' : 'further' }));
      }

      // Matching: truthful yes/no on nearest park and library.
      for (const [qid, key] of [['match-park', 'parks'], ['match-library', 'libraries']] as const) {
        const mine = nearestFeature(seekerAt, layers[key])!.feature.properties!.id;
        const theirs = nearestFeature(hider, layers[key])!.feature.properties!.id;
        asks.push(ask(qid, seekerAt, { kind: 'yesno', value: mine === theirs ? 'yes' : 'no' }));
      }

      // Thermometer: seeker walks 800 m north, answer computed truthfully.
      const end: LngLat = [seekerAt[0], seekerAt[1] + 800 / 111_320];
      const hotter = metres(end, hider) < metres(seekerAt, hider);
      asks.push(ask('thermo-1000', seekerAt, { kind: 'hotterColder', value: hotter ? 'hotter' : 'colder' }, end));

      const result = evaluate(stations, asks, QUESTIONS_BY_ID, layers, boundary, 'conservative');
      if (!result.alive.some((s) => s.id === st.id)) failures.push(`${st.id} (${st.name})`);
    }

    expect(failures, `these stations eliminated themselves:\n${failures.join('\n')}`).toEqual([]);
  }, 300_000);
});

/**
 * Scenario planning.
 *
 * The one property that matters: a preview must describe the question that
 * will actually be asked. A planning tool that draws a slightly different shape
 * from the answer's is worse than none, because it is believed.
 */
describe('scenario planning', () => {
  it('previews exactly the region the real answer would produce', () => {
    const q = QUESTIONS_BY_ID['radar-2000'];
    const preview = planCandidate(q, CIVIC, stations, layers, boundary);
    const real = resolveAsk(ask('radar-2000', CIVIC, { kind: 'yesno', value: 'yes' }), q, layers, boundary);

    expect(preview.region).not.toBeNull();
    expect(JSON.stringify(preview.region!.geometry)).toBe(JSON.stringify(real.region!.geometry));
  });

  it('reports a split that partitions the surviving zones', () => {
    const c = planCandidate(QUESTIONS_BY_ID['match-park'], CIVIC, stations, layers, boundary);
    expect(c.split).not.toBeNull();
    expect(c.split!.yes + c.split!.no).toBe(stations.length);
    expect(c.worst).toBe(Math.max(c.split!.yes, c.split!.no));
    expect(c.best).toBe(Math.min(c.split!.yes, c.split!.no));
    expect(c.worst!).toBeGreaterThanOrEqual(c.best!);
  });

  it('previewing never eliminates anything', () => {
    const before = run([]).alive.length;
    for (const id of ['radar-1000', 'match-library', 'meas-park']) {
      planCandidate(QUESTIONS_BY_ID[id], CIVIC, stations, layers, boundary);
    }
    expect(run([]).alive.length).toBe(before);
  });

  it('blocks the questions that cannot be previewed, with a reason', () => {
    // Needs travel that has not happened yet.
    expect(planCandidate(QUESTIONS_BY_ID['thermo-1000'], CIVIC, stations, layers, boundary).blocked).toBeTruthy();
    // Has no fixed radius until the seeker picks one.
    expect(planCandidate(QUESTIONS_BY_ID['radar-choose'], CIVIC, stations, layers, boundary).blocked).toBeTruthy();
    // Nothing of the kind exists on the board.
    expect(planCandidate(QUESTIONS_BY_ID['match-amusement-park'], CIVIC, stations, layers, boundary).blocked).toBeTruthy();
    // No position to anchor on.
    expect(planCandidate(QUESTIONS_BY_ID['radar-1000'], null, stations, layers, boundary).blocked).toBeTruthy();
  });

  it('a blocked candidate still draws nothing rather than drawing something wrong', () => {
    const c = planCandidate(QUESTIONS_BY_ID['thermo-1000'], CIVIC, stations, layers, boundary);
    expect(c.region).toBeNull();
  });
});
