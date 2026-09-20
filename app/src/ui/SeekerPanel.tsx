import { useMemo, useState } from 'react';
import type { GameData } from '../data/load';
import { useGame, newAskId, type Round } from '../store/game';
import { CATEGORY_META, CATEGORY_ORDER, QUESTIONS, QUESTIONS_BY_ID, resolveForUnits } from '../engine/questions';
import { previewSplit, type evaluate } from '../engine/candidates';
import { nearestFeature } from '../engine/regions';
import type { Answer, AskEntry, Category, LngLat, Question } from '../engine/types';
import { metres } from '../engine/project';
import { thermometerMidAngle } from '../engine/thermoHandoff';
import { formatDistance } from './units';
import { QuestionRow } from './QuestionRow';
import { AskLog } from './AskLog';
import { PlanPanel } from './PlanPanel';
import type { PlanCandidate } from '../engine/plan';

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
}) {
  const { data, round, evaluated, origin, pins, setPins, planCandidates } = props;
  const [view, setView] = useState<'ask' | 'plan' | 'log'>('ask');
  const [category, setCategory] = useState<Category>('radar');
  // One row open at a time: the list is eighty rows on a phone screen, and
  // jumping here from the plan needs somewhere definite to land.
  const [openId, setOpenId] = useState<string | null>(null);
  const settings = useGame((s) => s.settings);
  const addAsk = useGame((s) => s.addAsk);
  const plan = useGame((s) => s.plan);
  const togglePlan = useGame((s) => s.togglePlanQuestion);
  const hideDeadQuestions = useGame((s) => s.hideDeadQuestions);
  const toggleHideDeadQuestions = useGame((s) => s.toggleHideDeadQuestions);

  const available = useMemo(
    () =>
      QUESTIONS.filter((q) => q.category === category && q.sizes.includes(settings.gameSize))
        .map((q) => resolveForUnits(q, settings.units)),
    [category, settings.gameSize, settings.units],
  );

  /**
   * Status per question, so a seeker never spends a turn on a question that
   * cannot tell them anything. A null question hands the hider free cards for
   * no information at all.
   */
  const statuses = useMemo(() => {
    const out: Record<string, ReturnType<typeof statusFor>> = {};
    for (const q of available) {
      out[q.id] = statusFor(q, origin, data, evaluated, settings.supervisorDistrictsAsAdmin4, settings.disabledQuestionIds);
    }
    return out;
  }, [available, origin, data, evaluated, settings.supervisorDistrictsAsAdmin4, settings.disabledQuestionIds]);

  /**
   * Null and no-split questions sink to the bottom rather than sitting
   * wherever the catalog put them — a wasted turn is the same wasted turn
   * whether it is first in the list or last, but finding the live questions
   * shouldn't mean scanning past the dead ones first.
   */
  const [liveQuestions, deadQuestions] = useMemo(() => {
    const live: Question[] = [];
    const dead: Question[] = [];
    for (const q of available) {
      const st = statuses[q.id]?.state;
      (st === 'null' || st === 'useless' ? dead : live).push(q);
    }
    return [live, dead];
  }, [available, statuses]);

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
      // Snapshot the resolved radar/thermometer distance onto the entry, not
      // just the question's own — the catalog's distance now depends on
      // `settings.units`, and a later unit toggle must not retroactively
      // change what an already-answered question actually asked.
      ...(q.category === 'radar' || q.category === 'thermometer' ? { distanceM: q.distanceM } : {}),
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

          {deadQuestions.length > 0 && (
            <label className="hidedead">
              <input type="checkbox" checked={hideDeadQuestions} onChange={toggleHideDeadQuestions} />
              <span className="muted small">
                Hide null / no-split questions ({deadQuestions.length})
              </span>
            </label>
          )}

          <ul className="qlist">
            {liveQuestions.map((q) => (
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
              />
            ))}
          </ul>

          {deadQuestions.length > 0 && !hideDeadQuestions && (
            <ul className="qlist dead-group">
              {deadQuestions.map((q) => (
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
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
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
  const handoff = pins.start && pins.end ? thermometerMidAngle(pins.start, pins.end) : null;

  const copyHandoff = () => {
    if (!handoff) return;
    const text = `${handoff.midpoint[1].toFixed(6)}, ${handoff.midpoint[0].toFixed(6)} @ ${handoff.angleDeg.toFixed(1)}°`;
    navigator.clipboard?.writeText(text).catch(() => {});
  };

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
      {handoff && (
        <div className="thermo-handoff">
          <p className="muted small">
            For an exact dividing line, send the hider these two numbers instead of pins — they
            enter them under Thermometer → Exact numbers:
          </p>
          <div className="row">
            <span className="tag">
              Midpoint {handoff.midpoint[1].toFixed(6)}, {handoff.midpoint[0].toFixed(6)}
            </span>
            <span className="tag">Angle {handoff.angleDeg.toFixed(1)}°</span>
            <button className="link" onClick={copyHandoff}>Copy</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Questions whose San Francisco outcome is fixed by geography, not by data.
 *
 * These cannot be detected from an empty layer file, because the feature does
 * exist — there is simply only one of it covering the whole board. Saying
 * "no 1st administrative division inside the boundary" would be wrong and
 * confusing; the truth is that everyone is in California, so the answer is
 * always yes and the question is a wasted turn either way.
 */
const SF_NOTES: Record<string, { state: 'null' | 'useless'; reason: string }> = {
  'match-1st-administrative-division': {
    state: 'useless',
    reason: 'The whole board is in California, so this is always yes.',
  },
  'match-2nd-administrative-division': {
    state: 'useless',
    reason: 'The whole board is in San Francisco County, so this is always yes.',
  },
  'match-3rd-administrative-division': {
    state: 'useless',
    reason: 'The whole board is the City of San Francisco, so this is always yes.',
  },
  'match-4th-administrative-division': {
    state: 'null',
    reason: 'San Francisco has no formal 4th administrative division. Turn on the supervisor-district house rule in Layers to make this question live.',
  },
  'match-landmass': {
    state: 'useless',
    reason: 'With the islands out of play the board is a single landmass, so this is always yes.',
  },
  'meas-1st-administrative-division-border': {
    state: 'null',
    reason: 'The California state line is nowhere near the board.',
  },
  'meas-international-border': {
    state: 'null',
    reason: 'No international border on the board.',
  },
  'meas-high-speed-train-line': {
    state: 'null',
    reason: 'No high-speed rail operating in California.',
  },
  'match-commercial-airport': {
    state: 'null',
    reason: 'SFO, OAK and SJC are all outside the city limits, so this returns null.',
  },
  'meas-commercial-airport': {
    state: 'null',
    reason: 'SFO, OAK and SJC are all outside the city limits, so this returns null.',
  },
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
  admin4HouseRule: boolean,
  disabledQuestionIds: string[],
) {
  if (disabledQuestionIds.includes(q.id)) {
    return { state: 'null' as const, reason: 'Disabled before the round in Map → Rules → Disable questions.' };
  }

  const sf = SF_NOTES[q.id];
  if (sf && !(q.id === 'match-4th-administrative-division' && admin4HouseRule)) {
    return sf.state === 'null'
      ? { state: 'null' as const, reason: sf.reason }
      : { state: 'useless' as const, reason: sf.reason, yes: evaluated.alive.length, no: 0 };
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
