import type { AskEntry, Boundary, Category, LngLat, PoiLayer, Question, Station } from '../engine/types';
import { evaluate, type Strictness } from '../engine/candidates';
import { QUESTIONS_BY_ID } from '../engine/questions';
import type { Round } from '../store/game';

/**
 * A round, looked back on: what each question did, and the handful of
 * moments worth pointing at.
 *
 * Every zone count here comes from `evaluate()` over the round's own ask log
 * — the same call the live game and the Results tab make — so a number on
 * this page can never disagree with what the round showed while it was being
 * played. Nothing is tallied separately and nothing is stored: a round's
 * stats are a pure function of its log and the board it was played on.
 *
 * That board is optional. A round opened from a file may have been played on
 * a map this device does not have, and zone counts against the wrong
 * stations would be wrong without any sign that they were. Without a board
 * the timings and the seekers' own movement are still reported; everything
 * that needs a station is null.
 */

export type StatsBoard = {
  stations: Station[];
  layers: Record<string, PoiLayer>;
  boundary: Boundary;
};

export type QuestionStat = {
  ask: AskEntry;
  /** 1-based, in the order asked. */
  number: number;
  /** Null for a question this build's catalog does not have. */
  question: Question | null;
  /** Since the question before; for the first, since the round started. */
  gapMs: number;
  /**
   * Can the app say what this answer did? Not for a photo, a disabled entry,
   * or a question about something the board does not carry — those are not
   * "worth nothing", they are simply outside what the map can judge. A null
   * answer *is* scored: the rulebook counts it as answered, and it rules
   * nothing out.
   */
  scored: boolean;
  /** Zones still standing before and after this answer. Null without the board. */
  before: number | null;
  after: number | null;
  eliminated: number | null;
  /** `eliminated / before`: how much of what was left this answer removed. */
  share: number | null;
  /** Zones this answer rules out by itself, against the whole board. */
  alone: number | null;
  /** Zones that only this answer ruled out. Take it away and they come back. */
  decisive: number | null;
  /** From where the seekers stood (a thermometer: where they ended) to the hider's station. */
  toHiderM: number | null;
  /** Ground covered since the previous question, a thermometer's own run included. */
  movedM: number;
  cardsDrawn: number;
  cardsKept: number;
};

export type RoundStats = {
  questions: QuestionStat[];
  durationMs: number;
  hasBoard: boolean;
  total: number | null;
  left: number | null;
  /** The sharpest cut: the largest share of what was left at the time. */
  best: QuestionStat | null;
  /** The weakest scored question, when there is more than one to compare. */
  worst: QuestionStat | null;
  /** The most zones removed in one go, when that is a different question from `best`. */
  biggestCut: QuestionStat | null;
  /** The answer that first took the board below half. */
  halfway: QuestionStat | null;
  /** Scored questions that ruled out nothing. */
  duds: number;
  /** Between questions; the wait before the first is `questions[0].gapMs`. */
  longestGap: QuestionStat | null;
  shortestGap: QuestionStat | null;
  averageGapMs: number | null;
  closest: QuestionStat | null;
  farthest: QuestionStat | null;
  travelledM: number;
  cardsDrawn: number;
  cardsKept: number;
  /** Most asked first. */
  categories: { category: Category; count: number }[];
  hider: {
    station: Station;
    /** Is the true zone still standing under the answers given? */
    alive: boolean;
    /** The answer that ruled the true zone out, if one did. */
    ruledOutBy: QuestionStat | null;
  } | null;
};

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance. Not the engine's `metres()`: that projects through
 * whichever board is loaded, and these distances must mean the same thing
 * for a round whose board is not. Within 0.3% of it across a city.
 */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "draw 3, keep 1" — the rulebook's own wording, read back into numbers. */
function cardsOf(question: Question | null): { drawn: number; kept: number } {
  const m = question?.draw.match(/draw (\d+), keep (\d+)/);
  return m ? { drawn: Number(m[1]), kept: Number(m[2]) } : { drawn: 0, kept: 0 };
}

/** Where the seekers were when the answer came. */
const standingAt = (a: AskEntry): LngLat => a.destination ?? a.origin;

/** The first of `items` that `better` prefers to every other. */
function pick<T>(items: T[], better: (a: T, b: T) => boolean): T | null {
  let best: T | null = null;
  for (const item of items) if (best === null || better(item, best)) best = item;
  return best;
}

/**
 * The caller must have pointed the engine at `board` first (`enterBoard`,
 * engine/reset.ts), as for any other evaluation.
 */
export function roundStats(round: Round, board: StatsBoard | null, strictness: Strictness): RoundStats {
  const asks = round.asks;
  const evaluated = board
    ? evaluate(board.stations, asks, QUESTIONS_BY_ID, board.layers, board.boundary, strictness)
    : null;

  // A zone falls to the first answer that contradicts it, and stays fallen.
  const indexOf = new Map(asks.map((a, i) => [a.id, i]));
  const firstKill = new Map<string, number>();
  const alone = new Array<number>(asks.length).fill(0);
  const decisive = new Array<number>(asks.length).fill(0);
  const fellAt = new Array<number>(asks.length).fill(0);
  for (const v of evaluated?.verdicts ?? []) {
    const hits = v.killedBy.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined);
    if (!hits.length) continue;
    const first = Math.min(...hits);
    firstKill.set(v.station.id, first);
    fellAt[first]++;
    for (const i of hits) alone[i]++;
    if (hits.length === 1) decisive[first]++;
  }
  const constrained = new Set((evaluated?.resolved ?? []).filter((r) => r.region).map((r) => r.entry.id));

  const hiderStation = board && round.hiderStationId
    ? board.stations.find((s) => s.id === round.hiderStationId) ?? null
    : null;
  const hiderAt: LngLat | null = hiderStation ? [hiderStation.lon, hiderStation.lat] : null;

  const total = board ? board.stations.length : null;
  let standing = total;
  const questions: QuestionStat[] = asks.map((ask, i) => {
    const question = QUESTIONS_BY_ID[ask.questionId] ?? null;
    const previous = asks[i - 1];
    const before = standing;
    const after = before === null ? null : before - fellAt[i];
    standing = after;
    const eliminated = before === null ? null : fellAt[i];
    const { drawn, kept } = cardsOf(question);
    return {
      ask,
      number: i + 1,
      question,
      gapMs: Math.max(0, ask.askedAt - (previous ? previous.askedAt : round.startedAt)),
      scored: !!board && !ask.disabled && (constrained.has(ask.id) || (!!question && ask.answer.kind === 'null')),
      before,
      after,
      eliminated,
      share: before && eliminated !== null ? eliminated / before : null,
      alone: board ? alone[i] : null,
      decisive: board ? decisive[i] : null,
      toHiderM: hiderAt ? haversineM(standingAt(ask), hiderAt) : null,
      movedM:
        (previous ? haversineM(standingAt(previous), ask.origin) : 0) +
        (ask.destination ? haversineM(ask.origin, ask.destination) : 0),
      cardsDrawn: drawn,
      cardsKept: kept,
    };
  });

  const scored = questions.filter((q) => q.scored && q.before);
  const best = pick(
    scored.filter((q) => q.eliminated! > 0),
    (a, b) => a.share! > b.share! || (a.share === b.share && a.eliminated! > b.eliminated!),
  );
  // Between two that did equally little, the one that cost more cards is worse.
  const worst = scored.length > 1
    ? pick(scored, (a, b) => a.share! < b.share! || (a.share === b.share && a.cardsDrawn > b.cardsDrawn))
    : null;
  const biggest = pick(scored.filter((q) => q.eliminated! > 0), (a, b) => a.eliminated! > b.eliminated!);

  const between = questions.slice(1);
  const located = questions.filter((q) => q.toHiderM !== null);

  const counts = new Map<Category, number>();
  for (const q of questions) if (q.question) counts.set(q.question.category, (counts.get(q.question.category) ?? 0) + 1);

  const lastAsked = asks.length ? asks[asks.length - 1].askedAt : round.startedAt;
  const ruledOutAt = hiderStation ? firstKill.get(hiderStation.id) : undefined;

  return {
    questions,
    durationMs: Math.max(0, (round.endedAt ?? lastAsked) - round.startedAt),
    hasBoard: !!board,
    total,
    left: standing,
    best,
    worst: worst && worst !== best ? worst : null,
    biggestCut: biggest && biggest !== best ? biggest : null,
    halfway: total ? questions.find((q) => q.before! * 2 > total && q.after! * 2 <= total) ?? null : null,
    duds: scored.filter((q) => q.eliminated === 0).length,
    longestGap: pick(between, (a, b) => a.gapMs > b.gapMs),
    shortestGap: between.length > 1 ? pick(between, (a, b) => a.gapMs < b.gapMs) : null,
    averageGapMs: between.length ? between.reduce((sum, q) => sum + q.gapMs, 0) / between.length : null,
    closest: pick(located, (a, b) => a.toHiderM! < b.toHiderM!),
    farthest: located.length > 1 ? pick(located, (a, b) => a.toHiderM! > b.toHiderM!) : null,
    travelledM: questions.reduce((sum, q) => sum + q.movedM, 0),
    cardsDrawn: questions.reduce((sum, q) => sum + q.cardsDrawn, 0),
    cardsKept: questions.reduce((sum, q) => sum + q.cardsKept, 0),
    categories: [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    hider: hiderStation
      ? {
          station: hiderStation,
          alive: ruledOutAt === undefined,
          ruledOutBy: ruledOutAt === undefined ? null : questions[ruledOutAt],
        }
      : null,
  };
}
