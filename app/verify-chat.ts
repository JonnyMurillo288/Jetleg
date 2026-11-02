// Verification for the in-game chat's server side — which is only a relay.
// (src/chat/, supabase/migrations/0013_game_chat.sql)
//
// The chat stores nothing on a server. This asserts it from the server's
// side, and that the relay does what the phones need:
//
//   - there is no table and no bucket a chat could be kept in
//   - members of a game join `chat:<game>`; an outsider is refused
//   - a hider can send there (answers), and still cannot send on `game:<id>`
//     where positions go
//   - a photo sent in paced pieces arrives whole at every member
//   - after all of it, the relay's own table holds nothing for the game
//
// Requires `supabase start` and the migration applied (`npx supabase migration up`).
import { execFileSync } from 'node:child_process';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { channelTopic, LOCATION_EVENT } from './src/live/share';
import {
  MESSAGE_EVENT,
  PHOTO_EVENT,
  PhotoAssembler,
  QUESTION_EVENT,
  chatTopic,
  parseChunk,
  photoChunks,
} from './src/chat/chat';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
/** Mirrors useGameChat's pacing, so this measures what the app actually does. */
const PHOTO_PACE_MS = 450;

const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The local database, asked directly. Null where there is no local stack to ask. */
function sql(query: string): string | null {
  try {
    return execFileSync('docker', ['exec', 'supabase_db_JetLeg', 'psql', '-U', 'postgres', '-tAc', query], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function device(): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`sign-in failed: ${error?.message}`);
  return { client, id: data.user.id };
}

async function join(client: SupabaseClient, topic: string) {
  await client.realtime.setAuth();
  const got: { event: string; payload: unknown }[] = [];
  const channel = client.channel(topic, { config: { private: true, broadcast: { self: false, ack: true } } });
  channel.on('broadcast', { event: '*' }, ({ event, payload }) => got.push({ event, payload }));
  const state = await new Promise<string>((resolve) => {
    const giveUp = setTimeout(() => resolve('NO_ANSWER'), 8000);
    channel.subscribe((s) => { if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { clearTimeout(giveUp); resolve(s); } });
  });
  return { channel, got, state };
}
const send = (ch: RealtimeChannel, event: string, payload: unknown) => ch.send({ type: 'broadcast', event, payload });

(async () => {
  // ---- nowhere to keep it
  const admin = createClient(url, serviceKey);
  const tables = sql("select count(*) from information_schema.tables where table_name ilike any (array['%chat%', '%message%', 'game_questions']) and table_schema not in ('realtime', 'pg_catalog', 'information_schema', '_realtime')");
  if (tables === null) console.log('SKIP  table check: no local database to ask');
  else check('there is no table a chat could be kept in', tables === '0', tables);
  // Only with a service key that works here: an error reads as no buckets, which proves nothing.
  const { data: buckets, error: bucketError } = await admin.storage.listBuckets();
  if (bucketError) console.log(`SKIP  bucket check: ${bucketError.message} (set SUPABASE_SERVICE_ROLE_KEY for this project)`);
  else check('there is no storage bucket at all', buckets.length === 0, buckets.map((b) => b.id));

  // ---- the room
  const seeker = await device();
  const seeker2 = await device();
  const hider = await device();
  const outsider = await device();
  const created = await seeker.client.rpc('create_game', { display_name: 'Sam', team_name: 'Blue' });
  const gameId: string = created.data.game_id;
  await seeker2.client.rpc('join_game', { code: created.data.join_code, display_name: 'Alex', team_id: created.data.team_id });
  await hider.client.rpc('join_game', { code: created.data.join_code, display_name: 'Hana', team_name: 'Red' });
  await seeker.client.rpc('set_game_role', { game: gameId, new_role: 'seeker' });
  await seeker2.client.rpc('set_game_role', { game: gameId, new_role: 'seeker' });
  // The hider stays 'hider', the default.

  const s = await join(seeker.client, chatTopic(gameId));
  const s2 = await join(seeker2.client, chatTopic(gameId));
  const h = await join(hider.client, chatTopic(gameId));
  const o = await join(outsider.client, chatTopic(gameId));
  check('players in the game join its chat', [s, s2, h].every((x) => x.state === 'SUBSCRIBED'), [s.state, s2.state, h.state]);
  check('an outsider is refused the chat', o.state !== 'SUBSCRIBED', o.state);

  // ---- question, answer, chat
  const question = { id: 'q-verify', gameId, questionId: 'match-park', text: 'Is your nearest park the same as my nearest park?' };
  check('a seeker’s question is relayed', (await send(s.channel, QUESTION_EVENT, question)) === 'ok');
  const answer = { ...question, answer: { kind: 'yesno', value: 'no' }, answeredBy: hider.id };
  check('a hider may send on the chat — answering is its whole part', (await send(h.channel, QUESTION_EVENT, answer)) === 'ok');
  await send(h.channel, MESSAGE_EVENT, { id: 'm-verify', gameId, body: 'never' });
  await wait(1500);
  check('the hider receives the question', h.got.some((g) => g.event === QUESTION_EVENT && (g.payload as { id?: string }).id === 'q-verify'));
  check('both seekers receive the answer and the message', [s, s2].every((x) =>
    x.got.some((g) => (g.payload as { answer?: { value?: string } }).answer?.value === 'no') && x.got.some((g) => g.event === MESSAGE_EVENT)));
  check('the outsider receives nothing', o.got.length === 0, o.got.length);

  // The fairness rule from 0005 still holds: the hider has the chat, not the location channel.
  const loc = await join(seeker.client, channelTopic(gameId));
  const hloc = await join(hider.client, channelTopic(gameId));
  await send(hloc.channel, LOCATION_EVENT, { id: hider.id, name: 'Hana', lon: -122.4477, lat: 37.7694 });
  await wait(1500);
  check('the hider still cannot send on the location channel', loc.got.length === 0, loc.got.length);

  // ---- a photo, the way the app sends one
  const photo = new Uint8Array(250_000).map((_, i) => (i * 31 + 7) & 255);
  photo[0] = 0xff; photo[1] = 0xd8;
  const pieces = photoChunks(gameId, 'q-photo', photo);
  const started = Date.now();
  const sent: string[] = [];
  for (const piece of pieces) {
    sent.push(await send(h.channel, PHOTO_EVENT, piece));
    await wait(PHOTO_PACE_MS);
  }
  await wait(2000);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  check(`a 250 KB photo goes in ${pieces.length} pieces, every one acknowledged`, sent.every((r) => r === 'ok'), sent.filter((r) => r !== 'ok'));
  for (const [name, x] of [['Sam', s], ['Alex', s2]] as const) {
    const a = new PhotoAssembler();
    let whole: Uint8Array | null = null;
    for (const g of x.got) {
      if (g.event !== PHOTO_EVENT) continue;
      const piece = parseChunk(g.payload);
      if (piece) whole = a.add(piece) ?? whole;
    }
    check(`${name} gets the photo whole, byte for byte (${secs}s)`, !!whole && whole.length === photo.length && whole.every((b, i) => b === photo[i]), whole?.length ?? 0);
  }
  check('the outsider still received nothing', o.got.length === 0, o.got.length);

  // ---- and the relay kept none of it
  const kept = sql(`select count(*) from realtime.messages where topic in ('${chatTopic(gameId)}', '${channelTopic(gameId)}')`);
  if (kept === null) console.log('SKIP  relay check: no local database to ask');
  else check('the relay’s own table holds nothing for this game afterwards', kept === '0', kept);

  // ---- leaving
  await hider.client.removeChannel(h.channel);
  await hider.client.rpc('leave_game', { game: gameId });
  const again = await join(hider.client, chatTopic(gameId));
  check('a player who leaves can no longer join the chat', again.state !== 'SUBSCRIBED', again.state);

  for (const d of [seeker, seeker2, hider, outsider]) await d.client.removeAllChannels();
  console.log(fail.length ? `\n${fail.length} FAILED:\n  ${fail.join('\n  ')}` : '\nall chat checks passed');
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
