import { useRef, useState } from 'react';
import { useGame, type Round } from '../store/game';
import { PaywallModal } from './PaywallModal';
import { restoreChats, withChats } from '../chat/local';

/**
 * Shown when there is no active round: start one, or resume/export an old
 * one. `canStart` gates "Start a new round" and reopening a round that was
 * ended — both are playing again — while viewing and exporting rounds
 * already played stays available regardless of entitlement.
 */
export function RoundGate(props: { canStart: boolean; onRestored: () => void; onResume: (r: Round) => Promise<string | null> }) {
  const { canStart, onRestored } = props;
  const [showPaywall, setShowPaywall] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const role = useGame((s) => s.role);
  const rounds = useGame((s) => s.rounds).filter((r) => r.role === role);
  const startRound = useGame((s) => s.startRound);
  const deleteRound = useGame((s) => s.deleteRound);
  const exportJSON = useGame((s) => s.exportJSON);
  const importJSON = useGame((s) => s.importJSON);
  const fileRef = useRef<HTMLInputElement>(null);

  // The chat goes in the file with the rounds it belongs to; it is kept nowhere else.
  const download = async () => {
    const blob = new Blob([await withChats(exportJSON())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jetleg-sf-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const upload = async (f: File) => {
    const text = await f.text();
    const res = importJSON(text);
    if (!res.ok) alert(res.error);
    else await restoreChats(text);
  };

  /** Any round, finished or not; App puts its board back first. */
  const resume = async (r: Round) => {
    setResumeNote(null);
    if (r.endedAt && !canStart) { setShowPaywall(true); return; }
    const stopped = await props.onResume(r);
    if (stopped) setResumeNote(stopped);
  };

  return (
    <div className="pad">
      <h2>{role === 'seeker' ? 'Seeking' : 'Hiding'}</h2>
      <p className="muted">
        {role === 'seeker'
          ? 'Log each question and its answer. Zones that contradict an answer are eliminated.'
          : 'Claim your station, then use the answer assistant to reply truthfully and fast.'}
      </p>

      {canStart ? (
        <button className="primary big" onClick={() => startRound()}>Start a new round</button>
      ) : showPaywall ? (
        <PaywallModal
          onRestored={() => {
            onRestored();
            setShowPaywall(false);
          }}
        />
      ) : (
        <button className="primary big" onClick={() => setShowPaywall(true)}>Start a new round</button>
      )}

      {rounds.length > 0 && (
        <>
          <h3>Previous rounds</h3>
          <p className="muted small">Resume carries on with a round — even one that was ended.</p>
          {resumeNote && <p className="warntext">{resumeNote}</p>}
          <ul className="list">
            {rounds.slice().reverse().map((r) => (
              <li key={r.id}>
                <span className="grow">
                  {r.label}
                  <span className="muted">
                    {' · '}{new Date(r.startedAt).toLocaleString()}
                    {r.role === 'seeker' && ` · ${r.asks.length} questions`}
                    {r.board && ` · ${r.board.name}`}
                    {r.endedAt ? ' · ended' : ' · unfinished'}
                  </span>
                </span>
                <button className="resume" onClick={() => resume(r)}>Resume</button>
                <button className="link danger" onClick={() => confirm(`Delete "${r.label}"?`) && deleteRound(r.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row">
        <a className="buttonlink" href="#/start">Change city or map</a>
        <a className="buttonlink" href="#/stats">Game stats</a>
        <a className="buttonlink" href="#/">Home</a>
      </div>

      <h3>Backup</h3>
      <p className="muted small">
        Rounds are stored on this device only. iOS can evict browser storage after about a week of
        non-use, so export if you want to keep a round beyond game day.
      </p>
      <div className="row">
        <button onClick={download}>Export to file</button>
        <button onClick={() => fileRef.current?.click()}>Import from file</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </div>
    </div>
  );
}
