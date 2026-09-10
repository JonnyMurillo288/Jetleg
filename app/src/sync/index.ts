import { get as idbGet } from 'idb-keyval';
import type { Round } from '../store/game';
import { buildGamePayload, type SyncSettings } from './payload';
import { syncOrQueue, flushQueue } from './queue';
import type { LocalProfile, LocalTeam } from './identity';
import { supabase } from './client';

export { flushQueue } from './queue';
export { getOrCreateProfile, joinOrCreateTeam } from './identity';

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Called only after a round is marked ended. No-op with no Supabase env
 * configured, and no-op until the player has an identity and a team — sync
 * is additive on top of the local game, never a requirement to play.
 */
export async function syncFinishedRound(round: Round, settings: SyncSettings): Promise<void> {
  if (!supabase || !round.endedAt) return;

  const profile = await idbGet<LocalProfile>('sync/profile');
  const team = await idbGet<LocalTeam>('sync/team');
  if (!profile || !team) return;

  const payload = buildGamePayload(round, settings, profile, team, uid());
  await syncOrQueue(payload);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushQueue().catch(() => {});
  });
}
