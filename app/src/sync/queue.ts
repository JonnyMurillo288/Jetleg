import { get as idbGet, set as idbSet } from 'idb-keyval';
import { supabase } from './client';
import type { GamePayload } from './payload';

const QUEUE_KEY = 'sync/queue';

async function getQueue(): Promise<GamePayload[]> {
  return (await idbGet<GamePayload[]>(QUEUE_KEY)) ?? [];
}

async function setQueue(queue: GamePayload[]): Promise<void> {
  await idbSet(QUEUE_KEY, queue);
}

async function push(payload: GamePayload): Promise<boolean> {
  if (!supabase) return false;

  const { error: sessionError } = await supabase.from('sessions').insert(payload.session);
  if (sessionError) return false;

  const { error: roundError } = await supabase.from('rounds').insert(payload.round);
  if (roundError) return false;

  if (payload.asks.length > 0) {
    const { error: asksError } = await supabase.from('asks').insert(payload.asks);
    if (asksError) return false;
  }

  return true;
}

/**
 * Tries to send now; on any failure (offline, backend down, paused free-tier
 * project) the payload is queued for the next flush instead of being lost.
 * Never throws — a failed sync must not surface as a game error.
 */
export async function syncOrQueue(payload: GamePayload): Promise<void> {
  const sent = await push(payload).catch(() => false);
  if (!sent) {
    const queue = await getQueue();
    queue.push(payload);
    await setQueue(queue);
  }
}

/** Retries everything queued, in order, stopping at the first failure. */
export async function flushQueue(): Promise<void> {
  if (!supabase) return;
  const queue = await getQueue();
  const remaining = [...queue];

  while (remaining.length > 0) {
    const sent = await push(remaining[0]).catch(() => false);
    if (!sent) break;
    remaining.shift();
  }

  if (remaining.length !== queue.length) await setQueue(remaining);
}
