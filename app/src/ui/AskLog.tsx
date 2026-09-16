import type { GameData } from '../data/load';
import { useGame, type Round } from '../store/game';
import { QUESTIONS_BY_ID } from '../engine/questions';
import type { evaluate } from '../engine/candidates';
import type { Answer } from '../engine/types';
import { formatDistance } from './units';

type Evaluated = ReturnType<typeof evaluate>;

/**
 * The ask log is the source of truth. Candidates are recomputed from it on
 * every change, so toggling or deleting an entry can never leave the map in a
 * state that does not follow from the answers.
 */
export function AskLog(props: { data: GameData; round: Round; evaluated: Evaluated }) {
  const { round, evaluated } = props;
  const units = useGame((s) => s.settings.units);
  const removeAsk = useGame((s) => s.removeAsk);
  const updateAsk = useGame((s) => s.updateAsk);
  const toggleOverlay = useGame((s) => s.toggleOverlay);
  const hiddenOverlays = useGame((s) => s.hiddenOverlays);
  const endRound = useGame((s) => s.endRound);

  if (!round.asks.length) {
    return (
      <div className="pad">
        <p className="muted">Nothing asked yet. Every answer you log narrows the map.</p>
      </div>
    );
  }

  // How many zones each answer removed, in the order they were asked.
  const killCount = new Map<string, number>();
  for (const v of evaluated.verdicts) {
    const first = v.killedBy[0];
    if (first) killCount.set(first, (killCount.get(first) ?? 0) + 1);
  }

  return (
    <div className="pad">
      <ul className="list log">
        {round.asks.slice().reverse().map((a) => {
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
                  {killCount.has(a.id) && ` · removed ${killCount.get(a.id)} zones`}
                  {resolved?.note && ` · ${resolved.note}`}
                  {resolved?.radiusM !== undefined &&
                    ` · you were ${formatDistance(resolved.radiusM, units)} from your nearest`}
                  {!resolved?.region && !a.disabled && ' · no constraint'}
                </div>
              </div>
              <div className="row tight">
                <button
                  className="link"
                  title="Show or hide this shaded area"
                  onClick={() => toggleOverlay(a.id)}
                >
                  {hiddenOverlays.includes(a.id) ? 'Show' : 'Hide'}
                </button>
                <button
                  className="link"
                  title="Keep the entry but stop it affecting the map"
                  onClick={() => updateAsk(a.id, { disabled: !a.disabled })}
                >
                  {a.disabled ? 'Enable' : 'Disable'}
                </button>
                <button className="link danger" onClick={() => removeAsk(a.id)}>Delete</button>
              </div>
            </li>
          );
        })}
      </ul>

      <button className="link danger" onClick={endRound}>End this round</button>
    </div>
  );
}

/** Shared with ResultsPanel — one rendering of an answer, not two that can disagree. */
export function describeAnswer(a: Answer): string {
  switch (a.kind) {
    case 'yesno': return a.value.toUpperCase();
    case 'closerFurther': return a.value.toUpperCase();
    case 'hotterColder': return a.value.toUpperCase();
    case 'tentacle': return a.poiId ? `→ ${a.poiId}` : 'NOT IN REACH';
    case 'null': return 'NULL';
    case 'photo': return 'photo sent';
  }
}
