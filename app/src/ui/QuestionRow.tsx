import { useState } from 'react';
import type { GameData } from '../data/load';
import type { Answer, AskEntry, LngLat, Question } from '../engine/types';
import type { QuestionStatus } from './SeekerPanel';
import { useGame } from '../store/game';
import { formatDistance, fromRadiusInput, radiusUnit, toRadiusInput } from './units';

export function QuestionRow(props: {
  question: Question;
  status: QuestionStatus;
  timesAsked: number;
  origin: LngLat | null;
  pins: { start?: LngLat; end?: LngLat };
  data: GameData;
  /** Open state is owned by the list, so only one row is expanded at a time. */
  open: boolean;
  onToggle: () => void;
  inPlan: boolean;
  onTogglePlan: () => void;
  onAnswer: (a: Answer, extra?: Partial<AskEntry>) => void;
}) {
  const { question: q, status, timesAsked, pins, data, open, onToggle, inPlan, onTogglePlan, onAnswer } = props;
  const [chooseM, setChooseM] = useState(1000);

  const dead = status.state === 'null';
  const weak = status.state === 'useless';

  return (
    <li className={`qrow ${dead ? 'dead' : ''} ${weak ? 'weak' : ''} ${inPlan ? 'planned' : ''}`}>
      <button className="qhead" onClick={onToggle}>
        <span className="qlabel">
          {q.label}
          {inPlan && <span className="tag good" title="On the plan shortlist">plan</span>}
          {timesAsked > 0 && (
            <span className="cost" title="Already asked — the cost multiplies">
              ×{timesAsked + 1} cost
            </span>
          )}
        </span>
        <span className="qsplit">
          {status.state === 'ok' && status.yes !== null && (
            <><b>{status.yes}</b> / <b>{status.no}</b></>
          )}
          {dead && <span className="tag">null</span>}
          {weak && <span className="tag warn">no split</span>}
        </span>
      </button>

      {open && (
        <div className="qbody">
          <p className="qtext">“{q.text}”</p>
          {q.caveat && <p className="muted small">{q.caveat}</p>}
          {q.spec && <p className="muted small"><b>Photo spec:</b> {q.spec}</p>}
          {'reason' in status && status.reason && <p className="warntext small">{status.reason}</p>}
          <p className="muted small">{q.draw} · answer within {q.timeLimitMin} min</p>

          {!dead && <Answers q={q} pins={pins} data={data} chooseM={chooseM} setChooseM={setChooseM} onAnswer={onAnswer} />}

          <div className="row">
            {/* Shortlisting is the cheap action; answering is the expensive one.
                They sit apart so a thumb reaching for one cannot hit the other. */}
            <button className={`planbtn ${inPlan ? 'on' : ''}`} onClick={onTogglePlan}>
              {inPlan ? '✓ On plan' : '+ Plan'}
            </button>
            <button className="link small" onClick={() => onAnswer({ kind: 'null' })}>
              Record as null (no such thing on the map)
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function Answers(props: {
  q: Question;
  pins: { start?: LngLat; end?: LngLat };
  data: GameData;
  chooseM: number;
  setChooseM: (n: number) => void;
  onAnswer: (a: Answer, extra?: Partial<AskEntry>) => void;
}) {
  const { q, pins, data, chooseM, setChooseM, onAnswer } = props;
  const units = useGame((s) => s.settings.units);

  if (q.category === 'photo') {
    return (
      <div className="row">
        <button onClick={() => onAnswer({ kind: 'photo' })}>Log as answered</button>
        <span className="muted small">Photos come through your group chat.</span>
      </div>
    );
  }

  if (q.category === 'thermometer') {
    const ready = pins.start && pins.end;
    return (
      <div className="row">
        <button className="yes" disabled={!ready} onClick={() => onAnswer({ kind: 'hotterColder', value: 'hotter' }, { origin: pins.start!, destination: pins.end! })}>
          Hotter
        </button>
        <button className="no" disabled={!ready} onClick={() => onAnswer({ kind: 'hotterColder', value: 'colder' }, { origin: pins.start!, destination: pins.end! })}>
          Colder
        </button>
        {!ready && <span className="muted small">Set both pins first.</span>}
      </div>
    );
  }

  if (q.category === 'measuring') {
    return (
      <div className="row">
        <button className="yes" onClick={() => onAnswer({ kind: 'closerFurther', value: 'closer' })}>Closer</button>
        <button className="no" onClick={() => onAnswer({ kind: 'closerFurther', value: 'further' })}>Further</button>
      </div>
    );
  }

  if (q.category === 'tentacle') {
    const layer = q.layer ? data.layers[q.layer] : undefined;
    return (
      <div className="col">
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return;
            onAnswer({ kind: 'tentacle', poiId: e.target.value === '__none__' ? null : e.target.value });
            e.currentTarget.value = '';
          }}
        >
          <option value="">Which one did they name?</option>
          <option value="__none__">Not within reach</option>
          {layer?.features.map((f, i) => {
            const id = (f.properties?.id ?? f.properties?.name ?? String(i)) as string;
            return <option key={id} value={id}>{f.properties?.name ?? id}</option>;
          })}
        </select>
      </div>
    );
  }

  // radar + matching are yes/no
  const chosen = q.id === 'radar-choose';
  return (
    <div className="col">
      {chosen && (
        <>
          <label className="row small">
            Distance
            <input
              className="num"
              type="number"
              min={1}
              step={units === 'metric' ? 50 : 100}
              value={toRadiusInput(chooseM, units)}
              onChange={(e) => setChooseM(fromRadiusInput(Number(e.target.value) || 0, units))}
            />
            {radiusUnit(units)}
          </label>
          <p className="muted small">
            Ask “are you within {formatDistance(chooseM, units)} of me?”. This distance is
            recorded with the answer — it is the only radius the question has.
          </p>
        </>
      )}
      <div className="row">
        {/*
          The chosen radius travels with the entry. Without it the engine fell
          back to the question's own distance, which for "Choose" is undefined —
          so this question drew a circle of no radius and constrained nothing.
        */}
        <button
          className="yes"
          onClick={() => onAnswer({ kind: 'yesno', value: 'yes' }, chosen ? { distanceM: chooseM } : undefined)}
        >Yes</button>
        <button
          className="no"
          onClick={() => onAnswer({ kind: 'yesno', value: 'no' }, chosen ? { distanceM: chooseM } : undefined)}
        >No</button>
      </div>
    </div>
  );
}
