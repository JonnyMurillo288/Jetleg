import { useMemo, useState } from 'react';
import type { GameData } from '../data/load';
import { useGame, type Round } from '../store/game';
import { sameBoard } from '../community/active';
import { RoundWrapped } from './RoundWrapped';

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Finished rounds, read-only. Every number here is recomputed from the same
 * ask log the live game uses — `evaluate()`, by way of stats/wrapped.ts, not
 * a second tally kept alongside it — so a result can never disagree with
 * what the round actually showed while it was in progress.
 */
type Resume = {
  /** Play a round again; resolves to why not, if it could not be. */
  onResume: (r: Round) => Promise<string | null>;
  /** Has a pass, and no round in progress. */
  canResume: boolean;
  roundActive: boolean;
};

export function ResultsPanel(props: { data: GameData } & Resume) {
  const { data } = props;
  const rounds = useGame((s) => s.rounds);
  const [openId, setOpenId] = useState<string | null>(null);

  const finished = useMemo(
    () => rounds.filter((r) => r.endedAt).slice().sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    [rounds],
  );

  const open = openId ? finished.find((r) => r.id === openId) : undefined;
  if (open) {
    return (
      <RoundResult round={open} data={data} onBack={() => setOpenId(null)}
        onResume={props.onResume} canResume={props.canResume} roundActive={props.roundActive} />
    );
  }

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

function RoundResult(props: { round: Round; data: GameData; onBack: () => void } & Resume) {
  const { round, data, onBack } = props;
  const setRoundHiderStation = useGame((s) => s.setRoundHiderStation);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Zone counts are only meaningful against the stations the round was
  // actually played on. On any other board, say so instead of showing a
  // number computed from the wrong set.
  const currentBoard = useGame((s) => s.board);
  const otherBoard = !sameBoard(round.board, currentBoard);

  return (
    <div className="pad">
      <button className="link" onClick={onBack}>← Back to results</button>
      <h2>{round.label}</h2>
      <p className="muted">
        {round.role === 'seeker' ? 'Seeking' : 'Hiding'}
        {' · '}{new Date(round.startedAt).toLocaleString()}
      </p>

      {/* The same look back the stats page gives (#/stats), on the board already loaded. */}
      <RoundWrapped
        round={round}
        board={otherBoard ? null : data}
        boardNote={
          <>
            This round was played on {round.board ? `the map “${round.board.name}”` : 'the built-in board'}, not the one
            loaded now. Switch back to it on the Map tab to see its zone counts.
          </>
        }
        onHiderStation={(id) => setRoundHiderStation(round.id, id)}
      />
      <button
        className="resume big"
        disabled={!props.canResume || busy}
        onClick={async () => {
          setBusy(true);
          setNote(await props.onResume(round));
          setBusy(false);
        }}
      >
        {busy ? 'Loading its board…' : 'Resume this round'}
      </button>
      <p className="muted small">
        {props.roundActive
          ? 'You have a round in progress. End it first, or carry on with it from Play.'
          : !props.canResume
            ? 'Carrying on with a round is playing, so it needs a pass on this device — get one from Play → Start a new round.'
            : 'Carry on where it stopped: the same board, the same questions. Ending it again ends it anew.'}
      </p>
      {note && <p className="warntext">{note}</p>}
      <p className="small"><a href="#/stats">All rounds and game files →</a></p>
    </div>
  );
}
