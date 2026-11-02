import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GameData } from '../data/load';
import type { LocalGame } from '../live/room';
import type { Answer, AskEntry, Category, LngLat, Question, Role } from '../engine/types';
import { CATEGORY_META, CATEGORY_ORDER, QUESTIONS, QUESTIONS_BY_ID } from '../engine/questions';
import { useGame } from '../store/game';
import { answerChoices, answerLabel, answerTiming, openQuestions, threadRows, type ChatQuestion, type ChatSubject } from '../chat/chat';
import type { GameChat } from '../chat/useGameChat';
import { computeAnswer } from './HiderPanel';
import { subjectFor } from '../chat/subject';
import { Countdown, Lightbox, PhotoThumb } from './ChatPhotos';
import { formatDistance, fromRadiusInput, radiusUnit, toRadiusInput } from './units';

export type AskExtra = Partial<Pick<AskEntry, 'distanceM' | 'origin' | 'destination'>>;

/**
 * The game chat: a Questions thread and a Chat thread, kept apart.
 *
 * Questions is the game itself. A seeker picks one of the catalog's
 * questions and asks it; every phone in the game shows it with the clock
 * running; a hider answers by tapping. The app never answers for them. The
 * hider sees what the answer assistant reads, as on their own panel, but
 * nothing is sent until they choose an answer and confirm it.
 *
 * Chat is everything else.
 */
export function ChatPanel(props: {
  game: LocalGame | null;
  chat: GameChat;
  role: Role;
  /** A round of this role is being played: asking and answering need one. */
  playing: boolean;
  data: GameData;
  /** This device's own position (the hider's, when hiding). */
  origin: LngLat | null;
  /** Hider: where to measure an answer from when the asker's dot is not live. */
  seekerPoint: LngLat | null;
  /** Hider: live seekers, so a question is measured from whoever asked it. */
  seekerDots: { id: string; coords: LngLat }[];
  pins: { start?: LngLat; end?: LngLat };
  onAsk: (q: Question, extra?: AskExtra) => Promise<string | null>;
  /** Hider: an answer was sent — log it locally. Returns why not, if not. */
  onAnswered: (cq: ChatQuestion, answer: Answer) => string | null;
  onOpenGame: () => void;
}) {
  const { game, chat } = props;
  const [view, setView] = useState<'questions' | 'chat'>('questions');
  /** The photo open full size: its question's id, which is also its key on this phone. */
  const [photo, setPhoto] = useState<{ id: string; caption: string } | null>(null);
  // Held here, not on the card: an answered card moves to the other list,
  // which remounts it, and a note on it would vanish as it was set.
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (!game) {
    return (
      <div className="pad">
        <h2>Game chat</h2>
        <p className="muted">
          Questions and chat are shared with everyone in your game. Create or join one first.
        </p>
        <button className="primary" onClick={props.onOpenGame}>Create or join a game</button>
      </div>
    );
  }

  const open = openQuestions(chat.questions);
  return (
    <div className={`panel chatpanel ${view === 'chat' ? 'chatview' : ''}`}>
      <div className="seg wide">
        <button className={view === 'questions' ? 'on' : ''} onClick={() => setView('questions')}>
          Questions{open.length ? ` · ${open.length} open` : ''}
        </button>
        <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>
          Chat{chat.messages.length ? ` (${chat.messages.length})` : ''}
        </button>
      </div>
      {chat.status === 'error' && <p className="pad-x warntext">Lost the connection to the game. Reconnecting…</p>}

      {view === 'questions'
        ? <Questions
            {...props}
            game={game}
            notes={notes}
            onAnswered={(cq, answer) => {
              const note = props.onAnswered(cq, answer);
              if (note) setNotes((n) => ({ ...n, [cq.id]: note }));
              return note;
            }}
            onPhoto={(id, caption) => setPhoto({ id, caption })}
          />
        : <Chat game={game} chat={chat} />}

      {photo && chat.photos[photo.id] && (
        <Lightbox url={chat.photos[photo.id]} caption={photo.caption} onClose={() => setPhoto(null)} />
      )}
    </div>
  );
}

function Questions(props: Parameters<typeof ChatPanel>[0] & {
  game: LocalGame;
  notes: Record<string, string>;
  onPhoto: (questionId: string, caption: string) => void;
}) {
  const { chat, role, playing, game } = props;
  const open = openQuestions(chat.questions);
  const answered = chat.questions.filter((q) => q.answer);

  return (
    <>
      {role === 'seeker' && (playing
        ? <AskComposer onAsk={props.onAsk} pins={props.pins} data={props.data} origin={props.origin} />
        : <p className="pad-x muted small">Start a seeking round on the Play tab to ask questions here.</p>)}
      {role === 'hider' && !playing && (
        <p className="pad-x muted small">Start a hiding round on the Play tab to answer questions here.</p>
      )}

      {chat.questions.length === 0 && (
        <p className="pad-x muted">
          No questions yet. {role === 'seeker' ? 'Ask one above — the hider’s clock starts the moment you do.' : 'When a seeker asks, it appears here with the clock running.'}
        </p>
      )}

      {open.length > 0 && (
        <>
          <h3 className="pad-x">Waiting for an answer</h3>
          <ul className="cqlist">
            {open.map((cq) => (
              <ChatQuestionCard key={cq.id} cq={cq} {...props} me={game.profileId} note={props.notes[cq.id]} />
            ))}
          </ul>
        </>
      )}
      {answered.length > 0 && (
        <>
          <h3 className="pad-x">Answered</h3>
          <ul className="cqlist">
            {answered.map((cq) => (
              <ChatQuestionCard key={cq.id} cq={cq} {...props} me={game.profileId} note={props.notes[cq.id]} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** The seeker's way in: the catalog, by category, as on the Ask tab. */
function AskComposer(props: {
  onAsk: (q: Question, extra?: AskExtra) => Promise<string | null>;
  pins: { start?: LngLat; end?: LngLat };
  data: GameData;
  /** Where the seeker stands: their nearest one is named with the question. */
  origin: LngLat | null;
}) {
  const settings = useGame((s) => s.settings);
  const [category, setCategory] = useState<Category>('matching');
  const [questionId, setQuestionId] = useState('');
  const [chooseM, setChooseM] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(
    () => QUESTIONS.filter((q) => q.category === category && q.sizes.includes(settings.gameSize)),
    [category, settings.gameSize],
  );
  const q = QUESTIONS_BY_ID[questionId] && QUESTIONS_BY_ID[questionId].category === category ? QUESTIONS_BY_ID[questionId] : null;
  const thermoReady = !!props.pins.start && !!props.pins.end;

  const ask = async () => {
    if (!q) return;
    setBusy(true);
    setError(null);
    const extra: AskExtra | undefined =
      q.id === 'radar-choose' ? { distanceM: chooseM }
      : q.category === 'thermometer' ? { origin: props.pins.start!, destination: props.pins.end! }
      : undefined;
    const err = await props.onAsk(q, extra);
    setBusy(false);
    if (err) setError(err);
    else setQuestionId('');
  };

  return (
    <div className="askcomposer">
      <div className="chips">
        {CATEGORY_ORDER.map((c) => {
          if (!QUESTIONS.some((x) => x.category === c && x.sizes.includes(settings.gameSize))) return null;
          return (
            <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => { setCategory(c); setQuestionId(''); }}>
              {CATEGORY_META[c].title}
            </button>
          );
        })}
      </div>
      <div className="pad-x col">
        <select value={q ? q.id : ''} onChange={(e) => setQuestionId(e.target.value)} aria-label="Question to ask">
          <option value="">{CATEGORY_META[category].blurb}</option>
          {available.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        {q && (
          <>
            <p className="qtext">“{q.id === 'radar-choose' ? `Are you within ${formatDistance(chooseM, settings.units)} of me?` : q.text}”</p>
            <SubjectLine q={q} subject={subjectFor(q, props.origin, props.data)} who="Your" units={settings.units} />
            {q.spec && <p className="muted small"><b>Photo spec:</b> {q.spec}</p>}
            {q.caveat && <p className="muted small">{q.caveat}</p>}
            {q.id === 'radar-choose' && (
              <label className="row small">
                Distance
                <input className="num" type="number" min={1} step={settings.units === 'metric' ? 50 : 100}
                  value={toRadiusInput(chooseM, settings.units)}
                  onChange={(e) => setChooseM(fromRadiusInput(Number(e.target.value) || 0, settings.units))} />
                {radiusUnit(settings.units)}
              </label>
            )}
            {q.category === 'thermometer' && !thermoReady && (
              <p className="warntext">Set your start and end pins on the Play tab’s Thermometer first.</p>
            )}
            <button
              className="primary"
              disabled={busy || (q.category === 'thermometer' && !thermoReady)}
              onClick={ask}
            >
              {busy ? 'Asking…' : `Ask · ${q.timeLimitMin} min to answer · ${q.draw}`}
            </button>
          </>
        )}
        {error && <p className="warntext">{error}</p>}
      </div>
    </div>
  );
}

function ChatQuestionCard(props: Parameters<typeof ChatPanel>[0] & {
  cq: ChatQuestion;
  me: string;
  /** Said about this card's answer once it was sent, e.g. why it is not in the exposure log. */
  note?: string;
  onPhoto: (questionId: string, caption: string) => void;
}) {
  const { cq, role, playing, data } = props;
  const q = QUESTIONS_BY_ID[cq.questionId];
  const units = useGame((s) => s.settings.units);
  const timing = answerTiming(cq);
  const label = q?.label ?? cq.questionId;
  const poiName = (id: string) => {
    const layer = q?.layer ? data.layers[q.layer] : undefined;
    const f = layer?.features.find((f, i) => (f.properties?.id ?? f.properties?.name ?? String(i)) === id);
    return (f?.properties?.name as string | undefined) ?? id;
  };

  return (
    <li className={`cq ${cq.answer ? 'done' : 'waiting'}`} data-question={cq.questionId}>
      <div className="cq-head">
        <span className="tag">{q ? CATEGORY_META[q.category].title : 'Question'}</span>
        <b className="grow">{label}</b>
        {cq.answer
          ? <span className={`answerchip ${cq.answer.kind}`}>{answerLabel(cq.answer, poiName)}</span>
          : <Countdown deadline={cq.deadlineAt} />}
      </div>
      <p className="qtext">“{cq.text}”</p>
      {q && (
        <SubjectLine
          q={q}
          subject={cq.subject}
          who={cq.askedBy === props.me ? 'Your' : `${cq.askerName}’s`}
          units={units}
        />
      )}
      <p className="muted small">
        {cq.askedBy === props.me ? 'You' : cq.askerName}{cq.askerTeam ? ` (${cq.askerTeam})` : ''} asked at {clockTime(cq.askedAt)}
        {timing && <> · {cq.answeredBy === props.me ? 'you' : cq.answererName} answered in {timing.took}{timing.late && <b className="warntext"> — late</b>}</>}
      </p>
      {cq.photo && (
        <PhotoThumb url={props.chat.photos[cq.id]} label={label} onOpen={() => props.onPhoto(cq.id, `${label} · from ${cq.answererName ?? 'the hider'}`)} />
      )}
      {props.note && <p className="warntext">{props.note}</p>}
      {!cq.answer && role === 'seeker' && <p className="muted small">Waiting for the hider to answer.</p>}
      {!cq.answer && role === 'hider' && playing && q && (
        <AnswerBox
          chat={props.chat}
          cq={cq}
          q={q}
          data={data}
          assist={(() => {
            if (!props.origin) return null;
            const asker = props.seekerDots.find((d) => d.id === cq.askedBy)?.coords ?? props.seekerPoint;
            return computeAnswer(cq.distanceM ? { ...q, distanceM: cq.distanceM } : q, data, props.origin, asker, units);
          })()}
          onAnswered={props.onAnswered}
        />
      )}
    </li>
  );
}

/**
 * The asker's own nearest one, the blank in "is your nearest ___ the same
 * as mine?" filled in: "Sam's nearest library: Main Library". For measuring,
 * with how far they are from it, in this phone's units.
 */
function SubjectLine(props: { q: Question; subject: ChatSubject | null; who: string; units: 'imperial' | 'metric' }) {
  const { q, subject } = props;
  if (!subject) return null;
  return (
    <p className="subject">
      {props.who} nearest {q.label.toLowerCase()}: <b>{subject.name}</b>
      {subject.distanceM !== null && <span className="muted"> · {formatDistance(subject.distanceM, props.units)} away</span>}
    </p>
  );
}

/**
 * How a hider answers. Choosing an answer and sending it are two taps: an
 * answer is final, and a thumb on a moving bus misses.
 */
function AnswerBox(props: {
  chat: GameChat;
  cq: ChatQuestion;
  q: Question;
  data: GameData;
  assist: { kind: 'fact' | 'warn'; text: string } | null;
  onAnswered: (cq: ChatQuestion, answer: Answer) => void;
}) {
  const { cq, q, data } = props;
  const [chosen, setChosen] = useState<{ answer: Answer; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const finish = (res: { ok: true; value: ChatQuestion } | { ok: false; error: string }, answer: Answer) => {
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    props.onAnswered(res.value, answer);
  };
  const send = async (answer: Answer) => {
    setBusy(true);
    setError(null);
    finish(await props.chat.answer(cq, answer), answer);
  };
  const sendPhoto = async (f: File) => {
    setBusy(true);
    setError(null);
    finish(await props.chat.answerPhoto(cq, f), { kind: 'photo' });
  };

  const choices = answerChoices(cq.answerKind);
  const layer = q.layer ? data.layers[q.layer] : undefined;

  return (
    <div className="answerbox">
      {props.assist && <p className={`hint ${props.assist.kind}`}><span className="muted small">Assistant: </span>{props.assist.text}</p>}

      {chosen ? (
        <div className="row">
          <button className="primary grow" disabled={busy} onClick={() => send(chosen.answer)}>
            {busy ? 'Sending…' : `Send “${chosen.label}”`}
          </button>
          <button className="link" disabled={busy} onClick={() => setChosen(null)}>Change</button>
        </div>
      ) : cq.answerKind === 'photo' ? (
        <div className="col">
          <input
            ref={file}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendPhoto(f); }}
          />
          <button className="primary" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? 'Sending photo…' : 'Take or choose the photo'}
          </button>
          <p className="muted small">
            Its location data is removed before it leaves this phone. It goes straight to the other players’ phones and is kept on no server.
          </p>
        </div>
      ) : cq.answerKind === 'tentacle' ? (
        <select
          defaultValue=""
          disabled={busy}
          aria-label="Which one are you nearest to?"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const none = v === '__none__';
            const name = none ? 'Not within reach' : (layer?.features.find((f, i) => (f.properties?.id ?? f.properties?.name ?? String(i)) === v)?.properties?.name as string | undefined) ?? v;
            setChosen({ answer: { kind: 'tentacle', poiId: none ? null : v }, label: name });
          }}
        >
          <option value="">Which one are you nearest to?</option>
          <option value="__none__">Not within reach</option>
          {layer?.features.map((f, i) => {
            const id = (f.properties?.id ?? f.properties?.name ?? String(i)) as string;
            return <option key={id} value={id}>{f.properties?.name ?? id}</option>;
          })}
        </select>
      ) : (
        <div className="row">
          {choices.map((c) => (
            <button key={c.label} className={c.tone} disabled={busy} onClick={() => setChosen(c)}>{c.label}</button>
          ))}
        </div>
      )}

      {!chosen && (
        <button className="link small" disabled={busy} onClick={() => setChosen({ answer: { kind: 'null' }, label: cq.answerKind === 'photo' ? 'I can’t take this photo' : 'Null — none on the map' })}>
          {cq.answerKind === 'photo' ? 'I can’t take this photo' : 'Answer null (no such thing on the map)'}
        </button>
      )}
      {error && <p className="warntext">{error}</p>}
    </div>
  );
}

type Pending = { id: string; body: string; failed: string | null };

/**
 * The Chat section, laid out like a messaging app: bubbles, yours on the
 * right; runs grouped with the name over the first and the time under the
 * last; a line for each day; the box to type in pinned to the bottom. A
 * message shows the moment it is sent, marked "Sending…" until the relay has
 * it, and "Not sent" with a retry if it never does.
 */
function Chat(props: { game: LocalGame; chat: GameChat }) {
  const { game, chat } = props;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const thread = useRef<HTMLDivElement>(null);
  /** Follow new messages only while the reader is at the bottom, as messaging apps do. */
  const following = useRef(true);
  const rows = useMemo(() => threadRows(chat.messages, game.profileId, Date.now()), [chat.messages, game.profileId]);

  useLayoutEffect(() => {
    const el = thread.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, pending.length]);

  const deliver = async (p: Pending) => {
    const res = await chat.say(p.body);
    setPending((ps) => (res.ok ? ps.filter((x) => x.id !== p.id) : ps.map((x) => (x.id === p.id ? { ...x, failed: res.error } : x))));
  };
  const send = () => {
    const body = draft.trim();
    if (!body) return;
    const p: Pending = { id: `${Date.now()}-${Math.random()}`, body, failed: null };
    setPending((ps) => [...ps, p]);
    setDraft('');
    following.current = true;
    void deliver(p);
  };
  const retry = (p: Pending) => {
    setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, failed: null } : x)));
    void deliver(p);
  };

  return (
    <div className="messenger">
      <div
        className="thread"
        ref={thread}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {rows.length === 0 && pending.length === 0 && (
          <div className="thread-empty">
            <b>No messages yet</b>
            <span>Trash talk, rulings and “where ARE you” go here. Questions have their own tab.</span>
          </div>
        )}
        {rows.map((r) =>
          r.kind === 'day' ? (
            <div key={r.key} className="dayline"><span>{r.label}</span></div>
          ) : (
            <div key={r.key} className={`msg ${r.mine ? 'mine' : 'theirs'} ${r.first ? 'first' : ''} ${r.last ? 'last' : ''}`}>
              {r.first && !r.mine && (
                <div className="msg-who">
                  {r.message.authorName} <span className={`tag ${r.message.authorRole}`}>{r.message.authorRole}</span>
                </div>
              )}
              <div className="bubble">{r.message.body}</div>
              {r.last && <div className="msg-time">{clockTime(r.message.createdAt)}</div>}
            </div>
          ),
        )}
        {pending.map((p) => (
          <div key={p.id} className={`msg mine first last pending ${p.failed ? 'failed' : ''}`}>
            <div className="bubble">{p.body}</div>
            <div className="msg-time">
              {p.failed
                ? <button className="link danger small" onClick={() => retry(p)} title={p.failed}>Not sent · Tap to retry</button>
                : 'Sending…'}
            </div>
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input
          type="text"
          value={draft}
          maxLength={500}
          placeholder="Message"
          enterKeyHint="send"
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="sendbtn" disabled={!draft.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}

const clockTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
