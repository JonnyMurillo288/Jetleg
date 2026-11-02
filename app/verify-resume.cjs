// Verification for resuming rounds — finished ones included (App.tsx
// `resumeRound`, RoundGate, the Results tab). Real browser, real app.
//
// Rounds arrive the way a player's would: a game file, kept on the device
// from the stats page. A pass is put in the device's cache before the game
// loads; the app re-checks with the server and keeps it for that page load,
// which is all a check here needs. A second device with no pass checks the
// paywall instead.
//
// Needs a built app on :4310. With `supabase start` (and `npm run
// seed:community`) it also checks that resuming puts a published map back.
const { chromium } = require('playwright');
const { existsSync, readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
const supabaseUrl = process.env.SUPABASE_URL || env.match(/^VITE_SUPABASE_URL=(\S+)/m)?.[1] || '';
const anonKey = process.env.SUPABASE_ANON_KEY || env.match(/^VITE_SUPABASE_ANON_KEY=(\S+)/m)?.[1] || '';

const fail = [];
let skipped = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}  (${why})`); };

const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8')).stations;
const START = Date.now() - 3 * 3600_000;
const MIN = 60_000;
const CIVIC = [-122.4194, 37.7793];

const round = (id, label, more = {}) => ({
  id, role: 'seeker', label, startedAt: START, endedAt: START + 90 * MIN,
  asks: [{ id: `${id}-a1`, questionId: 'radar-2000', askedAt: START + 10 * MIN, origin: CIVIC, answer: { kind: 'yesno', value: 'yes' } }],
  ...more,
});

const clickText = (p, re, sel) => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t).test(e.textContent || ''));
  if (!el) throw new Error(`no ${s} matching ${t}`);
  el.click();
}, [re, sel]);
/** The Resume button on the previous-rounds row whose text matches. */
const resumeRow = (p, re) => p.evaluate((t) => {
  const li = [...document.querySelectorAll('.sheet .list li')].find((l) => new RegExp(t).test(l.textContent || ''));
  const btn = li && [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Resume');
  if (!btn) throw new Error(`no Resume button on a round matching ${t}`);
  btn.click();
}, re);
const count = (p) => p.evaluate(() => (document.querySelector('.topbar .count')?.textContent ?? '').replace(/\s/g, ''));

async function device(browser, withPass) {
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.addInitScript(() => {
    const fix = { coords: { latitude: 37.7793, longitude: -122.4194, accuracy: 15 }, timestamp: Date.now() };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (cb) => setTimeout(() => cb(fix), 50), watchPosition: (cb) => { setTimeout(() => cb(fix), 50); return 1; }, clearWatch: () => {} },
    });
  });
  await p.goto(origin + '#/about');
  if (withPass) {
    // The cache the game reads before it asks the server (payments/entitlement.ts).
    await p.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onupgradeneeded = () => open.result.createObjectStore('keyval');
      open.onsuccess = () => {
        const tx = open.result.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ eligible: true, product: 'week_pass', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), gameId: null }, 'payments/entitlement');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    }));
  }
  return { ctx, p, errors };
}

/** Keep a game file's rounds on this device, the way a player does from the stats page. */
async function keep(p, rounds, dir) {
  const file = path.join(dir, `rounds-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ app: 'jetleg-sf', version: 1, exportedAt: Date.now(), role: 'seeker', settings: {}, rounds }));
  await p.goto(origin + '#/stats');
  await p.waitForSelector('.page-body input[type=file]', { state: 'attached' });
  await p.setInputFiles('.page-body input[type=file]', file);
  await p.waitForSelector('.openedfile');
  await clickText(p, 'Keep these rounds on this device', '.openedfile button');
  await p.waitForFunction(() => /Added to this device/.test(document.querySelector('.openedfile')?.textContent || ''), null, { timeout: 5000 });
}

async function toGame(p) {
  await p.goto(origin + '#/play');
  await p.reload();
  await p.waitForFunction(() => window.__mapReady === true && window.__map?.isStyleLoaded(), null, { timeout: 45000 });
  await p.waitForSelector('.sheet h2', { timeout: 20000 });
  await p.waitForTimeout(1200);
}

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jetleg-resume-'));
  console.log('target:', origin, '\n');

  // What the server has to put back: the smallest published map for San Francisco.
  let published = null;
  if (supabaseUrl && anonKey) {
    const rows = await fetch(`${supabaseUrl}/rest/v1/community_maps?select=name,head_version_id,station_count&city=eq.sf&order=station_count.asc&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    }).then((r) => (r.ok ? r.json() : []), () => []);
    published = rows[0] ?? null;
  }

  const hider = stations.find((s) => Math.hypot(s.lon - CIVIC[0], s.lat - CIVIC[1]) < 0.01);
  const ended = round('resume-ended', 'Ended round', { hiderStationId: hider.id });
  const onFile = round('resume-file', 'Round on a file map', { board: { name: 'A map from a file', versionId: null, stationCount: 12 } });
  const onMap = published && round('resume-map', 'Round on a published map', {
    board: { name: published.name, versionId: published.head_version_id, stationCount: published.station_count },
  });

  const browser = await chromium.launch();

  // ---------------------------------------------------------- no pass
  {
    const { ctx, p, errors } = await device(browser, false);
    await keep(p, [ended], dir);
    await toGame(p);
    await resumeRow(p, 'Ended round');
    await p.waitForTimeout(800);
    const sheet = await p.textContent('.sheet');
    check('without a pass, reopening an ended round asks for one, as starting does', /Unlock JetLeg SF/.test(sheet) && (await p.$('.qrow')) === null);
    check('no page errors (no pass)', errors.length === 0, errors);
    await ctx.close();
  }

  // ---------------------------------------------------------- with a pass
  const { ctx, p, errors } = await device(browser, true);
  await keep(p, [ended, onFile, ...(onMap ? [onMap] : [])], dir);
  await toGame(p);

  const listed = await p.evaluate(() => [...document.querySelectorAll('.sheet .list li')].map((li) => ({
    text: li.textContent.replace(/\s+/g, ' '),
    buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()),
  })));
  check('previous rounds say which are ended', listed.some((r) => /Ended round.*ended/.test(r.text)), listed.map((r) => r.text));
  check('each previous round has Resume next to Delete', listed.length > 0 && listed.every((r) => JSON.stringify(r.buttons) === '["Resume","Delete"]'), listed.map((r) => r.buttons));
  // A button, not a link that looks like the rest of the row: a solid green fill, and a real size.
  const look = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.sheet .list li button')].find((x) => x.textContent.trim() === 'Resume');
    const s = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return { background: s.backgroundColor, color: s.color, w: Math.round(r.width), h: Math.round(r.height) };
  });
  const [rr, gg, bb] = (look.background.match(/\d+/g) || []).map(Number);
  check('Resume is a solid green button', gg > 120 && gg > rr + 60 && gg > bb + 20 && look.h >= 36 && look.w >= 60, look);

  await resumeRow(p, '^Ended round');
  const resumed = await p.waitForSelector('.qrow', { timeout: 15000 }).then(() => true, () => false);
  const within = stations.filter((s) => {
    const rad = (d) => (d * Math.PI) / 180;
    const h = Math.sin(rad(s.lat - CIVIC[1]) / 2) ** 2 + Math.cos(rad(CIVIC[1])) * Math.cos(rad(s.lat)) * Math.sin(rad(s.lon - CIVIC[0]) / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(h)) <= 2000;
  }).length;
  const c = await count(p);
  check('an ended round reopens, with its answers still applied', resumed && c === `${within}/${stations.length}`, { count: c, expected: `${within}/${stations.length}` });
  const hiderDrawn = await p.evaluate(() => window.__map.getSource('hider')?.serialize().data.features?.length ?? 0);
  check('a seeker’s map does not draw the hider’s station they recorded afterwards', hiderDrawn === 0, hiderDrawn);

  await clickText(p, '^Log \\(', '.sheet button, .chip');
  await clickText(p, '^End game$', '.sheet button');
  await p.waitForSelector('.sheet h2');
  await clickText(p, '^Results$', '.topbar button');
  const results = await p.textContent('.list.results');
  check('ending it again puts it back among finished rounds', /Ended round/.test(results), results.trim().slice(0, 80));

  // From the Results tab, a round on a file map: refused, with the reason.
  await clickText(p, 'Round on a file map', '.list.results button');
  await clickText(p, '^Resume this round$', '.sheet button');
  await p.waitForFunction(() => /opened from a file/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const refused = await p.textContent('.sheet');
  check('a round on a board this device cannot load is not resumed, and says why', /opened from a file/.test(refused) && /\/192|192\//.test(await count(p)), (await count(p)));

  if (onMap) {
    await clickText(p, 'Back to results', '.sheet button');
    await clickText(p, 'Round on a published map', '.list.results button');
    await clickText(p, '^Resume this round$', '.sheet button');
    const n = published.station_count;
    await p.waitForFunction((k) => (document.querySelector('.topbar .count')?.textContent ?? '').replace(/\s/g, '').endsWith(`/${k}`), n, { timeout: 20000 }).catch(() => {});
    await p.waitForSelector('.qrow', { timeout: 15000 }).catch(() => {});
    const drew = await p.evaluate(() => new Set(window.__map.queryRenderedFeatures({ layers: ['stations-dot'] }).map((f) => f.properties.id)).size);
    const tab = await p.evaluate(() => document.querySelector('.topbar .seg button.on')?.textContent);
    check(`resuming a round on “${published.name}” puts that map back first, and goes to Play`,
      (await count(p)).endsWith(`/${n}`) && drew === n && (await p.$('.qrow')) !== null, { count: await count(p), drew, tab });

    // Ended again, and back to the built-in round: the built-in board comes back too.
    await clickText(p, '^Log \\(', '.sheet button, .chip');
    await clickText(p, '^End game$', '.sheet button');
    await p.waitForSelector('.sheet h2');
    await resumeRow(p, '^Ended round');
    await p.waitForSelector('.qrow', { timeout: 15000 }).catch(() => {});
    await p.waitForFunction((k) => (document.querySelector('.topbar .count')?.textContent ?? '').endsWith(`/${k}`), stations.length, { timeout: 15000 }).catch(() => {});
    check('resuming a built-in-board round from a map puts the built-in board back', (await count(p)) === `${within}/${stations.length}`, await count(p));
  } else skip('putting a published map back on resume', 'no server, or no published map — run `npm run seed:community`');

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}${skipped ? ` — ${skipped} skipped` : ''}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('verify:resume crashed:', e); process.exit(1); });
