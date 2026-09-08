import { useMemo, useState } from 'react';
import type { GameData } from '../data/load';
import { useGame, newAskId, type Round } from '../store/game';
import { CATEGORY_META, CATEGORY_ORDER, QUESTIONS, QUESTIONS_BY_ID } from '../engine/questions';
import { nearestFeature, distanceToFeatureM } from '../engine/regions';
import { metres } from '../engine/project';
import { ZONE_RADIUS_M, type evaluate } from '../engine/candidates';
import type { Answer, AskEntry, Category, LngLat, Question, Station } from '../engine/types';

type Evaluated = ReturnType<typeof evaluate>;

/**
 * The hider's half of the app.
 *
 * Two jobs. First, answering: the real burden is replying truthfully inside five
 * minutes while walking, so the assistant computes the answer from GPS against
 * exactly the layers the seekers are using.
 *
 * Second, exposure. Every answer given is information handed over, and the
 * rulebook has seekers running trackers the hider can follow — so the hider
 * knows where the seekers are and can replay their own answers through the same
 * elimination engine. The map then shades what the seekers have ruled out, and
 * the hider can see their zone closing in before it does.
 */
export function HiderPanel(props: {
  data: GameData;
  round: Round;
  origin: LngLat | null;
  hiderStation: Station | null;
  evaluated: Evaluated;
}) {
  const { data, round, origin, hiderStation, evaluated } = props;
  const [category, setCategory] = useState<Category>('matching');
  const [view, setView] = useState<'answer' | 'exposure'>('answer');
  const settings = useGame((s) => s.settings);
  const setHiderStation = useGame((s) => s.setHiderStation);
  const setSeekerPin = useGame((s) => s.setSeekerPin);
  const manual = useGame((s) => s.manualLocation);
  const placeTarget = useGame((s) => s.hiderPlaceTarget);
  const setPlaceTarget = useGame((s) => s.setHiderPlaceTarget);
  const armSeekerPin = useGame((s) => s.armSeekerPin);
  const setArmSeekerPin = useGame((s) => s.setArmSeekerPin);
  const addAsk = useGame((s) => s.addAsk);
  const removeAsk = useGame((s) => s.removeAsk);
  const endRound = useGame((s) => s.endRound);

  const here = origin;
  const seekers = round.seekerPin ?? null;

  const drift = useMemo(() => {
    if (!here || !hiderStation) return null;
    return Math.round(metres(here, [hiderStation.lon, hiderStation.lat]));
  }, [here, hiderStation]);

  const questions = useMemo(
    () => QUESTIONS.filter((q) => q.category === category && q.sizes.includes(settings.gameSize)),
    [category, settings.gameSize],
  );

  const log = (q: Question, answer: Answer) => {
    if (!seekers) return;
    const entry: AskEntry = {
      id: newAskId(),
      questionId: q.id,
      askedAt: Date.now(),
      origin: seekers,
      answer,
    };
    addAsk(entry);
  };

  /** Is the hider's own zone still standing under their own answers? */
  const mine = hiderStation
    ? evaluated.verdicts.find((v) => v.station.id === hiderStation.id)
    : null;

  return (
    <div className="panel">
      <div className="seg wide">
        <button className={view === 'answer' ? 'on' : ''} onClick={() => setView('answer')}>Answer</button>
        <button className={view === 'exposure' ? 'on' : ''} onClick={() => setView('exposure')}>
          Exposure ({round.asks.length})
        </button>
      </div>

      <div className="pad-x">
        {!hiderStation ? (
          <p className="muted">
            Tap a station on the map to claim it. Your hiding zone is the 500 m circle around it.
          </p>
        ) : (
          <div className="zonecard">
            <div>
              <b>{hiderStation.name}</b>
              <div className="muted small">
                {hiderStation.modes.join(', ')}
                {hiderStation.routes.length > 0 && ` · ${hiderStation.routes.slice(0, 8).join(' ')}`}
              </div>
            </div>
            <div className={drift !== null && drift > ZONE_RADIUS_M ? 'drift bad' : 'drift'}>
              {drift === null ? '—' : `${drift} m`}
              <span className="muted small"> from centre</span>
            </div>
            <button className="link" onClick={() => setHiderStation(undefined)}>Change</button>
          </div>
        )}

        {drift !== null && drift > ZONE_RADIUS_M && (
          <p className="warntext">You are outside your hiding zone. Head back inside the 500 m circle.</p>
        )}
      </div>

      {view === 'exposure' ? (
        <Exposure
          round={round}
          evaluated={evaluated}
          hiderStation={hiderStation}
          mineAlive={mine?.alive ?? true}
          seekers={seekers}
          onClearPin={() => setSeekerPin(undefined)}
          onRemove={removeAsk}
          onEnd={endRound}
        />
      ) : (
        <>
          <div className="pad-x">
            <div className={`seekerpin ${armSeekerPin ? 'armed' : ''}`}>
              <span className="grow">
                <b>Seekers</b>
                <span className="muted small">
                  {armSeekerPin
                    ? 'Now tap anywhere on the map.'
                    : seekers
                      ? 'Answers you log are measured from their pin.'
                      : 'Drop their pin, then logged answers show what they can deduce.'}
                </span>
              </span>
              <button
                className={armSeekerPin ? 'primary' : ''}
                onClick={() => setArmSeekerPin(!armSeekerPin)}
              >
                {armSeekerPin ? 'Cancel' : seekers ? 'Move pin' : 'Set pin'}
              </button>
              {seekers && !armSeekerPin && (
                <button className="link" onClick={() => setSeekerPin(undefined)}>Clear</button>
              )}
            </div>

            {manual.enabled ? (
              /*
               * With manual location on, the hider has two points to place —
               * their own and the seekers' — and one long press cannot mean
               * both. This picks which one a tap-and-hold moves.
               */
              <div className="placetarget">
                <span className="muted small">Tap and hold on the map places:</span>
                <div className="seg">
                  <button
                    className={placeTarget === 'me' ? 'on' : ''}
                    onClick={() => setPlaceTarget('me')}
                  >My position</button>
                  <button
                    className={placeTarget === 'seekers' ? 'on' : ''}
                    onClick={() => setPlaceTarget('seekers')}
                  >Seeker point</button>
                </div>
              </div>
            ) : (
              <p className="muted small">Tap an empty part of the map to place the seekers' pin.</p>
            )}
          </div>

          <h3 className="pad-x">Answer assistant</h3>
          {!here && <p className="pad-x warntext">No GPS fix, so answers cannot be computed yet.</p>}

          <div className="chips">
            {CATEGORY_ORDER.map((c) => {
              const n = QUESTIONS.filter((q) => q.category === c && q.sizes.includes(settings.gameSize)).length;
              if (!n) return null;
              return (
                <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>
                  {CATEGORY_META[c].title}
                </button>
              );
            })}
          </div>

          <ul className="qlist">
            {questions.map((q) => (
              <HiderAnswer key={q.id} q={q} data={data} here={here} seekers={seekers} onLog={log} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** What the seekers can work out from the answers already given. */
function Exposure(props: {
  round: Round;
  evaluated: Evaluated;
  hiderStation: Station | null;
  mineAlive: boolean;
  seekers: LngLat | null;
  onClearPin: () => void;
  onRemove: (id: string) => void;
  onEnd: () => void;
}) {
  const { round, evaluated, hiderStation, mineAlive, onRemove, onEnd } = props;
  const left = evaluated.alive.length;
  const total = evaluated.verdicts.length;

  return (
    <div className="pad">
      {round.asks.length === 0 ? (
        <p className="muted">
          Nothing logged yet. Drop the seekers' pin, then record each answer you give — the map
          will shade what they have ruled out.
        </p>
      ) : (
        <>
          <div className={`hint ${left <= 12 ? 'warn' : 'fact'}`}>
            <b>{left} of {total} zones still possible.</b>{' '}
            {left <= 12
              ? 'They are closing in. Consider a move powerup while you still can.'
              : 'You are still well hidden.'}
          </div>

          {hiderStation && !mineAlive && (
            <p className="warntext">
              Your own zone has been ruled out by your own answers. One of them is probably
              recorded wrong — check the list below, or the seekers' pin.
            </p>
          )}

          <ul className="list log">
            {round.asks.slice().reverse().map((a) => {
              const q = QUESTIONS_BY_ID[a.questionId];
              return (
                <li key={a.id}>
                  <div className="grow">
                    <div>
                      <b>{q?.label ?? a.questionId}</b>
                      <span className="answer"> {describe(a.answer)}</span>
                    </div>
                    <div className="muted small">{new Date(a.askedAt).toLocaleTimeString()}</div>
                  </div>
                  <button className="link danger" onClick={() => onRemove(a.id)}>Delete</button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <button className="link danger" onClick={onEnd}>End this round</button>
    </div>
  );
}

function describe(a: Answer): string {
  switch (a.kind) {
    case 'yesno': return a.value.toUpperCase();
    case 'closerFurther': return a.value.toUpperCase();
    case 'hotterColder': return a.value.toUpperCase();
    case 'tentacle': return a.poiId ? `→ ${a.poiId}` : 'NOT IN REACH';
    case 'null': return 'NULL';
    case 'photo': return 'photo sent';
  }
}

function HiderAnswer(props: {
  q: Question;
  data: GameData;
  here: LngLat | null;
  seekers: LngLat | null;
  onLog: (q: Question, a: Answer) => void;
}) {
  const { q, data, here, seekers, onLog } = props;
  const [open, setOpen] = useState(false);
  const answer = useMemo(() => (open && here ? computeAnswer(q, data, here) : null), [open, here, q, data]);

  /**
   * Only binary answers can be replayed from a single seeker position. A
   * thermometer needs the seeker's start *and* end pins, which the hider only
   * has once the seeker sends both — out of scope for the exposure view.
   */
  const loggable: { answer: Answer; label: string; tone: 'yes' | 'no' }[] | null =
    q.answerKind === 'yesno'
      ? [
          { answer: { kind: 'yesno', value: 'yes' }, label: 'Yes', tone: 'yes' },
          { answer: { kind: 'yesno', value: 'no' }, label: 'No', tone: 'no' },
        ]
      : q.answerKind === 'closerFurther'
        ? [
            { answer: { kind: 'closerFurther', value: 'closer' }, label: 'Closer', tone: 'yes' },
            { answer: { kind: 'closerFurther', value: 'further' }, label: 'Further', tone: 'no' },
          ]
        : null;

  return (
    <li className="qrow">
      <button className="qhead" onClick={() => setOpen(!open)}>
        <span className="qlabel">{q.label}</span>
        <span className="qsplit muted small">{q.timeLimitMin} min</span>
      </button>
      {open && (
        <div className="qbody">
          <p className="qtext">“{q.text}”</p>
          {q.spec && <p className="muted small"><b>Photo spec:</b> {q.spec}</p>}
          {q.caveat && <p className="muted small">{q.caveat}</p>}
          {answer ? (
            <p className={`hint ${answer.kind}`}>{answer.text}</p>
          ) : (
            <p className="muted small">Waiting for a GPS fix.</p>
          )}

          {loggable && (
            <>
              <p className="muted small">Log the answer you gave, to track what they now know:</p>
              <div className="row">
                {loggable.map((opt) => (
                  <button
                    key={opt.label}
                    className={opt.tone}
                    disabled={!seekers}
                    onClick={() => onLog(q, opt.answer)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {!seekers && (
                <p className="muted small">Drop the seekers' pin on the map first.</p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Compute the hider's truthful answer.
 *
 * Matching and measuring both depend on what the *seeker* is nearest to, which
 * the hider does not know — so for those the assistant reports the hider's own
 * nearest feature and distance, which is exactly what they need to answer once
 * the seeker states theirs.
 */
function computeAnswer(
  q: Question,
  data: GameData,
  here: LngLat,
): { kind: 'fact' | 'warn'; text: string } | null {
  if (q.category === 'photo') {
    return { kind: 'fact', text: 'Take the shot to the spec above. If the subject is not in your zone, "I cannot answer" is valid — and you still draw a card.' };
  }

  if (!q.layer) {
    if (q.id === 'match-station-name-s-length') {
      return { kind: 'fact', text: 'Count the characters of your station name, including spaces and hyphens.' };
    }
    return null;
  }

  const layer = data.layers[q.layer];
  if (!layer || layer.features.length === 0) {
    return { kind: 'warn', text: `No ${q.label.toLowerCase()} on the game map — the answer is NULL. You still draw a card.` };
  }

  const near = nearestFeature(here, layer);
  if (!near) return null;
  const name = (near.feature.properties?.name ?? near.feature.properties?.id ?? 'unnamed') as string;
  const km = (near.distanceM / 1000).toFixed(2);
  const mi = (near.distanceM / 1609.34).toFixed(2);

  if (q.category === 'matching') {
    return { kind: 'fact', text: `Your nearest ${q.label.toLowerCase()} is ${name} (${km} km / ${mi} mi). Answer YES only if that is the one they named.` };
  }
  if (q.category === 'measuring') {
    return { kind: 'fact', text: `You are ${km} km / ${mi} mi from your nearest ${q.label.toLowerCase()} (${name}). Closer than their number means CLOSER.` };
  }
  if (q.category === 'tentacle') {
    const reach = q.distanceM ?? 0;
    return near.distanceM <= reach
      ? { kind: 'fact', text: `Nearest is ${name}, ${km} km away.` }
      : { kind: 'warn', text: `Nearest is ${name} at ${km} km — beyond the ${reach / 1000} km reach, so answer "not within reach".` };
  }
  return null;
}

export { distanceToFeatureM };
