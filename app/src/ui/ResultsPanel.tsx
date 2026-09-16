import { useMemo, useState } from 'react';
import type { GameData } from '../data/load';
import { useGame, type Round } from '../store/game';
import { evaluate } from '../engine/candidates';
import { QUESTIONS_BY_ID } from '../engine/questions';
import { formatDistance } from './units';
import { describeAnswer } from './AskLog';

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Finished rounds, read-only. Every number here is recomputed from the same
 * ask log the live game uses — `evaluate()`, not a second tally kept
 * alongside it — so a result can never disagree with what the round actually
 * showed while it was in progress.
 */
export function ResultsPanel(props: { data: GameData }) {
  const { data } = props;
  const rounds = useGame((s) => s.rounds);
  const [openId, setOpenId] = useState<string | null>(null);

  const finished = useMemo(
    () => rounds.filter((r) => r.endedAt).slice().sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    [rounds],
  );

  const open = openId ? finished.find((r) => r.id === openId) : undefined;
  if (open) return <RoundResult round={open} data={data} onBack={() => setOpenId(null)} />;

  return (
    <div className="pad">
      <h2>Results</h2>
      {finished.length === 0 ? (
        <p className="muted">No finished rounds yet. End a round from the Play tab and it shows up here.</p>
      ) : (
        <ul className="list results">
          {finished.map((r) => (
            <li key={r.id}>
              <button className="link grow" onClick={() => setOpenId(r.id)}>
                {r.label}
                <span className="muted">
                  {' · '}{r.role === 'seeker' ? 'Seeking' : 'Hiding'}
                  {' · '}{new Date(r.startedAt).toLocaleDateString()}
                  {' · '}{formatDuration((r.endedAt ?? r.startedAt) - r.startedAt)}
                  {` · ${r.asks.length} question${r.asks.length === 1 ? '' : 's'}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoundResult(props: { round: Round; data: GameData; onBack: () => void }) {
  const { round, data, onBack } = props;
  const units = useGame((s) => s.settings.units);
  const strictness = useGame((s) => s.settings.strictness);

  const evaluated = useMemo(
    () => evaluate(data.stations, round.asks, QUESTIONS_BY_ID, data.layers, data.boundary, strictness),
    [data, round.asks, strictness],
  );

  const station = round.hiderStationId ? data.stations.find((s) => s.id === round.hiderStationId) : undefined;
  const left = evaluated.alive.length;
  const total = evaluated.verdicts.length;

  return (
    <div className="pad">
      <button className="link" onClick={onBack}>← Back to results</button>
      <h2>{round.label}</h2>
      <p className="muted">
        {round.role === 'seeker' ? 'Seeking' : 'Hiding'}
        {' · '}{new Date(round.startedAt).toLocaleString()}
        {' · '}{formatDuration((round.endedAt ?? round.startedAt) - round.startedAt)}
      </p>

      <div className="resultstats">
        <div className="stat">
          <strong>{left}</strong>
          <span className="muted small">of {total} zones still possible</span>
        </div>
        <div className="stat">
          <strong>{round.asks.length}</strong>
          <span className="muted small">question{round.asks.length === 1 ? '' : 's'} asked</span>
        </div>
        {station && (
          <div className="stat">
            <strong>{station.name}</strong>
            <span className="muted small">{round.role === 'hider' ? 'claimed station' : "hider's station"}</span>
          </div>
        )}
      </div>

      {round.asks.length === 0 ? (
        <p className="muted">No questions were logged this round.</p>
      ) : (
        <ul className="list log">
          {round.asks.map((a) => {
            const q = QUESTIONS_BY_ID[a.questionId];
            const resolved = evaluated.resolved.find((r) => r.entry.id === a.id);
            return (
              <li key={a.id} className={a.disabled ? 'muted' : ''}>
                <div className="grow">
                  <div>
                    <b>{q?.label ?? a.questionId}</b>
                    <span className="answer"> {describeAnswer(a.answer)}</span>
                  </div>
                  <div className="muted small">
                    {new Date(a.askedAt).toLocaleTimeString()}
                    {resolved?.radiusM !== undefined && ` · ${formatDistance(resolved.radiusM, units)} from nearest`}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
