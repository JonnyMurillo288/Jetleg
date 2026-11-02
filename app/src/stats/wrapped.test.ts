import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { evaluate } from '../engine/candidates';
import { metres } from '../engine/project';
import { QUESTIONS, QUESTIONS_BY_ID } from '../engine/questions';
import type { Answer, AskEntry, Boundary, LngLat, PoiLayer, Station } from '../engine/types';
import type { Round } from '../store/game';
import { gameFileText, readGameFile } from './gamefile';
import { haversineM, roundStats, type StatsBoard } from './wrapped';

const DATA = join(__dirname, '../../public/data');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

let board: StatsBoard;

beforeAll(() => {
  const layer = (key: string, file: string): PoiLayer => ({
    key, label: key, kind: 'point',
    features: read<FeatureCollection>(file).features as any,
    cells: read<FeatureCollection>(`voronoi-${key}.geojson`),
  });
  board = {
    boundary: read<FeatureCollection>('boundary.geojson').features[0] as Boundary,
    stations: read<{ stations: Station[] }>('stations.json').stations,
    layers: { parks: layer('parks', 'poi-parks.geojson'), libraries: layer('libraries', 'poi-libraries.geojson') },
  };
});

const CIVIC_CENTER: LngLat = [-122.4194, 37.7793];
const MISSION: LngLat = [-122.4189, 37.7599];
const MARINA: LngLat = [-122.4368, 37.8021];
const START = Date.UTC(2026, 9, 3, 17, 0, 0);
const MIN = 60_000;

const id = (category: string, label: RegExp) => QUESTIONS.find((q) => q.category === category && label.test(q.label))!.id;
const ask = (n: number, questionId: string, atMin: number, origin: LngLat, answer: Answer, more: Partial<AskEntry> = {}): AskEntry =>
  ({ id: `ask-${n}`, questionId, askedAt: START + atMin * MIN, origin, answer, ...more });

/** Six questions that between them cover every way a question can be scored, or not. */
const theAsks = (): AskEntry[] => [
  ask(1, id('radar', /^2 km/), 10, CIVIC_CENTER, { kind: 'yesno', value: 'yes' }),
  ask(2, id('matching', /^Park$/), 25, CIVIC_CENTER, { kind: 'yesno', value: 'no' }),
  ask(3, id('measuring', /Library/), 26, MISSION, { kind: 'closerFurther', value: 'closer' }),
  ask(4, QUESTIONS.find((q) => q.category === 'photo')!.id, 50, MISSION, { kind: 'photo' }),
  ask(5, id('matching', /^Zoo$/), 55, MARINA, { kind: 'null' }),
  ask(6, id('radar', /^500 m/), 90, MARINA, { kind: 'yesno', value: 'yes' }, { disabled: true }),
];

const roundOf = (asks: AskEntry[], more: Partial<Round> = {}): Round =>
  ({ id: 'r1', role: 'seeker', label: 'Seeking round 1', startedAt: START, endedAt: START + 120 * MIN, asks, ...more });

/** The slow, obvious way: replay the log one question longer each time. */
const aliveAfter = (asks: AskEntry[], n: number) =>
  evaluate(board.stations, asks.slice(0, n), QUESTIONS_BY_ID, board.layers, board.boundary, 'strict').alive;

describe('round stats', () => {
  it('counts zones before and after each question exactly as replaying the log does', () => {
    const asks = theAsks();
    const stats = roundStats(roundOf(asks), board, 'strict');

    expect(stats.total).toBe(board.stations.length);
    for (let i = 0; i < asks.length; i++) {
      const q = stats.questions[i];
      expect(q.before, `before question ${i + 1}`).toBe(aliveAfter(asks, i).length);
      expect(q.after, `after question ${i + 1}`).toBe(aliveAfter(asks, i + 1).length);
      expect(q.eliminated).toBe(q.before! - q.after!);
    }
    expect(stats.left).toBe(aliveAfter(asks, asks.length).length);
    // The fixture has to actually narrow the board, or every check above is 192 === 192.
    expect(stats.left).toBeGreaterThan(0);
    expect(stats.left!).toBeLessThan(board.stations.length / 2);
    expect(stats.questions.slice(0, 3).every((q) => q.eliminated! > 0)).toBe(true);
  });

  it('names the best and the weakest question, and leaves out what it cannot judge', () => {
    const stats = roundStats(roundOf(theAsks()), board, 'strict');
    const [radar, park, library, photo, zoo, disabled] = stats.questions;

    expect(photo.scored).toBe(false);
    expect(disabled.scored).toBe(false);
    // A null answer is an answered question that ruled out nothing.
    expect(zoo.scored).toBe(true);
    expect(zoo.eliminated).toBe(0);
    expect(stats.duds).toBe(1);

    const scored = [radar, park, library, zoo];
    const sharpest = scored.reduce((a, b) => (b.share! > a.share! ? b : a));
    expect(stats.best).toBe(sharpest);
    expect(stats.worst).toBe(zoo);
    const most = scored.reduce((a, b) => (b.eliminated! > a.eliminated! ? b : a));
    expect(stats.biggestCut).toBe(most === sharpest ? null : most);

    expect(stats.halfway).toBe(stats.questions.find((q) => q.after! * 2 <= stats.total!));
  });

  it('times the gaps between questions', () => {
    const stats = roundStats(roundOf(theAsks()), board, 'strict');
    expect(stats.questions.map((q) => q.gapMs / MIN)).toEqual([10, 15, 1, 24, 5, 35]);
    expect(stats.longestGap!.number).toBe(6);
    expect(stats.shortestGap!.number).toBe(3);
    expect(stats.averageGapMs! / MIN).toBe((15 + 1 + 24 + 5 + 35) / 5);
    expect(stats.durationMs / MIN).toBe(120);
  });

  it('adds up the cards and the ground covered', () => {
    const asks = theAsks();
    const stats = roundStats(roundOf(asks), board, 'strict');
    const drawn = asks.map((a) => Number(QUESTIONS_BY_ID[a.questionId].draw.match(/draw (\d+)/)![1]));
    expect(stats.cardsDrawn).toBe(drawn.reduce((a, b) => a + b, 0));
    expect(stats.cardsDrawn).toBeGreaterThan(stats.cardsKept);

    const walked = haversineM(CIVIC_CENTER, MISSION) + haversineM(MISSION, MARINA);
    expect(stats.travelledM).toBeCloseTo(walked, 3);
    expect(stats.categories[0].count).toBe(2);
  });

  it('measures each question to the hider, within a hair of the engine’s own distance', () => {
    const asks = theAsks();
    const survivor = aliveAfter(asks, asks.length)[0];
    const stats = roundStats(roundOf(asks, { hiderStationId: survivor.id }), board, 'strict');

    for (const q of stats.questions) {
      const engine = metres(q.ask.origin, [survivor.lon, survivor.lat]);
      expect(Math.abs(q.toHiderM! - engine) / engine).toBeLessThan(0.005);
    }
    expect(stats.hider).toMatchObject({ station: survivor, alive: true, ruledOutBy: null });
    const nearest = stats.questions.reduce((a, b) => (b.toHiderM! < a.toHiderM! ? b : a));
    expect(stats.closest).toBe(nearest);
  });

  it('says which answer ruled out the zone the hider was really in', () => {
    const asks = theAsks();
    const standing = new Set(aliveAfter(asks, 1).map((s) => s.id));
    const fell = aliveAfter(asks, 0).find((s) => !standing.has(s.id))!;
    const stats = roundStats(roundOf(asks, { hiderStationId: fell.id }), board, 'strict');
    expect(stats.hider!.alive).toBe(false);
    expect(stats.hider!.ruledOutBy!.number).toBe(1);
  });

  it('measures a thermometer from where the seekers ended up', () => {
    const thermo = ask(1, QUESTIONS.find((q) => q.category === 'thermometer')!.id, 5, CIVIC_CENTER, { kind: 'hotterColder', value: 'hotter' }, { destination: MISSION });
    const station = board.stations[0];
    const stats = roundStats(roundOf([thermo], { hiderStationId: station.id }), board, 'strict');
    expect(stats.questions[0].toHiderM).toBeCloseTo(haversineM(MISSION, [station.lon, station.lat]), 6);
    expect(stats.questions[0].movedM).toBeCloseTo(haversineM(CIVIC_CENTER, MISSION), 6);
  });

  it('still reports the timings when the board is not this device’s', () => {
    const stats = roundStats(roundOf(theAsks(), { hiderStationId: board.stations[0].id }), null, 'strict');
    expect(stats.hasBoard).toBe(false);
    expect(stats.total).toBeNull();
    expect(stats.left).toBeNull();
    expect(stats.best).toBeNull();
    expect(stats.hider).toBeNull();
    expect(stats.questions.every((q) => q.before === null && q.toHiderM === null && !q.scored)).toBe(true);
    expect(stats.longestGap!.number).toBe(6);
    expect(stats.travelledM).toBeGreaterThan(1000);
  });

  it('has nothing to say about an empty round, and says it without throwing', () => {
    const stats = roundStats(roundOf([], { endedAt: undefined }), board, 'strict');
    expect(stats.questions).toEqual([]);
    expect(stats.best).toBeNull();
    expect(stats.averageGapMs).toBeNull();
    expect(stats.durationMs).toBe(0);
    expect(stats.left).toBe(board.stations.length);
  });

  it('knows a degree of latitude', () => {
    expect(haversineM([0, 0], [0, 1]) / 1000).toBeCloseTo(111.195, 2);
  });
});

describe('game file', () => {
  const settings = { gameSize: 'medium', strictness: 'strict', units: 'imperial', supervisorDistrictsAsAdmin4: false };

  it('reads back exactly the rounds it wrote', () => {
    const round = roundOf(theAsks(), { hiderStationId: 'civiccenter', board: { name: 'Downtown', versionId: null, stationCount: 40 } });
    const read = readGameFile(gameFileText([round], settings, 'seeker'));
    expect(read.ok && read.file.rounds).toEqual([round]);
    expect(read.ok && read.file.skipped).toBe(0);
    expect(read.ok && read.file.settings).toEqual(settings);
  });

  it('refuses what is not a game file', () => {
    expect(readGameFile('not json')).toMatchObject({ ok: false });
    expect(readGameFile('[]')).toMatchObject({ ok: false, error: 'Not a JetLeg export file.' });
    expect(readGameFile(JSON.stringify({ app: 'jetleg-sf' }))).toMatchObject({ ok: false, error: 'No rounds in file.' });
    expect(readGameFile(JSON.stringify({ app: 'jetleg-sf', version: 99, rounds: [] }))).toMatchObject({ ok: false });
  });

  it('leaves out what is malformed, and says how much', () => {
    const good = roundOf(theAsks().slice(0, 2));
    const doc = JSON.parse(gameFileText([good], settings, 'seeker'));
    doc.rounds[0].asks.push({ id: 'x', questionId: 'radar-1', askedAt: 5, origin: [999, 0], answer: { kind: 'yesno', value: 'yes' } });
    doc.rounds[0].asks.push({ id: 'y', questionId: 'radar-1', askedAt: 5, origin: [0, 0], answer: { kind: 'yesno', value: 'maybe' } });
    doc.rounds.push({ id: 'no-asks', role: 'seeker', startedAt: 1 });
    doc.rounds.push({ ...doc.rounds[0] });
    doc.rounds.push('a string');
    const read = readGameFile(JSON.stringify(doc));
    expect(read.ok && read.file.rounds).toEqual([good]);
    // Two bad questions, a round with no log, a string — and the duplicate, with its own two bad questions.
    expect(read.ok && read.file.skipped).toBe(2 + 1 + 1 + 1 + 2);
  });
});
