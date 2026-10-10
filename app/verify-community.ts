// Verification for community maps (src/community/, 0006_community.sql),
// against a running Supabase (local by default). Asserts at the layer that
// matters — what the database actually lets each kind of caller do:
//
//   alice, bob — signed in with a verified email
//   guest      — an ordinary device: anonymous auth, no email
//   nobody     — no session at all
//
// The sign-in itself is exercised for real once, through the mail catcher:
// an anonymous device attaches an email, types the code, and must come out
// as the *same* user, now allowed to publish.
//
// Requires `supabase start` (and `supabase migration up`).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { mapFromBoard, parseMapFile, serializeMap, type MapFile } from './src/community/format';
import type { Station } from './src/engine/types';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const mailUrl = process.env.MAILPIT_URL || 'http://127.0.0.1:54324';
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

async function member(name: string): Promise<{ client: SupabaseClient; id: string }> {
  const email = `${name.toLowerCase()}-${run}@example.com`;
  const password = `pw-${run}-${name}`;
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw new Error(`could not create ${name}: ${made.error.message}`);
  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`could not sign in ${name}: ${error?.message}`);
  await client.from('profiles').upsert({ id: data.user.id, display_name: name });
  return { client, id: data.user.id };
}

async function codeFor(email: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    const list = await (await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent('to:' + email)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${mailUrl}/api/v1/message/${list.messages[0].ID}`)).json();
      return (msg.Text as string).match(/\b(\d{6})\b/)?.[1] ?? null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const stations = (JSON.parse(readFileSync('public/data/stations.json', 'utf8')) as { stations: Station[] }).stations;
const board = (name: string, count: number): MapFile => mapFromBoard(stations.slice(0, count), { gameSize: 'small' }, name, 'sf');

(async () => {
  const alice = await member('Alice');
  const bob = await member('Bob');
  const guest = createClient(url, anonKey);
  const guestUser = (await guest.auth.signInAnonymously()).data.user!;
  await guest.from('profiles').upsert({ id: guestUser.id, display_name: 'Guest' });
  const nobody = createClient(url, anonKey);

  // ---- publishing
  const v1 = board(`Downtown only ${run}`, 20);
  const published = await alice.client.rpc('publish_map', { content: v1, message: 'First cut' });
  check('a signed-in user publishes a map', !published.error && typeof published.data === 'string', published.error?.message);
  const mapId: string = published.data;

  const guestPublish = await guest.rpc('publish_map', { content: v1, message: '' });
  check('an anonymous device cannot publish', !!guestPublish.error && /sign in/i.test(guestPublish.error.message), guestPublish.error?.message);
  const nobodyPublish = await nobody.rpc('publish_map', { content: v1, message: '' });
  check('a caller with no session cannot publish', !!nobodyPublish.error);

  const noName = await member('Nameless');
  await noName.client.from('profiles').delete().eq('id', noName.id);
  const nameless = await noName.client.rpc('publish_map', { content: v1, message: '' });
  check('publishing needs a display name', !!nameless.error && /display name/i.test(nameless.error.message), nameless.error?.message);

  for (const [what, content] of [
    ['a non-map', { hello: 'world' }],
    ['a city pack (not accepted yet)', { ...v1, kind: 'pack' }],
    ['a map with one station', { ...v1, stations: v1.stations.slice(0, 1) }],
    ['a station with no position', { ...v1, stations: [{ id: 'a', name: 'A' }, v1.stations[0]] }],
    ['duplicate station ids', { ...v1, stations: [v1.stations[0], v1.stations[0]] }],
  ] as const) {
    const res = await alice.client.rpc('publish_map', { content, message: '' });
    check(`the database refuses ${what}`, !!res.error, res.error?.message);
  }

  const direct = await alice.client.from('community_maps').insert({ author_id: alice.id, author_name: 'Alice', name: 'x', kind: 'stations', city: 'sf' });
  check('a map row cannot be inserted directly, skipping validation', !!direct.error);

  // ---- reading is open
  const list = await nobody.from('community_maps').select('id, name, author_name, station_count').eq('id', mapId);
  check('anyone can browse, with no session at all', !list.error && list.data?.length === 1 && list.data[0].author_name === 'Alice' && list.data[0].station_count === 20, list.data);
  const head = await nobody.from('community_maps').select('head_version_id').eq('id', mapId).single();
  const content = await nobody.from('community_map_versions').select('content').eq('id', head.data!.head_version_id).single();
  const parsed = parseMapFile(content.data?.content);
  check('the stored map reads back identical to what was published', parsed.ok && serializeMap(parsed.map) === serializeMap(v1));

  // ---- versions
  const v2 = { ...board(`Downtown only ${run}`, 25), description: 'Added the Embarcadero stops.' };
  const second = await alice.client.rpc('publish_map_version', { map: mapId, content: v2, message: 'Five more stops' });
  check('the author publishes a second version', !second.error, second.error?.message);
  const hijack = await bob.client.rpc('publish_map_version', { map: mapId, content: v2, message: 'mine now' });
  check('someone else cannot publish a version of it', !!hijack.error && /branch it/i.test(hijack.error.message), hijack.error?.message);
  const after = await nobody.from('community_maps').select('version_count, station_count, description, head_version_id').eq('id', mapId).single();
  check('the map follows its newest version', after.data?.version_count === 2 && after.data.station_count === 25 && after.data.head_version_id === second.data, after.data);
  const history = await nobody.from('community_map_versions').select('id, seq, parent_version_id, message').eq('map_id', mapId).order('seq');
  check('history keeps both versions, the second pointing at the first',
    history.data?.length === 2 && history.data[1].parent_version_id === history.data[0].id, history.data?.map((v) => `${v.seq}: ${v.message}`));
  const firstVersionId: string = history.data![0].id;

  const rewrite = await alice.client.from('community_map_versions').update({ message: 'rewritten' }).eq('id', firstVersionId).select('id');
  check('a published version cannot be edited, even by its author', (rewrite.data?.length ?? 0) === 0);
  const erase = await alice.client.from('community_map_versions').delete().eq('id', firstVersionId).select('id');
  check('...nor deleted on its own', (erase.data?.length ?? 0) === 0);

  // ---- branches
  const branchContent = { ...board(`Downtown, no cable cars ${run}`, 18) };
  const branched = await bob.client.rpc('publish_map', { content: branchContent, message: 'Dropped two', parent_version: firstVersionId });
  check('another user branches the map from a specific version', !branched.error, branched.error?.message);
  const branch = await nobody.from('community_maps').select('parent_map_id, parent_version_id, author_name').eq('id', branched.data).single();
  check('the branch remembers exactly where it came from', branch.data?.parent_map_id === mapId && branch.data.parent_version_id === firstVersionId && branch.data.author_name === 'Bob', branch.data);
  const parentCount = await nobody.from('community_maps').select('branch_count').eq('id', mapId).single();
  check('the original counts its branch', parentCount.data?.branch_count === 1, parentCount.data);

  // ---- reactions
  check('an anonymous device cannot like', !!(await guest.rpc('react_to_map', { map: mapId, new_value: 1 })).error);
  await alice.client.rpc('react_to_map', { map: mapId, new_value: 1 });
  await bob.client.rpc('react_to_map', { map: mapId, new_value: 1 });
  await bob.client.rpc('react_to_map', { map: mapId, new_value: 1 }); // twice is still once
  let counts = await nobody.from('community_maps').select('like_count, dislike_count').eq('id', mapId).single();
  check('two users liking is two likes, however often they tap', counts.data?.like_count === 2 && counts.data.dislike_count === 0, counts.data);
  await bob.client.rpc('react_to_map', { map: mapId, new_value: -1 });
  counts = await nobody.from('community_maps').select('like_count, dislike_count').eq('id', mapId).single();
  check('changing a like to a dislike moves it, not adds it', counts.data?.like_count === 1 && counts.data.dislike_count === 1, counts.data);
  await bob.client.rpc('react_to_map', { map: mapId, new_value: 0 });
  counts = await nobody.from('community_maps').select('like_count, dislike_count').eq('id', mapId).single();
  check('taking it back removes it', counts.data?.like_count === 1 && counts.data.dislike_count === 0, counts.data);
  // Likes arriving at the same instant must all count. Each of these is its
  // own transaction, and a naive recount in each sees only its own row.
  const crowd = await Promise.all(['Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'].map(member));
  await Promise.all(crowd.map((m) => m.client.rpc('react_to_map', { map: mapId, new_value: 1 })));
  counts = await nobody.from('community_maps').select('like_count').eq('id', mapId).single();
  check('six people liking at the same moment is six more likes', counts.data?.like_count === 7, counts.data);
  await Promise.all(crowd.map((m) => m.client.from('community_comments').insert({ map_id: mapId, author_id: m.id, author_name: '', body: 'me too' })));
  const crowdComments = await nobody.from('community_maps').select('comment_count').eq('id', mapId).single();
  check('...and six commenting at once is six comments', crowdComments.data?.comment_count === 6, crowdComments.data);
  await Promise.all(crowd.map((m) => admin.auth.admin.deleteUser(m.id)));
  counts = await nobody.from('community_maps').select('like_count, comment_count').eq('id', mapId).single();
  check('deleting those accounts takes their likes and comments with them', counts.data?.like_count === 1 && (counts.data as any).comment_count === 0, counts.data);

  const stuffed = await bob.client.from('community_reactions').insert({ map_id: mapId, user_id: alice.id, value: -1 });
  check('a reaction cannot be inserted on someone else’s behalf', !!stuffed.error);
  const peek = await bob.client.from('community_reactions').select('user_id').eq('map_id', mapId);
  check('who liked a map is not readable by others', !peek.error && (peek.data?.length ?? -1) === 0, peek.data);

  // ---- comments
  const guestComment = await guest.from('community_comments').insert({ map_id: mapId, author_id: guestUser.id, author_name: 'Guest', body: 'hi' });
  check('an anonymous device cannot comment', !!guestComment.error, guestComment.error?.message);
  const said = await bob.client.from('community_comments').insert({ map_id: mapId, author_id: bob.id, author_name: 'Definitely Alice', body: '  Love the downtown focus.  ' }).select('id, author_name, body').single();
  check('a signed-in user comments', !said.error, said.error?.message);
  check('...under their real name, whatever the request claimed', said.data?.author_name === 'Bob' && said.data.body === 'Love the downtown focus.', said.data);
  const forged = await bob.client.from('community_comments').insert({ map_id: mapId, author_id: alice.id, author_name: 'Alice', body: 'I hate my own map' }).select('author_id').single();
  check('a comment cannot be attributed to someone else', !forged.error && forged.data?.author_id === bob.id, forged.error?.message ?? forged.data);
  const reply = await alice.client.from('community_comments').insert({ map_id: mapId, author_id: alice.id, author_name: '', body: 'Thanks!', parent_id: said.data!.id }).select('id, parent_id').single();
  const nested = await bob.client.from('community_comments').insert({ map_id: mapId, author_id: bob.id, author_name: '', body: 'Anytime.', parent_id: reply.data!.id }).select('parent_id').single();
  check('a reply to a reply stays in the same thread', reply.data?.parent_id === said.data!.id && nested.data?.parent_id === said.data!.id);
  const crossed = await bob.client.from('community_comments').insert({ map_id: branched.data, author_id: bob.id, author_name: '', body: 'x', parent_id: said.data!.id });
  check('a reply cannot be attached to a comment on a different map', !!crossed.error);
  const commentCount = await nobody.from('community_maps').select('comment_count').eq('id', mapId).single();
  check('the map counts its comments', commentCount.data?.comment_count === 4, commentCount.data);
  const thread = await nobody.from('community_comments').select('id').eq('map_id', mapId);
  check('anyone can read the thread', thread.data?.length === 4);
  const censor = await alice.client.from('community_comments').delete().eq('id', said.data!.id).select('id');
  check('a map’s author cannot delete someone else’s comment', (censor.data?.length ?? 0) === 0);
  const retract = await bob.client.from('community_comments').delete().eq('id', forged.data ? (await bob.client.from('community_comments').select('id').eq('body', 'I hate my own map').single()).data!.id : '').select('id');
  check('a commenter can delete their own', retract.data?.length === 1);

  // ---- the real sign-in: anonymous device -> emailed code -> same user, now allowed
  const email = `walkin-${run}@example.com`;
  const before = guestUser.id;
  const asked = await guest.auth.updateUser({ email });
  const code = await codeFor(email);
  check('attaching an email sends a six-digit code', !asked.error && !!code, asked.error?.message ?? code);
  const stillGuest = await guest.rpc('publish_map', { content: board(`Too early ${run}`, 5), message: '' });
  check('an unverified email unlocks nothing', !!stillGuest.error);
  const wrong = await guest.auth.verifyOtp({ email, token: code === '000000' ? '111111' : '000000', type: 'email_change' });
  check('a wrong code is refused', !!wrong.error);
  const verified = await guest.auth.verifyOtp({ email, token: code!, type: 'email_change' });
  check('the right code signs in, as the same user the device already was', !verified.error && verified.data.user?.id === before, verified.error?.message);
  const nowAllowed = await guest.rpc('publish_map', { content: board(`Walk-in map ${run}`, 5), message: 'hello' });
  check('...who can now publish', !nowAllowed.error, nowAllowed.error?.message);

  // ---- deleting
  const notYours = await bob.client.from('community_maps').delete().eq('id', mapId).select('id');
  check('someone else cannot delete a map', (notYours.data?.length ?? 0) === 0);
  const gone = await alice.client.from('community_maps').delete().eq('id', mapId).select('id');
  check('its author can', gone.data?.length === 1, gone.error?.message);
  const orphan = await nobody.from('community_maps').select('id, parent_map_id').eq('id', branched.data).maybeSingle();
  check('a branch outlives the map it came from', !!orphan.data && orphan.data.parent_map_id === null, orphan.data);
  const leftovers = await nobody.from('community_comments').select('id').eq('map_id', mapId);
  check('the deleted map’s thread goes with it', (leftovers.data?.length ?? -1) === 0);

  // tidy: everything this run created
  await bob.client.from('community_maps').delete().eq('id', branched.data);
  await guest.from('community_maps').delete().eq('id', nowAllowed.data);
  for (const id of [alice.id, bob.id, noName.id, before]) await admin.auth.admin.deleteUser(id);

  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:community crashed:', e);
  process.exit(1);
});
