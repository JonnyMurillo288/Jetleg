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

const SEEKER_AT = { latitude: 37.7793, longitude: -122.4194 }; // Civic Center
const HIDER_AT = { latitude: 37.7694, longitude: -122.4477 };  // must never leave the hider's browser

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

  // ---- and nothing of the hider goes anywhere. Two heartbeats' worth of time.
  await seeker.p.waitForTimeout(22000);
  check('the seeker’s map draws no one', (await peersOnMap(seeker.p)).length === 0, JSON.stringify(await peersOnMap(seeker.p)));
  const leak = hider.sent.filter(s => s.includes(String(HIDER_AT.latitude)) || s.includes(String(HIDER_AT.longitude)));
  check('the hider’s browser never sent its own coordinates, over any socket or request', leak.length === 0, leak[0]?.slice(0, 160));
  check('the hider’s browser sent no location broadcast at all', !hider.sent.some(s => /"loc"/.test(s) && /"lon"/.test(s)));
  check('the seeker’s browser did send its position (the watch above is not blind)', seeker.sent.some(s => s.includes(String(SEEKER_AT.latitude))));
  check('the seeker’s room shows the hider as hiding', /Hana.*hiding/s.test(await seeker.p.textContent('.gameroom')) ||
    await seeker.p.waitForFunction(() => /Hana[\s\S]*hiding/.test(document.querySelector('.gameroom')?.textContent || ''), null, { timeout: 20000 }).then(() => true, () => false));

  // ---- swap: the seeker goes into hiding, and must vanish from the other map
  await clickText(seeker.p, '^Hider$', '.topbar button');
  const gone = await hider.p.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['peers-dot'] }).length === 0, null, { timeout: 15000 }).then(() => true, () => false);
  check('switching to hider removes that player from everyone’s map', gone);

  // ---- leaving
  hider.p.on('dialog', d => d.accept());
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

  check('no page errors', seeker.errors.length + hider.errors.length === 0, JSON.stringify([...seeker.errors, ...hider.errors]));

  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:room:ui crashed:', e);
  process.exit(1);
});
