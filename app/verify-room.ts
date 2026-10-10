// Verification for game rooms and live location sharing (src/live/,
// supabase/migrations/0005_game_rooms.sql). Runs real devices against a
// running Supabase (local by default) and asserts at the layer that matters:
// what actually arrives on another device's socket, and what does not.
//
//   seeker  — creates the game, broadcasts its position
//   hider   — joins with the code; must receive the seeker, must be unable to send
//   outsider — signed in, not in the game; must receive nothing and get in nowhere
//
// Requires `supabase start` first (and `supabase db reset` after pulling this
// migration). Run against another environment with SUPABASE_URL /
// SUPABASE_ANON_KEY env vars.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { LOCATION_EVENT, channelTopic, outgoingLocation, parseLocation } from './src/live/share';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function device(): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`sign-in failed: ${error?.message}`);
  return { client, id: data.user.id };
}

/** Subscribes the way the app does, and records every broadcast that arrives. */
async function listen(client: SupabaseClient, gameId: string) {
  await client.realtime.setAuth();
  const received: unknown[] = [];
  const channel = client.channel(channelTopic(gameId), { config: { private: true, broadcast: { self: false } } });
  channel.on('broadcast', { event: '*' }, ({ payload }) => received.push(payload));
  const state = await new Promise<string>((resolve) => {
    const giveUp = setTimeout(() => resolve('NO_ANSWER'), 8000);
    channel.subscribe((s) => {
      if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { clearTimeout(giveUp); resolve(s); }
    });
  });
  return { channel, received, state };
}

const send = (channel: RealtimeChannel, payload: unknown) =>
  channel.send({ type: 'broadcast', event: LOCATION_EVENT, payload });

const seekerSpot: [number, number] = [-122.4194, 37.7793];
const hiderSpot: [number, number] = [-122.4477, 37.7694]; // must never arrive anywhere

(async () => {
  const seeker = await device();
  const hider = await device();
  const outsider = await device();

  // ---- the room
  const created = await seeker.client.rpc('create_game', { display_name: 'Sam Seeker', team_name: 'Blue' });
  check('a device can create a game and gets a code', !created.error && /^[A-HJ-NP-Z2-9]{6}$/.test(created.data?.join_code ?? ''), created.error?.message ?? created.data?.join_code);
  const gameId: string = created.data.game_id;
  const code: string = created.data.join_code;

  const looked = await hider.client.rpc('lookup_game', { code: code.toLowerCase() });
  check('the code finds the game and lists its team', !looked.error && looked.data?.teams?.length === 1 && looked.data.teams[0].name === 'Blue', looked.error?.message ?? looked.data?.teams);

  const wrong = await hider.client.rpc('lookup_game', { code: 'ZZZZZZ' });
  check('a wrong code finds nothing', !wrong.error && wrong.data === null);

  const joined = await hider.client.rpc('join_game', { code, display_name: 'Hana Hider', team_name: 'Red' });
  check('a second device joins with the code, on a new team', !joined.error && joined.data?.game_id === gameId, joined.error?.message);

  const badJoin = await outsider.client.rpc('join_game', { code: 'ZZZZZZ', display_name: 'Nope', team_name: 'X' });
  check('joining with a wrong code is refused', !!badJoin.error);

  const direct = await outsider.client.from('game_members').insert({ game_id: gameId, profile_id: outsider.id, team_id: created.data.team_id });
  check('a membership row cannot be inserted directly, bypassing the code', !!direct.error);

  const roster = await hider.client.rpc('game_roster', { game: gameId });
  check('a member sees the roster', !roster.error && roster.data?.length === 2, roster.data?.map((r: { display_name: string }) => r.display_name));
  check('everyone starts as a hider — nobody may send until they say they seek', (roster.data ?? []).every((r: { role: string }) => r.role === 'hider'));

  const outsiderRoster = await outsider.client.rpc('game_roster', { game: gameId });
  check('an outsider sees an empty roster', !outsiderRoster.error && (outsiderRoster.data?.length ?? -1) === 0);
  const outsiderMembers = await outsider.client.from('game_members').select('profile_id').eq('game_id', gameId);
  check('an outsider reads zero membership rows', !outsiderMembers.error && (outsiderMembers.data?.length ?? -1) === 0);
  const outsiderRole = await outsider.client.rpc('set_game_role', { game: gameId, new_role: 'seeker' });
  check('an outsider cannot declare a role in the game', !!outsiderRole.error);

  // ---- the channel
  const roleSet = await seeker.client.rpc('set_game_role', { game: gameId, new_role: 'seeker' });
  check('the creator declares itself a seeker', !roleSet.error, roleSet.error?.message);

  const s = await listen(seeker.client, gameId);
  const h = await listen(hider.client, gameId);
  const o = await listen(outsider.client, gameId);
  check('the seeker joins the game channel', s.state === 'SUBSCRIBED', s.state);
  check('the hider joins the game channel', h.state === 'SUBSCRIBED', h.state);
  check('an outsider is refused the game channel', o.state !== 'SUBSCRIBED', o.state);

  const who = { id: seeker.id, name: 'Sam Seeker', team: 'Blue' };
  const msg = outgoingLocation('seeker', who, { coords: seekerSpot, accuracyM: 12, manual: false })!;
  await send(s.channel, msg);
  await wait(1500);

  const atHider = h.received.map(parseLocation).filter(Boolean);
  check('the hider receives the seeker’s position', atHider.length === 1 && atHider[0]!.lon === seekerSpot[0] && atHider[0]!.lat === seekerSpot[1], atHider);
  check('the outsider receives nothing', o.received.length === 0, o.received);

  // The fairness check. The app never builds this message — outgoingLocation
  // returns null for a hider — so it is forged here, to prove the server
  // refuses it on its own.
  check('the app builds no message for a hider', outgoingLocation('hider', who, { coords: hiderSpot, manual: false }) === null);
  const forged = { id: hider.id, name: 'Hana Hider', team: 'Red', lon: hiderSpot[0], lat: hiderSpot[1], accuracyM: 5, manual: false };
  await send(h.channel, forged);
  await wait(1500);
  check('a hider’s forged broadcast reaches no seeker', s.received.length === 0, s.received);

  // Same forgery over Realtime's HTTP endpoint, which a client can also hit.
  const viaHttp = hider.client.channel(channelTopic(gameId), { config: { private: true } });
  await viaHttp.send({ type: 'broadcast', event: LOCATION_EVENT, payload: forged });
  await wait(1500);
  check('...nor does one sent over HTTP instead of the socket', s.received.length === 0, s.received);

  // Role is checked when the channel is joined, so the app rejoins on every
  // role change. Do the same: the hider becomes a seeker and may now send;
  // the old seeker becomes the hider and may not.
  await hider.client.removeChannel(h.channel);
  await seeker.client.removeChannel(s.channel);
  await hider.client.rpc('set_game_role', { game: gameId, new_role: 'seeker' });
  await seeker.client.rpc('set_game_role', { game: gameId, new_role: 'hider' });
  const h2 = await listen(hider.client, gameId);
  const s2 = await listen(seeker.client, gameId);
  await send(h2.channel, { ...forged, lon: seekerSpot[0], lat: seekerSpot[1] });
  await send(s2.channel, { ...msg, lon: hiderSpot[0], lat: hiderSpot[1] });
  await wait(1500);
  check('after swapping roles, the new seeker is received', s2.received.length === 1, s2.received);
  check('after swapping roles, the new hider can no longer send', h2.received.length === 0, h2.received);

  // ---- leaving
  const left = await hider.client.rpc('leave_game', { game: gameId });
  await hider.client.removeChannel(h2.channel);
  const h3 = await listen(hider.client, gameId);
  check('after leaving, the game channel is refused', !left.error && h3.state !== 'SUBSCRIBED', h3.state);

  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:room crashed:', e);
  process.exit(1);
});
