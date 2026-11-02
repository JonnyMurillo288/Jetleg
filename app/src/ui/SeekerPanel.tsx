import { useMemo, useState } from 'react';
import type { GameData } from '../data/load';
import { useGame, newAskId, type Round } from '../store/game';
import { CATEGORY_META, CATEGORY_ORDER, QUESTIONS, QUESTIONS_BY_ID } from '../engine/questions';
import { previewSplit, type evaluate } from '../engine/candidates';
import { nearestFeature } from '../engine/regions';
import type { Answer, AskEntry, Category, LngLat, Question } from '../engine/types';
import { metres } from '../engine/project';
import { formatDistance } from './units';
import { QuestionRow } from './QuestionRow';
import { AskLog } from './AskLog';
import { PlanPanel } from './PlanPanel';
import type { PlanCandidate } from '../engine/plan';
import type { ChatQuestion } from '../chat/chat';
import type { AskExtra } from './ChatPanel';
import { Lightbox, PhotoThumb } from './ChatPhotos';

type Evaluated = ReturnType<typeof evaluate>;

export function SeekerPanel(props: {
  data: GameData;
  round: Round;
  evaluated: Evaluated;
  /** Where questions are anchored: the GPS fix, or a hand-placed point. */
  origin: LngLat | null;
  pins: { start?: LngLat; end?: LngLat };
  setPins: (p: { start?: LngLat; end?: LngLat }) => void;
  /** Shortlisted questions, already evaluated against the surviving zones. */
  planCandidates: PlanCandidate[];
  /**
   * Whether the board is San Francisco's own ground (the built-in board, or a
   * station map on it). Some questions there have a known answer that the
   * data cannot show; on any other city those facts would be wrong.
   */
  builtInGround: boolean;
  /** In a game: ask through its chat, and see the photos the hider sent. */
  chat?: {
    questions: ChatQuestion[];
    /** Photos kept on this phone, by chat question id. */
    photos: Record<string, string>;
    onAsk: (q: Question, extra?: AskExtra) => Promise<string | null>;
  };
}) {
  const { data, round, evaluated, origin, pins, setPins, planCandidates, chat, builtInGround } = props;
  const [photo, setPhoto] = useState<{ id: string; caption: string } | null>(null);
  const [view, setView] = useState<'ask' | 'plan' | 'log'>('ask');
  const [category, setCategory] = useState<Category>('radar');
  // One row open at a time: the list is eighty rows on a phone screen, and
  // jumping here from the plan needs somewhere definite to land.
  const [openId, setOpenId] = useState<string | null>(null);
  const settings = useGame((s) => s.settings);
  const addAsk = useGame((s) => s.addAsk);
  const plan = useGame((s) => s.plan);
  const togglePlan = useGame((s) => s.togglePlanQuestion);

  const available = useMemo(
    () => QUESTIONS.filter((q) => q.category === category && q.sizes.includes(settings.gameSize)),
    [category, settings.gameSize],
  );

  /**
   * Status per question, so a seeker never spends a turn on a question that
   * cannot tell them anything. A null question hands the hider free cards for
   * no information at all.
   */
  const statuses = useMemo(() => {
    const out: Record<string, ReturnType<typeof statusFor>> = {};
    for (const q of available) {
      out[q.id] = statusFor(q, origin, data, evaluated, builtInGround);
    }
    return out;
  }, [available, origin, data, evaluated, builtInGround]);

  const askCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of round.asks) m[a.questionId] = (m[a.questionId] ?? 0) + 1;
    return m;
  }, [round.asks]);

  const record = (q: Question, answer: Answer, extra?: Partial<AskEntry>) => {
    if (!origin) {
      alert('No position yet. Turn on location, or switch to Manual in the top bar and tap-and-hold the map.');
      return;
    }
    const entry: AskEntry = {
      id: newAskId(),
      questionId: q.id,
      askedAt: Date.now(),
      origin,
      answer,
      ...extra,
    };
    addAsk(entry);
    if (q.category === 'thermometer') setPins({});
  };

  return (
    <div className="panel">
      <div className="seg wide">
        <button className={view === 'ask' ? 'on' : ''} onClick={() => setView('ask')}>Ask</button>
        <button className={view === 'plan' ? 'on' : ''} onClick={() => setView('plan')}>
          Plan{plan.length > 0 ? ` (${plan.length})` : ''}
        </button>
        <button className={view === 'log' ? 'on' : ''} onClick={() => setView('log')}>
          Log ({round.asks.length})
        </button>
      </div>

      {view === 'log' ? (
        <AskLog data={data} round={round} evaluated={evaluated} />
      ) : view === 'plan' ? (
        <PlanPanel
          candidates={planCandidates}
          alive={evaluated.alive.length}
          askCounts={askCounts}
          onAsk={(q) => { setCategory(q.category); setOpenId(q.id); setView('ask'); }}
        />
      ) : (
        <>
          <div className="chips">
            {CATEGORY_ORDER.map((c) => {
              const n = QUESTIONS.filter((q) => q.category === c && q.sizes.includes(settings.gameSize)).length;
              if (!n) return null;
              return (
                <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>
                  {CATEGORY_META[c].title} <span className="muted">{n}</span>
                </button>
              );
            })}
          </div>

          <p className="muted small pad-x">
            {CATEGORY_META[category].blurb} · {CATEGORY_META[category].draw}
          </p>

          {category === 'thermometer' && (
            <ThermometerBar here={origin} pins={pins} setPins={setPins} units={settings.units} />
          )}

          {category === 'photo' && chat && (
            <PhotoDrawer questions={chat.questions} photos={chat.photos} onOpen={(id, caption) => setPhoto({ id, caption })} />
          )}

          <ul className="qlist">
            {available.map((q) => (
              <QuestionRow
                key={q.id}
                question={q}
                status={statuses[q.id]}
                timesAsked={askCounts[q.id] ?? 0}
                origin={origin}
                pins={pins}
                data={data}
                open={openId === q.id}
                onToggle={() => setOpenId(openId === q.id ? null : q.id)}
                inPlan={plan.includes(q.id)}
                onTogglePlan={() => togglePlan(q.id)}
                onAnswer={(answer, extra) => record(q, answer, extra)}
                onAskInChat={chat ? (extra) => chat.onAsk(q, extra) : undefined}
              />
            ))}
          </ul>
        </>
      )}
      {photo && chat?.photos[photo.id] && (
        <Lightbox url={chat.photos[photo.id]} caption={photo.caption} onClose={() => setPhoto(null)} />
      )}
    </div>
  );
}

/**
 * Every photo the hider has sent this game, under the Photo category — a
 * drop-down, newest first, each one a tap from full size. The same photos
 * are pinned to their questions in the chat; this is where a seeker comparing
 * them against the map goes looking.
 */
function PhotoDrawer(props: { questions: ChatQuestion[]; photos: Record<string, string>; onOpen: (id: string, caption: string) => void }) {
  const photos = props.questions.filter((q) => q.photo);
  const waiting = props.questions.filter((q) => q.answerKind === 'photo' && !q.answer).length;
  if (!photos.length && !waiting) return null;
  return (
    <details className="photodrawer pad-x" open>
      <summary>
        <b>Photos from the hider</b> <span className="muted small">{photos.length}{waiting ? ` · ${waiting} on the way` : ''}</span>
      </summary>
      <ul className="list">
        {photos.map((q) => {
          const label = QUESTIONS_BY_ID[q.questionId]?.label ?? q.questionId;
          const caption = `${label} · ${new Date(q.answeredAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
          return (
            <li key={q.id} className="photoitem">
              <PhotoThumb url={props.photos[q.id]} label={label} onOpen={() => props.onOpen(q.id, caption)} />
              <span className="grow">
                <b>{label}</b>
                <span className="muted small"> {caption.split(' · ')[1]}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function ThermometerBar(props: {
  here: LngLat | null;
  pins: { start?: LngLat; end?: LngLat };
  setPins: (p: { start?: LngLat; end?: LngLat }) => void;
  units: 'imperial' | 'metric';
}) {
  const { here, pins, setPins, units } = props;
  // Projected, not a degree-scaling guess. The old inline hypot used fixed
  // metres-per-degree factors and disagreed with every other distance on screen.
  const dist = pins.start && pins.end ? metres(pins.start, pins.end) : null;

  return (
    <div className="thermo pad-x">
      <div className="row">
        <button disabled={!here} onClick={() => setPins({ start: here!, end: undefined })}>
          {pins.start ? 'Reset start' : 'Set start here'}
        </button>
        <button disabled={!here || !pins.start} onClick={() => setPins({ ...pins, end: here! })}>
          Set end here
        </button>
        {(pins.start || pins.end) && <button className="link" onClick={() => setPins({})}>Clear</button>}
      </div>
      <p className="muted small">
        {!pins.start
          ? 'Drop a start pin, send it to the hider, then travel.'
          : !pins.end
            ? 'Travelled far enough? Drop the end pin and send it.'
            : `Travelled ${formatDistance(dist!, units)} as the crow flies. Now log hotter or colder.`}
      </p>
    </div>
  );
}

/**
 * Questions whose outcome on the built-in board is fixed by geography, not
 * by data.
 *
 * These cannot be detected from an empty layer file, because the feature does
 * exist — there is simply only one of it covering the whole board. Saying
 * "none inside the boundary" would be wrong and confusing; the truth is that
 * the whole board is in one state, so the answer is always yes and the
 * question is a wasted turn either way. Worded for the board, not the city:
 * they are shown only on the built-in board's own ground.
 */
const BUILT_IN_NOTES: Record<string, { state: 'null' | 'useless'; reason: string }> = {
  'match-1st-administrative-division': { state: 'useless', reason: 'The whole board is in one state, so this is always yes.' },
  'match-2nd-administrative-division': { state: 'useless', reason: 'The whole board is in one county, so this is always yes.' },
  'match-3rd-administrative-division': { state: 'useless', reason: 'The whole board is one city, so this is always yes.' },
  'match-4th-administrative-division': { state: 'null', reason: 'This board has no 4th administrative division, so this returns null.' },
  'match-landmass': { state: 'useless', reason: 'With the islands out of play the board is a single landmass, so this is always yes.' },
  'meas-1st-administrative-division-border': { state: 'null', reason: 'No state line anywhere near the board.' },
  'meas-international-border': { state: 'null', reason: 'No international border on the board.' },
  'meas-high-speed-train-line': { state: 'null', reason: 'No high-speed rail line on the board.' },
  'match-commercial-airport': { state: 'null', reason: 'No commercial airport inside the boundary, so this returns null.' },
  'meas-commercial-airport': { state: 'null', reason: 'No commercial airport inside the boundary, so this returns null.' },
};

/**
 * Decide whether a question is worth asking from here.
 *
 * Three failure modes, all worth surfacing rather than hiding:
 *   null      — nothing of that kind exists on the board, so the answer carries
 *               no information but the hider still draws cards.
 *   useless   — every surviving zone falls on the same side of the answer.
 *   ok        — shows the split, so you can pick the sharpest question.
 */
function statusFor(
  q: Question,
  origin: LngLat | null,
  data: GameData,
  evaluated: Evaluated,
  builtInGround: boolean,
) {
  const fixed = builtInGround ? BUILT_IN_NOTES[q.id] : undefined;
  if (fixed) {
    return fixed.state === 'null'
      ? { state: 'null' as const, reason: fixed.reason }
      : { state: 'useless' as const, reason: fixed.reason, yes: evaluated.alive.length, no: 0 };
  }

  if (q.layer) {
    const layer = data.layers[q.layer];
    if (!layer || layer.features.length === 0) {
      return { state: 'null' as const, reason: `No ${q.label.toLowerCase()} inside the game boundary — this returns null.` };
    }
    if (q.category === 'matching' && layer.features.length === 1) {
      return {
        state: 'useless' as const,
        reason: `Only one ${q.label.toLowerCase()} on the board, so the answer is always yes.`,
        yes: evaluated.alive.length, no: 0,
      };
    }
  }

  if (!origin) return { state: 'unavailable' as const, reason: 'Waiting for a position.' };

  const split = previewSplit(q, origin, evaluated.alive, data.layers);
  if (!split) return { state: 'ok' as const, yes: null, no: null };

  if (split.yes === 0 || split.no === 0) {
    return {
      state: 'useless' as const,
      reason: 'Every remaining zone falls on the same side, so the answer is already known.',
      yes: split.yes, no: split.no,
    };
  }
  return { state: 'ok' as const, yes: split.yes, no: split.no };
}

export type QuestionStatus = ReturnType<typeof statusFor>;

/** Exposed so the hider's answer assistant can reuse nearest-POI lookup. */
export { nearestFeature, QUESTIONS_BY_ID };
