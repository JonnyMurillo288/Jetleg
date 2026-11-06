// Verification for reporting, moderating and deleting an account, through the
// UI in a real browser (0016, 0017; ui/CommunityPanel.tsx, pages/ModerationPage.tsx,
// ui/AccountBox.tsx). The database rules themselves are verify-moderation.ts.
//
//   bob  — a player, signed in in the browser: reports a map, later deletes his account
//   mod  — a moderator, signed in in a second browser: works the queue
//   ana, cy, di — set up through the API: ana publishes, cy and di report
//
// Needs `supabase start`, the testing code (supabase/functions/.env), and a
// built app on :4310 (`npm run build && npx vite preview --port 4310`).
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const TEST_CODE = process.env.TEST_LOGIN_CODE ||
  (fs.existsSync('../supabase/functions/.env') ? (fs.readFileSync('../supabase/functions/.env', 'utf8').match(/^TEST_LOGIN_CODE=(\S+)/m) || [])[1] : '') || '';
const TARGET = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(tmpdir(), 'jetleg-moderation-'));

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) fail.push(name);
};
const clickText = (p, t, s = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t).test(e.textContent || '') && !e.disabled);
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
}, [t, s]);
const waitText = (p, sel, re, timeout = 15000) =>
  p.waitForFunction(([s, r]) => [...document.querySelectorAll(s)].some((e) => new RegExp(r).test(e.textContent || '')), [sel, re], { timeout })
    .then(() => true, () => false);

const admin = createClient(SUPABASE_URL, SERVICE_KEY);
const run = Date.now();
const users = [];

async function apiMember(name) {
  const email = `${name.toLowerCase()}-ui-${run}@example.com`;
  const password = `pw-${run}`;
  const res = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (res.error) throw new Error(res.error.message);
  users.push(res.data.user.id);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  await client.from('profiles').upsert({ id: res.data.user.id, display_name: name });
  return client;
}

/** A browser that signs in with the testing code and picks a display name, on the community page. */
async function browserMember(browser, name) {
  const email = `${name.toLowerCase()}-ui-${run}@example.com`;
  await admin.from('test_logins').upsert({ email, note: 'verify:moderation:ui' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`${name} PAGEERROR`, e.message));
  await p.goto(TARGET + '#/maps', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await p.fill('.accountbox input[type="email"]', email);
  await clickText(p, 'I have a testing code');
  await p.fill('.accountbox input.code', TEST_CODE);
  await clickText(p, '^Sign in$');
  await p.waitForSelector('.accountbox input[placeholder="Display name"]', { timeout: 20000 });
  await p.fill('.accountbox input[placeholder="Display name"]', name);
  await clickText(p, '^Save$');
  await waitText(p, '.accountbox', `Signed in as\\s*${name}`);
  const { data } = await admin.from('profiles').select('id').eq('display_name', name).order('id').limit(50);
  return { p, ctx, email, name, ids: (data ?? []).map((r) => r.id) };
}

(async () => {
  if (!TEST_CODE) {
    console.log('SKIP  everything: signing in a browser needs the testing code (supabase/functions/.env)');
    process.exit(0);
  }
  console.log('target:', TARGET, '\nscreenshots:', shots, '\n');
  const stations = JSON.parse(fs.readFileSync('public/data/stations.json', 'utf8')).stations.slice(0, 10);
  const ana = await apiMember('Ana');
  const cy = await apiMember('Cy');
  const di = await apiMember('Di');
  const content = {
    format: 'jetleg-map', formatVersion: 1, kind: 'stations', city: 'sf', name: `Reported map ${run}`, description: 'For the moderation check',
    rules: { gameSize: 'small' }, stations: stations.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, modes: s.modes, routes: s.routes ?? [] })),
  };
  const pub = await ana.rpc('publish_map', { content, message: '' });
  if (pub.error) throw new Error('publish: ' + pub.error.message);
  const mapId = pub.data;

  const browser = await chromium.launch();
  try {
    // ---------------------------------------------------------- a player reports
    const bob = await browserMember(browser, `Bob${run % 100000}`);
    bob.p.on('dialog', (d) => d.type() === 'prompt' ? d.accept('Uses someone’s home as a station') : d.accept());
    await bob.p.goto(TARGET + `#/maps/map/${mapId}`);
    await bob.p.waitForSelector('.community h2', { timeout: 20000 });
    await clickText(bob.p, '^Report$', '.community button');
    check('a signed-in player can report a map, and is thanked', await waitText(bob.p, '.community .notice', 'a moderator will look'));
    for (const c of [cy, di]) await c.rpc('report_content', { map: mapId, reason: 'Personal details' });
    await bob.p.reload();
    check('after three reports, the map is gone for that player', await waitText(bob.p, '.community', 'no longer exists', 20000));

    // ---------------------------------------------------------- the moderator
    const modName = `Mod${run % 100000}`;
    await admin.from('moderators').upsert({ email: `${modName.toLowerCase()}-ui-${run}@example.com`, note: 'verify:moderation:ui' });
    const mod = await browserMember(browser, modName);
    mod.p.on('dialog', (d) => d.accept());
    check('a moderator sees the way to the queue on Community maps', await waitText(mod.p, '.community a', 'Moderation queue'));
    await mod.p.goto(TARGET + '#/moderation');
    const listed = await waitText(mod.p, '.modqueue li', `Reported map ${run}`, 20000);
    const item = await mod.p.evaluate((n) => [...document.querySelectorAll('.modqueue li')].find((li) => li.textContent.includes(n))?.textContent ?? '', `Reported map ${run}`);
    check('the queue lists the map, marked hidden, with every reason given', listed && /hidden/.test(item) && /home as a station/.test(item) && /Personal details/.test(item), item.slice(0, 200));
    await mod.p.screenshot({ path: path.join(shots, 'moderation-queue.png') });
    await mod.p.evaluate((n) => [...[...document.querySelectorAll('.modqueue li')].find((li) => li.textContent.includes(n)).querySelectorAll('button')].find((b) => b.textContent === 'Restore').click(), `Reported map ${run}`);
    await mod.p.waitForFunction((n) => ![...document.querySelectorAll('.modqueue li')].some((li) => li.textContent.includes(n)), `Reported map ${run}`, { timeout: 15000 }).catch(() => {});
    check('restoring takes it off the queue', !(await mod.p.evaluate((n) => [...document.querySelectorAll('.modqueue li')].some((li) => li.textContent.includes(n)), `Reported map ${run}`)));
    // The same address the player is already on: a reload, or nothing would ask again.
    await bob.p.reload();
    check('…and puts it back for the player', await waitText(bob.p, '.community h2', `Reported map ${run}`, 20000));
    await mod.p.goto(TARGET + `#/maps/map/${mapId}`);
    await mod.p.waitForSelector('.community h2', { timeout: 20000 });
    await clickText(mod.p, '^Hide \\(moderator\\)$', '.community button');
    check('a moderator can hide a map from its own page', await waitText(mod.p, '.community .hint', 'Hidden from everyone else'));

    // A player who is not a moderator gets nothing from the queue page.
    await bob.p.goto(TARGET + '#/moderation');
    check('the queue page shows a player nothing', await waitText(bob.p, '.page-body', 'for moderators'));

    // ---------------------------------------------------------- deleting the account
    const bobId = (await admin.from('profiles').select('id').eq('display_name', bob.name).maybeSingle()).data?.id;
    await bob.p.goto(TARGET + '#/maps');
    await bob.p.waitForSelector('.accountbox', { timeout: 20000 });
    await clickText(bob.p, '^Delete account$', '.accountbox button');
    check('after deleting, the device is signed out and offered sign-in again', await waitText(bob.p, '.accountbox', 'I have a testing code|Email me a code', 20000));
    const gone = bobId ? await admin.auth.admin.getUserById(bobId) : { error: 'no id' };
    check('…and the account is gone from the server', !!bobId && (!!gone.error || !gone.data.user), bobId);

    // ---------------------------------------------------------- the rules page
    await bob.p.goto(TARGET + '#/rules');
    check('the rules page covers playing safely, publishing and moderation',
      await waitText(bob.p, '.prose', 'Playing safely') && await waitText(bob.p, '.prose', 'Public places only') && await waitText(bob.p, '.prose', 'three different players'));
    await bob.p.screenshot({ path: path.join(shots, 'rules.png'), fullPage: true });
  } finally {
    await browser.close();
    await admin.from('moderators').delete().like('note', 'verify:moderation:ui');
    await admin.from('test_logins').delete().like('note', 'verify:moderation:ui');
    await admin.from('community_maps').delete().eq('id', mapId);
    for (const id of users) await admin.auth.admin.deleteUser(id);
    const { data: left } = await admin.from('profiles').select('id').like('display_name', `Mod${run % 100000}`);
    for (const r of left ?? []) await admin.auth.admin.deleteUser(r.id);
  }
  console.log(fail.length ? `\n${fail.length} FAILED:\n  ${fail.join('\n  ')}` : '\nALL PASS');
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
