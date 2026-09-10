import type { AskEntry } from '../engine/types';
import type { Round } from '../store/game';
import { QUESTIONS_BY_ID } from '../engine/questions';
import { jitterPoint } from './jitter';
import type { LocalProfile, LocalTeam } from './identity';

const JITTER_RADIUS_M = 1000;
const JITTERED_CATEGORIES = new Set(['radar', 'thermometer']);

type SanitizedAsk = {
  id: string;
  seq: number;
  question_id: string;
  category: string;
  played_on: string;
  origin_lon: number | null;
  origin_lat: number | null;
  destination_lon: number | null;
  destination_lat: number | null;
  distance_m: number | null;
  answer: AskEntry['answer'];
  note: string | null;
  disabled: boolean;
};

type SanitizedRound = {
  id: string;
  role: Round['role'];
  label: string;
  hider_station_id: string | null;
  played_on: string;
  duration_s: number | null;
};

export type SyncSettings = {
  gameSize: string;
  strictness: string;
  units: string;
  supervisorDistrictsAsAdmin4: boolean;
};

export type GamePayload = {
  game: {
    id: string;
    user_id: string;
    team_id: string;
    city: string;
    size: string;
    settings: SyncSettings;
    played_on: string;
    raw_state: { round: SanitizedRound; asks: SanitizedAsk[] };
  };
  round: SanitizedRound & { game_id: string };
  asks: (SanitizedAsk & { round_id: string })[];
};

function toDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function sanitizeAsk(a: AskEntry, seq: number, playedOn: string): SanitizedAsk {
  const question = QUESTIONS_BY_ID[a.questionId];
  const category = question?.category ?? 'unknown';
  const jitters = JITTERED_CATEGORIES.has(category);

  const origin = jitters ? jitterPoint(a.origin, JITTER_RADIUS_M) : null;
  const destination = jitters && a.destination ? jitterPoint(a.destination, JITTER_RADIUS_M) : null;

  return {
    id: a.id,
    seq,
    question_id: a.questionId,
    category,
    played_on: playedOn,
    origin_lon: origin ? origin[0] : null,
    origin_lat: origin ? origin[1] : null,
    destination_lon: destination ? destination[0] : null,
    destination_lat: destination ? destination[1] : null,
    distance_m: category === 'radar' ? (a.distanceM ?? question?.distanceM ?? null) : null,
    answer: a.answer,
    note: a.note ?? null,
    disabled: !!a.disabled,
  };
}

/**
 * Builds the payload for one finished round, applying every rule this
 * phase's history sync is bound by: station ids and jittered radar/
 * thermometer points only, dates only, one games row per synced round (the
 * app has no broader "game" grouping yet — see architecture notes).
 *
 * Never called before `round.endedAt` is set.
 */
export function buildGamePayload(
  round: Round,
  settings: SyncSettings,
  profile: LocalProfile,
  team: LocalTeam,
  gameId: string,
): GamePayload {
  if (!round.endedAt) throw new Error('buildGamePayload called on a round with no endedAt');

  const playedOn = toDate(round.startedAt);
  const durationS = Math.round((round.endedAt - round.startedAt) / 1000);

  const roundMeta: SanitizedRound = {
    id: round.id,
    role: round.role,
    label: round.label,
    hider_station_id: round.hiderStationId ?? null,
    played_on: playedOn,
    duration_s: durationS,
  };

  const asks = round.asks.map((a, i) => sanitizeAsk(a, i, playedOn));

  return {
    game: {
      id: gameId,
      user_id: profile.id,
      team_id: team.id,
      city: 'sf',
      size: settings.gameSize,
      settings,
      played_on: playedOn,
      raw_state: { round: roundMeta, asks },
    },
    round: { ...roundMeta, game_id: gameId },
    asks: asks.map((a) => ({ ...a, round_id: round.id })),
  };
}
