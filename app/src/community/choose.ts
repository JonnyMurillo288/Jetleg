import type { Boundary } from '../engine/types';
import { go } from '../route';
import { useGame } from '../store/game';
import { saveActiveMap, type ActiveMap } from './active';
import { checkMap } from './board';

/** Is there a round in progress? A round pins its board: changing it mid-round would re-score it. */
export function roundInProgress(): boolean {
  const { rounds, activeRoundId } = useGame.getState();
  const round = rounds.find((r) => r.id === activeRoundId);
  return !!round && !round.endedAt;
}

/**
 * Choose a board and go and play on it — a published map, a file, or (null)
 * the board the app ships. Resolves to what stopped it, if anything did.
 *
 * `shippedBoundary` is the built-in board's: a station map is checked
 * against it, a full city map against its own.
 */
export async function playOn(next: ActiveMap | null, shippedBoundary: Boundary): Promise<string | null> {
  if (roundInProgress()) return 'You have a round in progress. End it before changing boards.';
  if (next) {
    const blocker = checkMap(next.map, shippedBoundary).find((p) => p.blocking);
    if (blocker) return blocker.text;
  }
  await saveActiveMap(next);
  // A map's house rules are applied once, when it is chosen; the player
  // can still change them on the game's Map tab afterwards.
  if (next) useGame.getState().updateSettings(next.map.rules);
  go('/play');
  return null;
}
