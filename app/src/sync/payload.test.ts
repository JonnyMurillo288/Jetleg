import { describe, it, expect } from 'vitest';
import { buildGamePayload } from './payload';
import { jitterPoint } from './jitter';
import { metres } from '../engine/project';
import { QUESTIONS } from '../engine/questions';
import type { Round } from '../store/game';
import type { LngLat } from '../engine/types';

const profile = { id: 'profile-1', displayName: 'Test' };
const team = { id: 'team-1', joinCode: 'ABC123' };
const settings = { gameSize: 'medium', strictness: 'strict', units: 'imperial', supervisorDistrictsAsAdmin4: false };
const trueOrigin: LngLat = [-122.4194, 37.7793];

const radarQuestion = QUESTIONS.find((q) => q.category === 'radar')!;
const matchingQuestion = QUESTIONS.find((q) => q.category === 'matching')!;
const thermoQuestion = QUESTIONS.find((q) => q.category === 'thermometer')!;

function endedRound(overrides: Partial<Round> = {}): Round {
  return {
    id: 'round-1',
    role: 'seeker',
    label: 'Test round',
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    asks: [],
    ...overrides,
  };
}

describe('buildGamePayload', () => {
  it('never syncs a radar/thermometer point equal to the true GPS point', () => {
    const round = endedRound({
      asks: [{ id: 'a1', questionId: radarQuestion.id, askedAt: Date.now(), origin: trueOrigin, answer: { kind: 'yesno', value: 'yes' } }],
    });
    const { asks } = buildGamePayload(round, settings, profile, team, 'game-1');
    expect(asks[0].origin_lon).not.toBe(trueOrigin[0]);
    expect(asks[0].origin_lat).not.toBe(trueOrigin[1]);
  });

  it('bounds the jitter to the stated radius', () => {
    for (let i = 0; i < 50; i++) {
      const jittered = jitterPoint(trueOrigin, 1000);
      expect(metres(trueOrigin, jittered)).toBeLessThanOrEqual(1000);
    }
  });

  it('never syncs a position field for a non-radar/thermometer category', () => {
    const round = endedRound({
      asks: [{ id: 'a1', questionId: matchingQuestion.id, askedAt: Date.now(), origin: trueOrigin, answer: { kind: 'yesno', value: 'yes' } }],
    });
    const { asks } = buildGamePayload(round, settings, profile, team, 'game-1');
    expect(asks[0].origin_lon).toBeNull();
    expect(asks[0].origin_lat).toBeNull();
  });

  it('jitters a thermometer destination independently of its origin', () => {
    const destination: LngLat = [-122.41, 37.78];
    const round = endedRound({
      asks: [
        {
          id: 'a1',
          questionId: thermoQuestion.id,
          askedAt: Date.now(),
          origin: trueOrigin,
          destination,
          answer: { kind: 'hotterColder', value: 'hotter' },
        },
      ],
    });
    const { asks } = buildGamePayload(round, settings, profile, team, 'game-1');
    expect(asks[0].destination_lon).not.toBe(destination[0]);
    expect(asks[0].destination_lat).not.toBe(destination[1]);
  });

  it('carries dates, never a clock time, on the round and every ask', () => {
    const round = endedRound({
      asks: [{ id: 'a1', questionId: matchingQuestion.id, askedAt: Date.now(), origin: trueOrigin, answer: { kind: 'yesno', value: 'yes' } }],
    });
    const { round: syncedRound, asks } = buildGamePayload(round, settings, profile, team, 'game-1');
    expect(syncedRound.played_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(asks[0].played_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never includes hiderStationId as anything but the exact station id', () => {
    const round = endedRound({ hiderStationId: 'theembarcaderostockton' });
    const { round: syncedRound } = buildGamePayload(round, settings, profile, team, 'game-1');
    expect(syncedRound.hider_station_id).toBe('theembarcaderostockton');
  });

  it('throws rather than silently syncing an in-progress round', () => {
    const round = endedRound({ endedAt: undefined });
    expect(() => buildGamePayload(round, settings, profile, team, 'game-1')).toThrow();
  });

  it('the full payload JSON never mentions seekerPin', () => {
    const round = endedRound({
      seekerPin: [-122.41, 37.78],
      asks: [{ id: 'a1', questionId: radarQuestion.id, askedAt: Date.now(), origin: trueOrigin, answer: { kind: 'yesno', value: 'yes' } }],
    });
    const payload = buildGamePayload(round, settings, profile, team, 'game-1');
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('seekerpin');
  });
});
