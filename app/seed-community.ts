// Fills a Supabase project with dummy community content to click around in:
// four signed-up players, five maps cut from the shipped board, a second
// version, two branches, likes, dislikes and a few comment threads.
//
//   cd app
//   npx tsx seed-community.ts            # add the dummy content (safe to re-run: it replaces its own)
//   npx tsx seed-community.ts --reset    # remove it again
//
// Everything it creates belongs to accounts named dummy-*@jetleg.test, and
// --reset deletes exactly those accounts and what they own — nothing else.
// Local stack by default; point SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// SUPABASE_ANON_KEY elsewhere to seed another project.
//
// The dummy accounts can be signed into from the app like any other: ask
// for a code for e.g. dummy-maya@jetleg.test and read it from the local
// mail catcher at http://127.0.0.1:54324.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { mapFromBoard, type MapFile } from './src/community/format';
import type { Station } from './src/engine/types';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(url, serviceKey);
const PEOPLE = ['Maya', 'Dev', 'Rosa', 'Theo'] as const;
const emailOf = (name: string) => `dummy-${name.toLowerCase()}@jetleg.test`;

async function removeDummies(): Promise<number> {
  let removed = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    for (const u of data.users) {
      if (u.email && /^dummy-.+@jetleg\.test$/.test(u.email)) {
        // Their maps, comments and reactions cascade from the user row.
        await admin.auth.admin.deleteUser(u.id);
        removed++;
      }
    }
    if (data.users.length < 200) break;
  }
  return removed;
}

async function person(name: string): Promise<SupabaseClient> {
  const email = emailOf(name);
  const password = `dummy-${crypto.randomUUID()}`;
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw new Error(`${name}: ${made.error.message}`);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
  await client.from('profiles').upsert({ id: data.user.id, display_name: name });
  return client;
}

const all = (JSON.parse(readFileSync('public/data/stations.json', 'utf8')) as { stations: Station[] }).stations;
const cut = (name: string, description: string, keep: (s: Station) => boolean, rules: MapFile['rules'] = {}): MapFile => ({
  ...mapFromBoard(all.filter(keep), rules, name, 'sf'),
  description,
});

async function publish(who: SupabaseClient, map: MapFile, message: string, parentVersion?: string): Promise<{ mapId: string; versionId: string }> {
  const { data, error } = await who.rpc('publish_map', { content: map, message, ...(parentVersion ? { parent_version: parentVersion } : {}) });
  if (error) throw new Error(`publishing “${map.name}”: ${error.message}`);
  const head = await who.from('community_maps').select('head_version_id').eq('id', data).single();
  return { mapId: data as string, versionId: head.data!.head_version_id };
}

const say = async (who: SupabaseClient, mapId: string, body: string, parentId?: string): Promise<string> => {
  const me = (await who.auth.getUser()).data.user!.id;
  const { data, error } = await who.from('community_comments')
    .insert({ map_id: mapId, author_id: me, author_name: '', body, ...(parentId ? { parent_id: parentId } : {}) })
    .select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
};
const rate = (who: SupabaseClient, mapId: string, value: 1 | -1) => who.rpc('react_to_map', { map: mapId, new_value: value });

(async () => {
  const removed = await removeDummies();
  if (process.argv.includes('--reset')) {
    console.log(`Removed ${removed} dummy account${removed === 1 ? '' : 's'} and everything they published, from ${url}.`);
    return;
  }

  const [maya, dev, rosa, theo] = await Promise.all(PEOPLE.map(person));

  const downtown = cut('Downtown sprint',
    'Everything east of Van Ness and north of 16th. Dense, walkable, over in ninety minutes. Good for a first game.',
    (s) => s.lon > -122.4215 && s.lat > 37.765, { gameSize: 'small' });
  const west = cut('Fog belt',
    'West of Stanyan only: the Richmond, the Sunset and the park between them. Long bus rides, few stations, lots of bluffing.',
    (s) => s.lon < -122.455, { gameSize: 'medium' });
  const rail = cut('Rails only',
    'Just the stops with rail, metro, cable car or ferry service. No bus-only corners to hide on.',
    (s) => s.modes.some((m) => m !== 'bus'), { gameSize: 'medium' });
  const south = cut('Southern neighborhoods',
    'Everything south of Cesar Chavez. Underused in the standard board and surprisingly hard to seek in.',
    (s) => s.lat < 37.748, { gameSize: 'medium', supervisorDistrictsAsAdmin4: true });
  const full = cut('The whole city, districts on',
    'The standard 192 stations, with supervisor districts counted as the 4th administrative division.',
    () => true, { gameSize: 'large', supervisorDistrictsAsAdmin4: true });

  const a = await publish(maya, downtown, 'First cut');
  const b = await publish(dev, west, 'First cut');
  const c = await publish(rosa, rail, 'First cut');
  const d = await publish(theo, south, 'First cut');
  const e = await publish(maya, full, 'Standard board, one house rule');

  // A second version: Maya pulls the waterfront back in.
  const downtown2 = cut(downtown.name, `${downtown.description}\n\nv2 adds the Mission Bay stops after feedback.`,
    (s) => s.lon > -122.4215 && s.lat > 37.765 || (s.lon > -122.40 && s.lat > 37.755), { gameSize: 'small' });
  const v2 = await maya.rpc('publish_map_version', { map: a.mapId, content: downtown2, message: 'Added Mission Bay' });
  if (v2.error) throw new Error(v2.error.message);

  // Two branches: one from Downtown's *first* version, one from Fog belt.
  const f = await publish(dev, cut('Downtown sprint, no Chinatown',
    'Maya’s downtown board without the stops north of Broadway — too easy to disappear in.',
    (s) => s.lon > -122.4215 && s.lat > 37.765 && s.lat < 37.797, { gameSize: 'small' }), 'Dropped everything north of Broadway', a.versionId);
  const g = await publish(rosa, cut('Fog belt plus the Presidio',
    'Dev’s west-side board, stretched north-east to take in the Presidio and the Marina.',
    (s) => s.lon < -122.455 || (s.lon < -122.43 && s.lat > 37.795), { gameSize: 'medium' }), 'Added the Presidio and Marina', b.versionId);

  await Promise.all([
    rate(dev, a.mapId, 1), rate(rosa, a.mapId, 1), rate(theo, a.mapId, 1),
    rate(maya, b.mapId, 1), rate(theo, b.mapId, -1),
    rate(maya, c.mapId, 1), rate(dev, c.mapId, 1),
    rate(rosa, d.mapId, -1),
    rate(theo, e.mapId, 1),
    rate(maya, f.mapId, 1), rate(dev, g.mapId, 1), rate(theo, g.mapId, 1),
  ]);

  const t1 = await say(rosa, a.mapId, 'Played this Saturday with five people. Perfect length. The stops along the Embarcadero are too close together though — two of them are basically the same zone.');
  await say(maya, a.mapId, 'Agreed, I noticed that too. v2 keeps them but adds Mission Bay so there is somewhere to run to.', t1);
  await say(dev, a.mapId, 'I branched it without Chinatown if anyone wants a harder seek.', t1);
  await say(theo, a.mapId, 'Like: radar questions actually matter at this size. Dislike: thermometer is nearly useless downtown, every trip is two blocks.');
  const t2 = await say(theo, b.mapId, 'Not for me. Forty minutes on the N to ask one question.');
  await say(dev, b.mapId, 'That is the point! But fair. Rosa’s branch with the Presidio gives seekers a second way in.', t2);
  await say(maya, c.mapId, 'Great for visitors who only know the Muni map.');
  await say(rosa, d.mapId, 'Dislike the district house rule here — half the board is one district.');

  console.log(`Seeded ${url}:`);
  console.log(`  4 players   ${PEOPLE.map(emailOf).join(', ')}`);
  console.log('  7 maps      5 originals, 2 branches; “Downtown sprint” has 2 versions');
  console.log('  12 reactions, 8 comments in 5 threads');
  console.log('\nOpen the app > Map > Community maps. Remove it all again with: npx tsx seed-community.ts --reset');
})().catch((e) => {
  console.error('seed-community failed:', e.message ?? e);
  process.exit(1);
});
