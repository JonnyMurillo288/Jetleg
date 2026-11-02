// Takes the product screenshots the landing page uses, and the marketing
// copies of them: public/marketing/*.jpg (served by the site) and
// ../Marketing/screenshots/*.png (full size, kept out of git).
//
// Every picture is the real app, driven the way a player drives it — the
// studio editing the built-in San Francisco board, a seeker's round answered
// question by question, that round's stats. Nothing is mocked up.
//
//   npm run build && npx vite preview --port 4310     (in another terminal)
//   supabase start                                     (the round needs a sign-in)
//   npm run shot:marketing
//
// Needs a connection (basemap tiles) and the testing code in
// supabase/functions/.env, because a round cannot start without a pass.
// Like shot:landing, it refuses to save a picture of a map that did not draw.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const site = path.join(__dirname, '..', 'public', 'marketing');
const kept = path.join(__dirname, '..', '..', 'Marketing', 'screenshots');
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const functionsEnv = path.join(__dirname, '..', '..', 'supabase', 'functions', '.env');
const TEST_CODE = process.env.TEST_LOGIN_CODE ||
  (existsSync(functionsEnv) ? (readFileSync(functionsEnv, 'utf8').match(/^TEST_LOGIN_CODE=(\S+)/m) || [])[1] : '') || '';
const EMAIL = 'marketing-shots@example.com';

// Where the seeker starts: Civic Center.
const SEEKER_AT = { latitude: 37.7793, longitude: -122.4194, accuracy: 12 };

const click = (p, re, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t).test(e.textContent || '') && !e.disabled);
  if (!el) throw new Error(`no enabled ${s} matching ${t}`);
  el.click();
}, [re, sel]);
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
const settle = (p) => p.waitForFunction(() => window.__map.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 60000 })
  .then(() => p.waitForTimeout(800));
const fitBoard = async (p, padding) => {
  const bbox = await (await p.request.get(origin + 'data/bbox.json')).json();
  await p.evaluate(([[w, s, e, n], pad]) => {
    window.__map.resize();
    window.__map.fitBounds([[w, s], [e, n]], { padding: pad, animate: false });
  }, [bbox, padding]);
  await settle(p);
};
const drew = (p, layers) => p.evaluate((ls) => Object.fromEntries(ls.map((l) => [l, window.__map.getLayer(l) ? window.__map.queryRenderedFeatures({ layers: [l] }).length : 0])), layers);
const mustDraw = async (p, layers) => {
  const got = await drew(p, layers);
  console.log('  drew:', JSON.stringify(got));
  for (const l of layers) if (!got[l]) throw new Error(`nothing on ${l}; not saving a picture of an empty map`);
};

/** One picture, twice: a JPEG for the site, a PNG for the marketing folder. */
const shoot = async (target, name, onSite = true) => {
  await target.screenshot({ path: path.join(kept, `${name}.png`) });
  if (onSite) await target.screenshot({ path: path.join(site, `${name}.jpg`), type: 'jpeg', quality: 80 });
  console.log('saved', name);
};

async function studio(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await p.goto(origin + '#/maps', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await p.evaluate(() => [...document.querySelectorAll('.community button')].find((b) => /^More/.test(b.textContent) && b.getAttribute('aria-expanded') === 'false')?.click());
  await click(p, '^Open the San Francisco board$', '.community button');
  await p.waitForSelector('.editor');

  // Matching zones: one category's Voronoi cells, cut to the boundary, with
  // the hiding zones turned off the way the Layers button would.
  await click(p, '^Voronoi$', '.tabs button');
  const toggleLibraries = (to) => p.evaluate((label) => {
    const row = [...document.querySelectorAll('.editor li, .editor .row, .editor div')].find((e) => /^Libraries ·/.test(e.textContent.trim()) && e.querySelector('button'));
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === label).click();
  }, to);
  await toggleLibraries('Show');
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    for (const l of window.__map.getStyle().layers) if (/^(zones|stations)-/.test(l.id)) window.__map.setLayoutProperty(l.id, 'visibility', 'none');
  });
  await fitBoard(p, 40);
  const cells = await p.evaluate(() => window.__map.getStyle().layers.filter((l) => /cell|voronoi/i.test(l.id)).map((l) => l.id));
  await mustDraw(p, cells.slice(0, 1));
  await shoot(p, 'studio-zones');
  await p.evaluate(() => {
    for (const l of window.__map.getStyle().layers) if (/^(zones|stations)-/.test(l.id)) window.__map.setLayoutProperty(l.id, 'visibility', 'visible');
  });

  // Curating: every station on the board, with the ones Simplify would cut ringed.
  await click(p, '^Stations$', '.tabs button');
  await p.evaluate(() => {
    const s = [...document.querySelectorAll('.editor select')].find((x) => [...x.options].some((o) => o.value === 'half'));
    s.value = 'half';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(p, '^Find stations to remove$', '.editor button');
  await p.waitForTimeout(800);
  await fitBoard(p, 40);
  await mustDraw(p, ['zones-alive', 'stations-dot', 'picked-ring']);
  await p.evaluate(() => document.querySelector('.editor .notice')?.scrollIntoView({ block: 'center' }));
  await shoot(p, 'studio-curate');

  await ctx.close();
}

// ---------------------------------------------------------- the sample round
// One hider, one seeking team, every answer the true one. Worked out here from
// the board's own data, the way the engine's property test does it, and then
// checked on the stats page: if the real zone were ruled out, an answer here
// would be a lie, and the script stops.
const stations = JSON.parse(readFileSync(path.join(__dirname, '..', 'public', 'data', 'stations.json'), 'utf8')).stations;
const poi = (name) => JSON.parse(readFileSync(path.join(__dirname, '..', 'public', 'data', `poi-${name}.geojson`), 'utf8')).features;
const haversine = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};
const nearest = (at, features) => features
  .map((f) => ({ id: f.properties.id, m: haversine(at, f.geometry.coordinates) }))
  .reduce((a, b) => (b.m < a.m ? b : a));

const HIDER = stations.find((s) => s.id === '24thchurch');
const HIDER_AT = [HIDER.lon, HIDER.lat];
const truth = {
  radar: (from, m) => (haversine(from, HIDER_AT) <= m ? 'yes' : 'no'),
  match: (from, layer) => (nearest(from, poi(layer)).id === nearest(HIDER_AT, poi(layer)).id ? 'yes' : 'no'),
  measure: (from, layer) => (nearest(HIDER_AT, poi(layer)).m < nearest(from, poi(layer)).m ? 'closer' : 'further'),
  thermo: (from, to) => (haversine(to, HIDER_AT) < haversine(from, HIDER_AT) ? 'hotter' : 'colder'),
};

const CIVIC_CENTER = [SEEKER_AT.longitude, SEEKER_AT.latitude];
const MISSION_16TH = [-122.4197, 37.7650];
const MISSION_22ND = [-122.4190, 37.7553];
const MISSION_24TH = [-122.4185, 37.7520];

function sampleGameFile() {
  const start = Date.UTC(2026, 9, 24, 18, 0, 0);
  const min = 60000;
  const asks = [
    { id: 's1', questionId: 'radar-5000', askedAt: start + 6 * min, origin: CIVIC_CENTER, answer: { kind: 'yesno', value: truth.radar(CIVIC_CENTER, 5000) } },
    { id: 's2', questionId: 'match-park', askedAt: start + 17 * min, origin: CIVIC_CENTER, answer: { kind: 'yesno', value: truth.match(CIVIC_CENTER, 'parks') } },
    { id: 's3', questionId: 'thermo-1000', askedAt: start + 34 * min, origin: MISSION_16TH, destination: MISSION_22ND, answer: { kind: 'hotterColder', value: truth.thermo(MISSION_16TH, MISSION_22ND) } },
    { id: 's4', questionId: 'meas-library', askedAt: start + 46 * min, origin: MISSION_22ND, answer: { kind: 'closerFurther', value: truth.measure(MISSION_22ND, 'libraries') } },
    { id: 's5', questionId: 'radar-1000', askedAt: start + 58 * min, origin: MISSION_24TH, answer: { kind: 'yesno', value: truth.radar(MISSION_24TH, 1000) } },
    { id: 's6', questionId: 'match-hospital', askedAt: start + 69 * min, origin: MISSION_24TH, answer: { kind: 'yesno', value: truth.match(MISSION_24TH, 'hospitals') } },
  ];
  const round = { id: 'sample-round', role: 'seeker', label: 'Sample round', startedAt: start, endedAt: start + 81 * min, hiderStationId: HIDER.id, asks };
  return JSON.stringify({
    app: 'jetleg-sf', version: 1, exportedAt: start + 90 * min, role: 'seeker',
    settings: { gameSize: 'medium', strictness: 'strict', units: 'imperial', supervisorDistrictsAsAdmin4: false },
    rounds: [round],
  });
}

async function round(browser) {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  await admin.from('developers').upsert({ email: EMAIL, note: 'shot:marketing' });
  await admin.from('test_logins').upsert({ email: EMAIL, note: 'shot:marketing' });

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', serviceWorkers: 'block',
    geolocation: SEEKER_AT, permissions: ['geolocation'],
  });
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await p.goto(origin + '#/play', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await click(p, 'Start a new round');
  await p.waitForSelector('.accountbox input[type="email"]', { timeout: 10000 });
  await p.fill('.accountbox input[type="email"]', EMAIL);
  await click(p, 'I have a testing code');
  await p.fill('.accountbox input.code', TEST_CODE);
  await click(p, '^Sign in$');
  await p.waitForFunction(() => !/Unlock JetLeg/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 20000 });
  await click(p, 'Start a new round');
  await p.waitForSelector('.qrow', { timeout: 15000 });

  const answer = async (chip, row, button) => {
    await click(p, `^${chip}`, '.chip');
    await p.waitForTimeout(400);
    await p.evaluate(([r, b]) => {
      const el = [...document.querySelectorAll('.qrow')].find((x) => new RegExp(r).test(x.querySelector('.qlabel').textContent));
      el.querySelector('.qhead').click();
      return new Promise((done) => setTimeout(() => {
        [...el.querySelectorAll('button')].find((x) => x.textContent.trim().toLowerCase() === b).click();
        done();
      }, 300));
    }, [row, button]);
    await p.waitForTimeout(1500);
  };
  await answer('Radar', '^5 km', truth.radar(CIVIC_CENTER, 5000));
  await answer('Radar', '^2 km', truth.radar(CIVIC_CENTER, 2000));
  await answer('Matching', '^Park', truth.match(CIVIC_CENTER, 'parks'));
  const left = Number(await p.textContent('.topbar .count strong'));
  console.log('  zones left:', left);
  if (!(left > 5 && left < 150)) throw new Error(`expected a narrowed board, got ${left} zones`);

  await click(p, '^Matching', '.chip');
  await p.evaluate(() => document.querySelector('.sheet')?.scrollTo(0, 0));
  await settle(p);
  await mustDraw(p, ['zones-alive']);
  await shoot(p, 'game-seeker');

  await click(p, '^Log \\(');
  await p.waitForTimeout(600);
  // The log's clock reads seconds apart — a scripted round — so it is kept, not shown on the site.
  await shoot(p, 'game-log', false);
  await ctx.close();
}

async function stats(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const file = path.join(kept, 'sample-round.jetleg.json');
  writeFileSync(file, sampleGameFile());
  await p.goto(origin + '#/stats', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.page-body h2');
  await p.setInputFiles('.page-body input[type=file]', file);
  await p.waitForSelector('.openedfile');
  await click(p, 'Sample round', '.openedfile button');
  await p.waitForSelector('.qcards .qcard');
  await p.waitForTimeout(800);
  const said = await text(p, '.page-body');
  if (/Ruled out the real zone/.test(said)) throw new Error('an answer in the sample round ruled out the hider’s own zone; it is not truthful');
  if (!said.includes(HIDER.name)) throw new Error('the stats page does not name the hider’s station');
  await p.evaluate(() => {
    document.querySelector('.resultstats').scrollIntoView({ block: 'start' });
    document.querySelector('.page').scrollBy(0, -(document.querySelector('.page .topbar').offsetHeight + 12));
  });
  await shoot(p, 'stats-round');
  await p.addStyleTag({ content: '.page{height:auto!important;overflow:visible!important}' });
  await p.screenshot({ path: path.join(kept, 'stats-round-full.png'), fullPage: true });
  await ctx.close();
}

(async () => {
  if (!TEST_CODE) throw new Error('No testing code (supabase/functions/.env): a round cannot start without a pass.');
  mkdirSync(site, { recursive: true });
  mkdirSync(kept, { recursive: true });
  console.log('target:', origin);
  const browser = await chromium.launch();
  try {
    await studio(browser);
    await round(browser);
    await stats(browser);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('shot:marketing failed:', e.message ?? e); process.exit(1); });
