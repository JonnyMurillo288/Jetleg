// Verification for reporting, hiding and account deletion (0016_moderation.sql,
// 0017_delete_my_account.sql), against a running Supabase (local by default).
// Asserts what the database lets each kind of caller see and do:
//
//   ana        — publishes a map; signed in
//   bob, cy, di — signed-in players who report it
//   mod        — signed in, on the moderators list
//   guest      — an ordinary device: anonymous auth, no email
//   nobody     — no session at all
//
// Then deletes an account from the app's side and checks what went with it
// and what was kept.
//
// Requires `supabase start` (and `supabase migration up`).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { mapFromBoard, serializeMap } from './src/community/format';
import type { Station } from './src/engine/types';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};

const admin = createClient(url, serviceKey);
const run = Date.now();
const made: string[] = [];

async function member(name: string): Promise<{ client: SupabaseClient; id: string; email: string }> {
  const email = `${name.toLowerCase()}-${run}@example.com`;
  const password = `pw-${run}-${name}`;
  const res = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (res.error) throw new Error(`could not create ${name}: ${res.error.message}`);
  made.push(res.data.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`could not sign in ${name}: ${error?.message}`);
  await client.from('profiles').upsert({ id: data.user.id, display_name: name });
  return { client, id: data.user.id, email };
}

const stations = (JSON.parse(readFileSync('public/data/stations.json', 'utf8')) as { stations: Station[] }).stations;
const content = (name: string) => JSON.parse(serializeMap(mapFromBoard(stations.slice(0, 12), { gameSize: 'small' }, name, 'sf')));

const sees = async (c: SupabaseClient, mapId: string) => {
  const [map, versions, comments, listed, city] = await Promise.all([
    c.from('community_maps').select('id, hidden_at, hidden_reason, comment_count').eq('id', mapId).maybeSingle(),
    c.from('community_map_versions').select('id').eq('map_id', mapId),
    c.from('community_comments').select('id, hidden_at').eq('map_id', mapId),
    c.from('community_maps').select('id').eq('city', 'sf'),
    c.from('community_cities').select('map_count').eq('city', 'sf').maybeSingle(),
  ]);
  return {
    map: map.data,
    versions: versions.data?.length ?? 0,
    comments: comments.data ?? [],
    listed: (listed.data ?? []).some((m) => m.id === mapId),
    cityCount: city.data?.map_count ?? 0,
  };
};

(async () => {
  console.log('target:', url, '\n');
  const ana = await member('Ana');
  const bob = await member('Bob');
  const cy = await member('Cy');
  const di = await member('Di');
  const mod = await member('Mod');
  await admin.from('moderators').upsert({ email: mod.email, note: 'verify:moderation' });
  const guest = createClient(url, anonKey, { auth: { persistSession: false } });
  const anon = await guest.auth.signInAnonymously();
  if (anon.data.user) made.push(anon.data.user.id);
  const nobody = createClient(url, anonKey, { auth: { persistSession: false } });

  const pub = await ana.client.rpc('publish_map', { content: content(`Report me ${run}`), message: '' });
  if (pub.error) throw new Error('publish: ' + pub.error.message);
  const mapId = pub.data as string;
  const comment = await bob.client.from('community_comments').insert({ map_id: mapId, body: 'A perfectly fine comment' }).select('id').single();
  const nasty = await cy.client.from('community_comments').insert({ map_id: mapId, body: 'Something that should come down' }).select('id').single();
  if (comment.error || nasty.error) throw new Error('comment: ' + (comment.error ?? nasty.error)?.message);

  const before = await sees(nobody, mapId);
  check('a fresh map is public: listed, readable, with its versions and comments', before.listed && before.versions === 1 && before.comments.length === 2, before);

  // ------------------------------------------------------------- reporting
  const report = (c: SupabaseClient, reason: string, commentId?: string) =>
    c.rpc('report_content', { map: mapId, reason, ...(commentId ? { comment: commentId } : {}) });
  check('a device that has not signed in cannot report', !!(await report(guest, 'spam')).error);
  check('nor can a caller with no session', !!(await report(nobody, 'spam')).error);
  check('an author cannot report their own map', /own map/.test((await report(ana.client, 'mine')).error?.message ?? ''));
  check('a report needs a reason', !!(await report(bob.client, '   ')).error);

  const r1 = await report(bob.client, 'Names a real person');
  check('one report is taken, and hides nothing', !r1.error && r1.data?.hidden === false, r1.error?.message ?? r1.data);
  const r1again = await report(bob.client, 'Names a real person, again');
  const r2 = await report(cy.client, 'Harassment');
  check('the same person reporting twice still counts once', !r1again.error && r1again.data?.hidden === false && r2.data?.hidden === false, [r1again.data, r2.data]);
  check('no client can read who reported what', ((await bob.client.from('community_reports').select('*')).data ?? []).length === 0);
  const r3 = await report(di.client, 'Not OK');
  check('the third different person hides it', r3.data?.hidden === true, r3.error?.message ?? r3.data);

  const hiddenToAll = await Promise.all([nobody, guest, bob.client].map((c) => sees(c, mapId)));
  check('hidden: gone for everyone else — not listed, not readable, no versions, no discussion',
    hiddenToAll.every((s) => !s.map && !s.listed && s.versions === 0 && s.comments.length === 0), hiddenToAll);
  check('…and out of the city directory’s count', hiddenToAll[0].cityCount === before.cityCount - 1, { before: before.cityCount, after: hiddenToAll[0].cityCount });
  const anaSees = await sees(ana.client, mapId);
  check('its author still sees it, and is told why', !!anaSees.map?.hidden_at && /Reported/.test(anaSees.map?.hidden_reason ?? '') && anaSees.versions === 1, anaSees.map);
  const modSees = await sees(mod.client, mapId);
  check('a moderator sees it', !!modSees.map && modSees.versions === 1 && modSees.comments.length === 2);

  // ------------------------------------------------------------ moderating
  check('a player cannot read the moderation queue', !!(await bob.client.rpc('moderation_queue')).error);
  check('nor hide or restore anything', !!(await bob.client.rpc('moderate', { map: mapId, hide: false })).error);
  const queue = await mod.client.rpc('moderation_queue');
  const entry = (queue.data ?? []).find((q: { map_id: string; comment_id: string | null }) => q.map_id === mapId && !q.comment_id);
  check('the moderator’s queue lists it with its three reports and their reasons',
    entry?.open_reports === 3 && entry.reasons.includes('Harassment') && !!entry.hidden_at, queue.error?.message ?? entry);

  const restore = await mod.client.rpc('moderate', { map: mapId, hide: false });
  const back = await sees(nobody, mapId);
  check('restoring it puts it back for everyone', !restore.error && back.listed && back.versions === 1 && back.comments.length === 2 && back.cityCount === before.cityCount, restore.error?.message ?? back);
  const queueAfter = await mod.client.rpc('moderation_queue');
  check('…and closes its reports', !(queueAfter.data ?? []).some((q: { map_id: string; comment_id: string | null }) => q.map_id === mapId && !q.comment_id));
  check('a closed report does not count toward hiding it again', (await report(bob.client, 'still')).data?.hidden === false);

  // A comment, hidden by a moderator directly.
  const hideComment = await mod.client.rpc('moderate', { map: mapId, hide: true, comment: nasty.data!.id });
  const afterComment = await sees(nobody, mapId);
  check('a moderator hides one comment: the rest of the discussion stays', !hideComment.error && afterComment.comments.length === 1 && afterComment.comments[0].id === comment.data!.id, hideComment.error?.message ?? afterComment.comments);
  check('…and the map’s comment count drops with it', afterComment.map?.comment_count === 1, afterComment.map);
  const cySees = await cy.client.from('community_comments').select('id, hidden_at').eq('id', nasty.data!.id).maybeSingle();
  check('its author still sees it, marked hidden', !!cySees.data?.hidden_at);
  check('a comment’s author cannot report it themselves', /own comment/.test((await report(cy.client, 'x', nasty.data!.id)).error?.message ?? ''));

  // ------------------------------------------------------- deleting an account
  const del = await member('Del');
  const delMap = await del.client.rpc('publish_map', { content: content(`Del's map ${run}`), message: '' });
  await del.client.from('community_comments').insert({ map_id: mapId, body: 'Del was here' });
  await del.client.rpc('report_content', { map: mapId, reason: 'leaving soon', comment: comment.data!.id });
  const game = await admin.from('games').insert({ created_by: del.id }).select('id').single();
  const seat = game.data ? await admin.from('room_seats').insert({ game_id: game.data.id, device_id: del.id }).select('id').single() : null;

  check('with no session, there is no account to delete', !!(await nobody.rpc('delete_my_account')).error);
  const gone = await del.client.rpc('delete_my_account');
  check('a signed-in player deletes their own account', !gone.error, gone.error?.message);
  const user = await admin.auth.admin.getUserById(del.id);
  check('…the account is gone from Auth', !!user.error || !user.data.user);
  const [maps, comments, profile, reports] = await Promise.all([
    admin.from('community_maps').select('id').eq('author_id', del.id),
    admin.from('community_comments').select('id').eq('author_id', del.id),
    admin.from('profiles').select('id').eq('id', del.id),
    admin.from('community_reports').select('id').eq('reporter_id', del.id),
  ]);
  check('…with their maps, comments, profile and reports', !delMap.error && !maps.data?.length && !comments.data?.length && !profile.data?.length && !reports.data?.length,
    { maps: maps.data?.length, comments: comments.data?.length, profile: profile.data?.length, reports: reports.data?.length });
  if (seat?.data && game.data) {
    const [seatNow, gameNow] = await Promise.all([
      admin.from('room_seats').select('device_id').eq('id', seat.data.id).maybeSingle(),
      admin.from('games').select('id, created_by').eq('id', game.data.id).maybeSingle(),
    ]);
    check('…but a place they took in a game room stays taken, and a room they bought stays',
      !!seatNow.data && seatNow.data.device_id === null && !!gameNow.data && gameNow.data.created_by === null, { seat: seatNow.data, game: gameNow.data });
  } else check('a room and a seat could be set up for the deletion check', false, game.error?.message ?? seat?.error?.message);
  check('other people’s things are untouched', (await sees(nobody, mapId)).listed);

  // ------------------------------------------------------------ tidy up
  await admin.from('moderators').delete().eq('email', mod.email);
  if (game.data) await admin.from('games').delete().eq('id', game.data.id);
  for (const id of made) await admin.auth.admin.deleteUser(id);

  console.log(fail.length ? `\n${fail.length} FAILED:\n  ${fail.join('\n  ')}` : '\nALL PASS');
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
