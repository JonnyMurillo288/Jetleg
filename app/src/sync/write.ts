import type { SupabaseClient } from '@supabase/supabase-js';
import type { GamePayload } from './payload';

/**
 * Write one finished round to the team's history — or rewrite it.
 *
 * A round can be resumed after it ends and ended again, so the same round
 * arrives more than once. Inserting it twice failed on the round's id, the
 * queue kept the failure, and since the queue stops at its first failure,
 * every round after it stopped syncing too. So each write *replaces* the
 * round: the session and round rows are upserted by id, and any question the
 * player deleted since the last send is deleted here as well.
 *
 * Takes the client as an argument, so verify-sync.ts can run the very same
 * write against a real database from Node.
 */
export async function writeRound(client: SupabaseClient, payload: GamePayload): Promise<{ ok: true } | { ok: false; error: string }> {
  const fail = (step: string, message: string) => ({ ok: false as const, error: `${step}: ${message}` });

  // Sent before under another session (rounds synced before session ids
  // were the round's own): that row is left with nothing pointing at it.
  const { data: before } = await client.from('rounds').select('session_id').eq('id', payload.round.id).maybeSingle();

  const s = await client.from('sessions').upsert(payload.session);
  if (s.error) return fail('session', s.error.message);
  const r = await client.from('rounds').upsert(payload.round);
  if (r.error) return fail('round', r.error.message);

  const ids = payload.asks.map((a) => a.id);
  let gone = client.from('asks').delete().eq('round_id', payload.round.id);
  if (ids.length) gone = gone.not('id', 'in', `(${ids.join(',')})`);
  const d = await gone;
  if (d.error) return fail('removed questions', d.error.message);
  if (ids.length) {
    const a = await client.from('asks').upsert(payload.asks);
    if (a.error) return fail('questions', a.error.message);
  }

  const stale = before?.session_id;
  if (stale && stale !== payload.session.id) await client.from('sessions').delete().eq('id', stale);
  return { ok: true };
}
