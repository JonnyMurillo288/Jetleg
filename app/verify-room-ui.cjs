// Verification for the game room and live location sharing, through the UI.
// Two real browsers — a seeker and a hider, standing in different places —
// create and join a game the way players would, then each map is asked what
// it actually drew, and the hider's browser is watched for anything it sends.
//
// verify-room.ts proves the server refuses a hider's broadcast. This proves
// the app never attempts one, and that the dot really reaches the map.
//
// Needs `supabase start` and a built app served on :4310
// (`npm run build && npx vite preview --port 4310`).
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// The hider's answer assistant only exists inside a round, and a round needs
// a pass. With the stack's testing code set (supabase/functions/.env) the
// hider signs in as a developer here; without it, that part is skipped.
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const TEST_CODE = process.env.TEST_LOGIN_CODE ||
  (fs.existsSync('../supabase/functions/.env') ? (fs.readFileSync('../supabase/functions/.env', 'utf8').match(/^TEST_LOGIN_CODE=(\S+)/m) || [])[1] : '') || '';

const SEEKER_AT = { latitude: 37.7793, longitude: -122.4194 }; // Civic Center
const HIDER_AT = { latitude: 37.7694, longitude: -122.4477 };  // must never leave the hider's browser
const SEEKER2_AT = { latitude: 37.7701, longitude: -122.4466 }; // a second seeker, a block from the hider

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
  if (!ok) fail.push(name);
};

const clickText = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
}, [text, sel]);

const peersOnMap = (p) => p.evaluate(() =>
  window.__map.queryRenderedFeatures({ layers: ['peers-dot'] }).map(f => ({
    name: f.properties.name, stale: f.properties.stale,
    lon: +f.geometry.coordinates[0].toFixed(4), lat: +f.geometry.coordinates[1].toFixed(4),
  })));

async function player(browser, at, target) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.addInitScript((where) => {
    const fix = () => ({ coords: { ...where, accuracy: 15 }, timestamp: Date.now() });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: cb => setTimeout(() => cb(fix()), 50), watchPosition: cb => { setTimeout(() => cb(fix()), 50); return 1; }, clearWatch: () => {} },
    });
  }, at);
  // Everything this browser sends, by either route Realtime accepts.
  const sent = [];
  p.on('websocket', ws => ws.on('framesent', f => sent.push(String(f.payload))));
  p.on('request', r => { const body = r.postData(); if (body) sent.push(body); });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  return { p, sent, errors };
}

(async () => {
  const target = process.env.TARGET || 'http://127.0.0.1:4310/';
  console.log('target:', target, '\n');
  const browser = await chromium.launch();
  const seeker = await player(browser, SEEKER_AT, target);
  const hider = await player(browser, HIDER_AT, target);
  const seeker2 = await player(browser, SEEKER2_AT, target);
  hider.p.on('dialog', d => d.accept());

  // The hider gets into a round first (developer access, via the testing code).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const hiderEmail = `hider-${Date.now()}@example.com`;
  let inRound = false;
  if (TEST_CODE) {
    await admin.from('developers').upsert({ email: hiderEmail, note: 'verify:room:ui' });
    await admin.from('test_logins').upsert({ email: hiderEmail, note: 'verify:room:ui' });
    await clickText(hider.p, '^Hider$', '.topbar button');
    await hider.p.waitForTimeout(2500);
    await clickText(hider.p, 'Start a new round');
    await hider.p.waitForSelector('.accountbox input[type="email"]', { timeout: 10000 });
    await hider.p.fill('.accountbox input[type="email"]', hiderEmail);
    await clickText(hider.p, 'I have a testing code');
    await hider.p.fill('.accountbox input.code', TEST_CODE);
    await clickText(hider.p, '^Sign in$');
    await hider.p.waitForFunction(() => !/Unlock JetLeg SF/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 20000 });
    await clickText(hider.p, 'Start a new round');
    inRound = await hider.p.waitForSelector('.seekerpin', { timeout: 15000 }).then(() => true, () => false);
    check('the hider is in a round, with the hand-placed seekers pin on offer', inRound);
  } else {
    console.log('SKIP  hider answer-assistant checks: no TEST_LOGIN_CODE on this stack, so the hider cannot start a round');
  }

  // ---- seeker creates the game
  await clickText(seeker.p, '^Game', '.gpsrow button');
  await seeker.p.fill('.gameroom .field input', 'Sam');
  await seeker.p.fill('.gameroom input[placeholder="Your team\'s name"]', 'Blue');
  await clickText(seeker.p, 'Create game');
  await seeker.p.waitForSelector('.gamecode strong', { timeout: 15000 });
  const code = (await seeker.p.textContent('.gamecode strong')).trim();
  check('creating a game shows its code', /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
  check('the code stays visible in the top bar', (await seeker.p.textContent('.gpsrow')).includes(code));

  // ---- hider switches role, then joins with the code
  await clickText(hider.p, '^Hider$', '.topbar button');
  await clickText(hider.p, '^Game', '.gpsrow button');
  await hider.p.fill('.gameroom .field input', 'Hana');
  await hider.p.fill('.gameroom input.code', code.toLowerCase());
  await clickText(hider.p, 'Find game');
  await hider.p.waitForSelector('.gameroom .hint.fact .list', { timeout: 15000 });
  check('the code lists the existing team', /Blue/.test(await hider.p.textContent('.gameroom .hint.fact')));
  await hider.p.fill('.gameroom input[placeholder="Or a new team\'s name"]', 'Red');
  await clickText(hider.p, 'Add team');
  await hider.p.waitForSelector('.gamecode strong', { timeout: 15000 });
  check('the hider is told this phone sends nothing',
    await hider.p.waitForFunction(() => /this phone sends nothing/.test(document.querySelector('.gameroom .hint')?.textContent || ''), null, { timeout: 15000 }).then(() => true, () => false));

  // ---- the hider's map draws the seeker, where the seeker really is.
  // Polled for: the dot does not exist until a broadcast has arrived.
  await hider.p.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['peers-dot'] }).length > 0, null, { timeout: 25000 }).catch(() => {});
  const seen = await peersOnMap(hider.p);
  check('the hider’s map draws the seeker', seen.length === 1 && seen[0].name === 'Sam', JSON.stringify(seen));
  check('...at the seeker’s real position', seen[0]?.lon === SEEKER_AT.longitude && seen[0]?.lat === SEEKER_AT.latitude);
  check('...labelled by name', (await hider.p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['peers-label'] }).length)) === 1);
  await hider.p.evaluate(() => document.querySelector('.sheet-handle').click());
  await hider.p.waitForTimeout(600);
  await hider.p.screenshot({ path: process.env.SHOT || '/tmp/room-hider.png' });
  await hider.p.evaluate(() => document.querySelector('.sheet-handle').click());

  // ---- a second seeker joins the first one's team
  await clickText(seeker2.p, '^Game', '.gpsrow button');
  await seeker2.p.fill('.gameroom .field input', 'Alex');
  await seeker2.p.fill('.gameroom input.code', code);
  await clickText(seeker2.p, 'Find game');
  await seeker2.p.waitForSelector('.gameroom .hint.fact .list', { timeout: 15000 });
  await clickText(seeker2.p, '^Join$', '.gameroom .hint.fact button');
  await seeker2.p.waitForSelector('.gamecode strong', { timeout: 15000 });
  await hider.p.waitForFunction(() => window.__map.getSource('peers').serialize().data.features.length === 2, null, { timeout: 25000 }).catch(() => {});
  check('with two seekers in the game, the hider’s map has both', (await peersOnMap(hider.p)).map(f => f.name).sort().join(',') === 'Alex,Sam' || (await hider.p.evaluate(() => window.__map.getSource('peers').serialize().data.features.map(f => f.properties.name).sort().join(','))) === 'Alex,Sam');

  // ---- the hider's seekers point is those live positions, not a pin dropped by hand
  if (inRound) {
    const srcOf = (id) => hider.p.evaluate((i) => window.__map.getSource(i).serialize().data.features.map(f => ({ ...f.properties, lon: +f.geometry.coordinates[0].toFixed(4), lat: +f.geometry.coordinates[1].toFixed(4) })), id);
    const panel = () => hider.p.textContent('.sheet');
    await clickText(hider.p, '^Play$', '.topbar button');
    await hider.p.waitForSelector('.seekerlive', { timeout: 10000 });
    check('the hider’s panel says whose live position answers are measured from', /measured from\s*Alex’s live position/.test(await panel()), (await hider.p.textContent('.seekerlive')).slice(0, 90));
    check('...and offers every live seeker, plus the hider’s own pin', await hider.p.evaluate(() => [...document.querySelectorAll('.seekerlive .chip')].map(c => c.textContent).join('|') === 'Alex|Sam|My pin'));
    let peers = await srcOf('peers');
    check('the followed seeker’s dot is the pin: marked on the map, no separate hand pin', peers.find(f => f.name === 'Alex')?.followed === true && peers.find(f => f.name === 'Sam')?.followed === false && !(await srcOf('pins')).some(f => f.role === 'seekers'));

    await clickText(hider.p, '^Radar', '.chips .chip');
    const away = async () => (await hider.p.waitForFunction(() => /The seekers are/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 10000 }).then(() => hider.p.evaluate(() => [...document.querySelectorAll('.hint.fact')].find(h => /The seekers are/.test(h.textContent))?.querySelector('b')?.textContent), () => null));
    const nearText = await away();
    check('distance to the seekers is the followed seeker’s — Alex, a block away', /ft$/.test(nearText || ''), nearText);
    await clickText(hider.p, '^Sam', '.seekerlive .chip');
    await hider.p.waitForFunction(() => /measured from\s*Sam’s live position/.test(document.querySelector('.seekerlive')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    const farText = await away();
    check('choosing the other seeker measures from them instead — Sam, across town', /mi$/.test(farText || '') && parseFloat(farText) > 1 && parseFloat(farText) < 2.2, farText);
    peers = await srcOf('peers');
    check('...and moves the mark on the map', peers.find(f => f.name === 'Sam')?.followed === true && peers.find(f => f.name === 'Alex')?.followed === false);

    if (process.env.SHOT_PANEL) await hider.p.screenshot({ path: process.env.SHOT_PANEL });

    // A stray tap on the map used to place the pin. It must not hijack a live follow.
    await hider.p.evaluate(() => { const c = window.__map.getCanvas().getBoundingClientRect(); return [c.left + c.width * 0.2, c.top + c.height * 0.8]; }).then(([x, y]) => hider.p.mouse.click(x, y));
    await hider.p.waitForTimeout(800);
    check('a stray tap on the map does not replace the live position with a hand pin', /measured from\s*Sam’s live position/.test(await hider.p.textContent('.seekerlive')) && !(await srcOf('pins')).some(f => f.role === 'seekers'));

    // Followed positions are derived, never copied into the saved round.
    const stored = await hider.p.evaluate(async () => {
      const dbs = await indexedDB.databases();
      let all = '';
      for (const d of dbs) {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const name of db.objectStoreNames) {
          const rows = await new Promise((res) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
          all += JSON.stringify(rows);
        }
        db.close();
      }
      return all;
    });
    check('no seeker’s position has been written to the hider’s storage', stored.length > 100 && !stored.includes(String(SEEKER_AT.latitude)) && !stored.includes(String(SEEKER2_AT.latitude)), `${stored.length} bytes scanned`);

    await clickText(hider.p, '^Thermometer', '.chips .chip');
    await clickText(hider.p, 'Start = where Sam is now');
    await hider.p.waitForFunction(() => window.__map.getSource('pins').serialize().data.features.some(f => f.properties.role === 'start'), null, { timeout: 8000 }).catch(() => {});
    const startPin = (await srcOf('pins')).find(f => f.role === 'start');
    check('a thermometer’s start can be taken from the seeker’s live position', startPin?.lon === SEEKER_AT.longitude && startPin?.lat === SEEKER_AT.latitude, JSON.stringify(startPin));

    await clickText(hider.p, '^My pin$', '.seekerlive .chip');
    await hider.p.waitForSelector('.seekerpin', { timeout: 8000 });
    check('“My pin” goes back to the hand-placed pin', /measured from the pin you placed/.test(await hider.p.textContent('.seekerlive')) && (await srcOf('peers')).every(f => !f.followed));
    await clickText(hider.p, '^Alex', '.seekerlive .chip');
    await clickText(hider.p, '^Game', '.gpsrow button');
  }

  // ---- and nothing of the hider goes anywhere. Two heartbeats' worth of time.
  await seeker.p.waitForTimeout(22000);
  const onSeekers = await seeker.p.evaluate(() => window.__map.getSource('peers').serialize().data.features.map(f => f.properties.name));
  check('the seekers’ maps draw each other, and never the hider', onSeekers.join(',') === 'Alex', JSON.stringify(onSeekers));
  const leak2 = hider.sent.filter(s => /"loc"/.test(s) && /"lon"/.test(s));
  check('following a seeker made the hider send nothing either', leak2.length === 0);
  const leak = hider.sent.filter(s => s.includes(String(HIDER_AT.latitude)) || s.includes(String(HIDER_AT.longitude)));
  check('the hider’s browser never sent its own coordinates, over any socket or request', leak.length === 0, leak[0]?.slice(0, 160));
  check('the hider’s browser sent no location broadcast at all', !hider.sent.some(s => /"loc"/.test(s) && /"lon"/.test(s)));
  check('the seeker’s browser did send its position (the watch above is not blind)', seeker.sent.some(s => s.includes(String(SEEKER_AT.latitude))));
  check('the seeker’s room shows the hider as hiding', /Hana.*hiding/s.test(await seeker.p.textContent('.gameroom')) ||
    await seeker.p.waitForFunction(() => /Hana[\s\S]*hiding/.test(document.querySelector('.gameroom')?.textContent || ''), null, { timeout: 20000 }).then(() => true, () => false));

  // ---- swap: the seeker goes into hiding, and must vanish from the other map
  await clickText(seeker.p, '^Hider$', '.topbar button');
  const gone = await hider.p.waitForFunction(() => !window.__map.getSource('peers').serialize().data.features.some(f => f.properties.name === 'Sam'), null, { timeout: 15000 }).then(() => true, () => false);
  check('switching to hider removes that player from everyone’s map', gone);

  // ---- leaving
  await clickText(hider.p, 'Leave game');
  await hider.p.waitForSelector('.gameroom input.code', { timeout: 10000 });
  check('leaving returns to the lobby', true);
  await hider.p.reload({ waitUntil: 'domcontentloaded' });
  await hider.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  check('...and stays left after a reload', !(await hider.p.textContent('.gpsrow')).includes(code));

  await seeker.p.reload({ waitUntil: 'domcontentloaded' });
  await seeker.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await seeker.p.waitForFunction((c) => document.querySelector('.gpsrow')?.textContent.includes(c), code, { timeout: 10000 }).catch(() => {});
  check('a reload keeps a player in their game', (await seeker.p.textContent('.gpsrow')).includes(code));

  check('no page errors', seeker.errors.length + hider.errors.length + seeker2.errors.length === 0, JSON.stringify([...seeker.errors, ...hider.errors, ...seeker2.errors]));
  if (TEST_CODE) {
    await admin.from('developers').delete().eq('email', hiderEmail);
    await admin.from('test_logins').delete().eq('email', hiderEmail);
  }

  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:room:ui crashed:', e);
  process.exit(1);
});
