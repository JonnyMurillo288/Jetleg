import { useRef } from 'react';
import { useGame } from '../store/game';

/** Shown when there is no active round: start one, or resume/export an old one. */
export function RoundGate() {
  const role = useGame((s) => s.role);
  const rounds = useGame((s) => s.rounds).filter((r) => r.role === role);
  const startRound = useGame((s) => s.startRound);
  const setActiveRound = useGame((s) => s.setActiveRound);
  const deleteRound = useGame((s) => s.deleteRound);
  const exportJSON = useGame((s) => s.exportJSON);
  const importJSON = useGame((s) => s.importJSON);
  const fileRef = useRef<HTMLInputElement>(null);

  const download = () => {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jetleg-sf-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const upload = async (f: File) => {
    const res = importJSON(await f.text());
    if (!res.ok) alert(res.error);
  };

  return (
    <div className="pad">
      <h2>{role === 'seeker' ? 'Seeking' : 'Hiding'}</h2>
      <p className="muted">
        {role === 'seeker'
          ? 'Log each question and its answer. Zones that contradict an answer are eliminated.'
          : 'Claim your station, then use the answer assistant to reply truthfully and fast.'}
      </p>

      <button className="primary big" onClick={() => startRound()}>Start a new round</button>

      {rounds.length > 0 && (
        <>
          <h3>Previous rounds</h3>
          <ul className="list">
            {rounds.slice().reverse().map((r) => (
              <li key={r.id}>
                <button className="link grow" onClick={() => setActiveRound(r.id)}>
                  {r.label}
                  <span className="muted">
                    {' · '}{new Date(r.startedAt).toLocaleString()}
                    {r.role === 'seeker' && ` · ${r.asks.length} questions`}
                    {r.endedAt ? ' · ended' : ''}
                  </span>
                </button>
                <button className="link danger" onClick={() => confirm(`Delete "${r.label}"?`) && deleteRound(r.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

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
