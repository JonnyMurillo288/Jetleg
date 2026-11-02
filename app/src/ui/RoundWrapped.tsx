import { useMemo, type ReactNode } from 'react';
import { useGame, type Round } from '../store/game';
import { roundStats, type QuestionStat, type RoundStats, type StatsBoard } from '../stats/wrapped';
import type { Category } from '../engine/types';
import type { Strictness } from '../engine/candidates';
import { describeAnswer } from './AskLog';
import { formatDistance } from './units';
import { formatShare, formatSpan } from './time';

const CATEGORY_NAMES: Record<Category, string> = {
  matching: 'Matching',
  measuring: 'Measuring',
  radar: 'Radar',
  thermometer: 'Thermometer',
  photo: 'Photo',
  tentacle: 'Tentacles',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = (q: QuestionStat) => q.question?.label ?? q.ask.questionId;

/**
 * A round looked back on — the same view for a round on this device, one in
 * the Results tab, and one opened from a file.
 *
 * `board` is the board the round was played on, already entered into the
 * engine by the caller, or null when this device does not have it. Without
 * it nothing about zones or the hider is shown — see stats/wrapped.ts.
 */
export function RoundWrapped(props: {
  round: Round;
  board: StatsBoard | null;
  /** How strictly the round is scored; a file's own setting, where it has one. */
  strictness?: Strictness;
  /** Said in place of the zone numbers when there is no board. */
  boardNote?: ReactNode;
  /** Lets a finished seeking round be told where the hider was. */
  onHiderStation?: (stationId: string | undefined) => void;
}) {
  const { round, board } = props;
  const units = useGame((s) => s.settings.units);
  const ownStrictness = useGame((s) => s.settings.strictness);
  const strictness = props.strictness ?? ownStrictness;

  const stats = useMemo(() => roundStats(round, board, strictness), [round, board, strictness]);
  const stations = useMemo(
    () => (board ? board.stations.slice().sort((a, b) => a.name.localeCompare(b.name)) : []),
    [board],
  );

  const hiding = round.role === 'hider';
  const dist = (m: number) => formatDistance(m, units);
  const n = stats.questions.length;

  return (
    <div className="wrapped">
      {!stats.hasBoard && props.boardNote && <p className="hint warn">{props.boardNote}</p>}

      <div className="resultstats">
        {stats.hasBoard && (
          <div className="stat">
            <strong>{stats.left}</strong>
            <span className="muted small">of {stats.total} zones still possible</span>
          </div>
        )}
        <div className="stat">
          <strong>{n}</strong>
          <span className="muted small">question{n === 1 ? '' : 's'} asked</span>
        </div>
        <div className="stat">
          <strong>{formatSpan(stats.durationMs)}</strong>
          <span className="muted small">{round.endedAt ? 'start to finish' : 'so far'}</span>
        </div>
        {stats.hider && (
          <div className="stat">
            <strong>{stats.hider.station.name}</strong>
            <span className="muted small">{hiding ? 'claimed station' : "hider's station"}</span>
          </div>
        )}
        {stats.cardsDrawn > 0 && (
          <div className="stat">
            <strong>{stats.cardsDrawn}</strong>
            <span className="muted small">cards drawn by the hider, {stats.cardsKept} kept</span>
          </div>
        )}
        {stats.travelledM >= 50 && (
          <div className="stat">
            <strong>{dist(stats.travelledM)}</strong>
            <span className="muted small">between questions, as the crow flies</span>
          </div>
        )}
      </div>

      {props.onHiderStation && board && !hiding && round.endedAt && (
        <label className="field hiderpick">
          <span>Where was the hider? <span className="muted">Tell the round, and it can say how close each question was.</span></span>
          <select value={round.hiderStationId ?? ''} onChange={(e) => props.onHiderStation!(e.target.value || undefined)}>
            <option value="">Not recorded</option>
            {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}

      {n === 0 ? (
        <p className="muted">No questions were logged this round.</p>
      ) : (
        <>
          <Highlights stats={stats} hiding={hiding} dist={dist} />

          <h3>Question by question</h3>
          {stats.hasBoard && (
            <p className="muted small cutlegend">
              <span><span className="cutbar"><span className="cut-left" /></span>still possible</span>
              <span><span className="cutbar"><span className="cut-gone" /></span>ruled out by this answer</span>
              <span><span className="cutbar"><span className="cut-past" /></span>already gone</span>
            </p>
          )}
          <ol className="qcards">
            {stats.questions.map((q) => (
              <QuestionCard key={q.ask.id} q={q} stats={stats} hiding={hiding} dist={dist} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

type Shared = { stats: RoundStats; hiding: boolean; dist: (m: number) => string };

function Highlight(props: { kicker: string; title: ReactNode; children: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className={`highlight ${props.tone ?? ''}`}>
      <span className="kicker">{props.kicker}</span>
      <strong>{props.title}</strong>
      <span className="muted small">{props.children}</span>
    </div>
  );
}

/** "Park — NO": the question and what came back. */
const asked = (q: QuestionStat) => <>{nameOf(q)} <span className="answer">{describeAnswer(q.ask.answer)}</span></>;
const cut = (q: QuestionStat) => `${q.before} → ${q.after} zones`;

function Highlights({ stats, hiding, dist }: Shared) {
  const { best, worst, biggestCut, halfway, longestGap, shortestGap, closest, farthest, hider } = stats;
  const first = stats.questions[0];
  const top = stats.categories[0];
  const located = stats.questions.filter((q) => q.toHiderM !== null);
  const opening = located[0];
  const closing = located[located.length - 1];

  return (
    <div className="highlights">
      {best && (
        <Highlight kicker={hiding ? 'Your most revealing answer' : 'Best question'} title={asked(best)} tone="good">
          Question {best.number} cut {formatShare(best.share!)} of what was left — {cut(best)}.
        </Highlight>
      )}
      {worst && (
        <Highlight kicker={hiding ? 'Your safest answer' : 'Weakest question'} title={asked(worst)} tone="bad">
          {worst.eliminated === 0
            ? <>Question {worst.number} ruled out nothing{worst.cardsDrawn ? <>, and {hiding ? 'still earned you' : 'still handed the hider'} {plural(worst.cardsDrawn, 'card')} to draw</> : ''}.</>
            : <>Question {worst.number} cut only {formatShare(worst.share!)} of what was left — {cut(worst)}.</>}
        </Highlight>
      )}
      {biggestCut && (
        <Highlight kicker="Biggest single cut" title={asked(biggestCut)}>
          Question {biggestCut.number} removed {plural(biggestCut.eliminated!, 'zone')} in one go — {cut(biggestCut)}.
        </Highlight>
      )}
      {halfway && (
        <Highlight kicker="Halfway there" title={`Question ${halfway.number}`}>
          {nameOf(halfway)} took the board below half, {formatSpan(halfway.ask.askedAt - first.ask.askedAt + first.gapMs)} into the round.
        </Highlight>
      )}
      {stats.duds > 1 && (
        <Highlight kicker="Came back empty" title={plural(stats.duds, 'question')}>
          {stats.duds} answers ruled out nothing that was not already gone.
        </Highlight>
      )}

      {hider && (
        hider.alive ? (
          <Highlight kicker={hiding ? 'Still hidden' : 'Never lost the trail'} title={hider.station.name} tone="good">
            {hiding ? 'Your zone' : 'The real zone'} survived every answer — one of {stats.left} left standing at the end.
          </Highlight>
        ) : (
          <Highlight kicker="The one that got away" title={hider.ruledOutBy ? asked(hider.ruledOutBy) : hider.station.name} tone="bad">
            Question {hider.ruledOutBy?.number} ruled out {hider.station.name} — the zone the hider was actually in. A wrong answer,
            or a hider near the edge of their circle.
          </Highlight>
        )
      )}
      {closest && (
        <Highlight kicker={hiding ? 'Closest they came' : 'Closest you got'} title={dist(closest.toHiderM!)}>
          {hiding ? 'From you' : 'From the hider'} when question {closest.number} ({nameOf(closest)}) was asked.
          {farthest && farthest !== closest && <> Farthest: {dist(farthest.toHiderM!)}, at question {farthest.number}.</>}
        </Highlight>
      )}
      {opening && closing && opening !== closing && (
        <Highlight
          kicker={closing.toHiderM! < opening.toHiderM! ? 'Getting warmer' : 'Getting colder'}
          title={`${dist(opening.toHiderM!)} → ${dist(closing.toHiderM!)}`}
        >
          Distance {hiding ? 'to you' : 'to the hider'} at the first question and at the last.
        </Highlight>
      )}

      {longestGap && (
        <Highlight kicker="Longest wait" title={formatSpan(longestGap.gapMs)}>
          Between question {longestGap.number - 1} and question {longestGap.number} ({nameOf(longestGap)}).
        </Highlight>
      )}
      {shortestGap && shortestGap !== longestGap && (
        <Highlight kicker="Quickest follow-up" title={formatSpan(shortestGap.gapMs)}>
          Question {shortestGap.number} ({nameOf(shortestGap)}) came straight after the one before.
        </Highlight>
      )}
      {stats.averageGapMs !== null && (
        <Highlight kicker="Pace" title={`A question every ${formatSpan(stats.averageGapMs)}`}>
          On average. The first came {formatSpan(first.gapMs)} after the round started.
        </Highlight>
      )}
      {top && stats.categories.length > 1 && (
        <Highlight kicker="Go-to category" title={CATEGORY_NAMES[top.category]}>
          {plural(top.count, 'question')} of {stats.questions.length}
          {stats.categories.slice(1, 3).map((c) => `, then ${CATEGORY_NAMES[c.category]} (${c.count})`).join('')}.
        </Highlight>
      )}
    </div>
  );
}

function QuestionCard({ q, stats, hiding, dist }: Shared & { q: QuestionStat }) {
  const total = stats.total ?? 0;
  const tags: { text: string; tone: string }[] = [];
  if (q === stats.best) tags.push({ text: hiding ? 'Most revealing' : 'Best', tone: 'good' });
  if (q === stats.worst) tags.push({ text: hiding ? 'Safest' : 'Weakest', tone: 'warn' });
  if (q === stats.hider?.ruledOutBy) tags.push({ text: 'Ruled out the real zone', tone: 'warn' });
  if (q.ask.disabled) tags.push({ text: 'Disabled', tone: '' });

  return (
    <li className={`qcard ${q.ask.disabled ? 'muted' : ''}`}>
      <div className="qcard-head">
        <span className="qnum">{q.number}</span>
        <div className="grow">
          <div>
            <b>{nameOf(q)}</b>
            <span className="answer"> {describeAnswer(q.ask.answer)}</span>
            {tags.map((t) => <span key={t.text} className={`tag ${t.tone}`}>{t.text}</span>)}
          </div>
          <div className="muted small">
            {q.question ? CATEGORY_NAMES[q.question.category] : 'Unknown question'}
            {' · '}{new Date(q.ask.askedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            {' · '}{formatSpan(q.gapMs)} {q.number === 1 ? 'after the start' : 'after the last'}
          </div>
        </div>
      </div>

      {stats.hasBoard && total > 0 && (
        q.scored ? (
          <div className="cutrow">
            {/* One bar, the whole board wide: what is still standing, what this answer took. */}
            <div
              className="cutbar"
              role="img"
              aria-label={`${q.before} zones before, ${q.after} after`}
              title={`${q.after} still possible · ${q.eliminated} removed by this answer · ${total - q.before!} already gone`}
            >
              {q.after! > 0 && <span className="cut-left" style={{ flexGrow: q.after! }} />}
              {q.eliminated! > 0 && <span className="cut-gone" style={{ flexGrow: q.eliminated! }} />}
              {total - q.before! > 0 && <span className="cut-past" style={{ flexGrow: total - q.before! }} />}
            </div>
            <span className="cutnums small">
              {q.before} → <b>{q.after}</b> zones
              <span className="muted"> · {q.eliminated === 0 ? 'ruled out nothing' : `cut ${formatShare(q.share!)}`}</span>
            </span>
          </div>
        ) : (
          <div className="muted small">
            {q.ask.disabled
              ? 'Left out of the map.'
              : q.question?.category === 'photo'
                ? 'A photo: nothing the map can score.'
                : 'No constraint: this board does not carry what the question asks about.'}
          </div>
        )
      )}

      <div className="muted small qmeta">
        {[
          q.toHiderM !== null && `${dist(q.toHiderM)} ${hiding ? 'from you' : 'from the hider'}`,
          q.movedM >= 50 && `${dist(q.movedM)} since the last question`,
          q.scored && q.decisive! > 0 && `only this rules out ${plural(q.decisive!, 'zone')}`,
          q.question && q.cardsDrawn > 0 && q.question.draw,
        ].filter(Boolean).join(' · ')}
      </div>
      {q.ask.note && <div className="small qnote">{q.ask.note}</div>}
    </li>
  );
}
