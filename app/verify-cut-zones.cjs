// Verification for loose elimination (engine/candidates.ts `cutZone`): with
// "Rule zones out by: Loose", every zone an answer crosses is drawn cut down
// to what the answer leaves, and Strict draws whole circles. Asks the map what
// it holds and what it drew — the panel's numbers prove nothing about that.
//
// A pass goes in the device's cache and a round arrives as a game file, the
// way verify-resume.cjs does it. Needs a built app on :4310; no backend.
const { chromium } = require('playwright');
const { writeFileSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};
const clickText = (p, re, sel) => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t).test(e.textContent || ''));
  if (!el) throw new Error(`no ${s} matching ${t}`);
  el.click();
}, [re, sel]);

const CIVIC = [-122.4194, 37.7793];
const RADIUS = 2000;
const metres = ([a, b], [c, d]) => {
  const R = 6371008.8, r = Math.PI / 180;
  const x = (c - a) * r * Math.cos(((b + d) / 2) * r), y = (d - b) * r;
  return Math.hypot(x, y) * R;
};
const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8')).stations;
const straddlers = stations.filter((s) => Math.abs(metres(CIVIC, [s.lon, s.lat]) - RADIUS) < 500).map((s) => s.id);

/** What the zones source holds and what MapLibre drew of it. */
const zones = (p) => p.evaluate(() => {
  const fs = window.__map.getSource('zones').serialize().data.features;
  const drawn = window.__map.queryRenderedFeatures({ layers: ['zones-alive'] });
  return {
    alive: fs.filter((f) => f.properties.alive).length,
    cut: fs.filter((f) => f.properties.alive && f.properties.cut).map((f) => ({ id: f.properties.id, geom: f.geometry })),
    drawnCut: new Set(drawn.filter((f) => f.properties.cut).map((f) => f.properties.id)).size,
    drawn: drawn.length,
    counter: document.querySelector('.topbar .count')?.textContent.replace(/\s/g, ''),
  };
});
const setRule = async (p, label) => {
  await clickText(p, '^Map$', '.topbar button');
  await p.waitForSelector('.setting');
  await clickText(p, `^${label}$`, '.setting button');
  await clickText(p, '^Play$', '.topbar button');
  await p.waitForTimeout(1500);
};

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jetleg-cuts-'));
  const browser = await chromium.launch();
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

  const start = Date.now() - 3600_000;
  const file = path.join(dir, 'round.json');
  writeFileSync(file, JSON.stringify({ app: 'jetleg-sf', version: 1, exportedAt: Date.now(), role: 'seeker', settings: {}, rounds: [{
    id: `cuts-${Date.now()}`, role: 'seeker', label: 'Cut zones round', startedAt: start,
    asks: [{ id: 'cuts-a1', questionId: 'radar-2000', askedAt: start + 60_000, origin: CIVIC, answer: { kind: 'yesno', value: 'yes' } }],
  }] }));
  await p.goto(origin + '#/stats');
  await p.waitForSelector('.page-body input[type=file]', { state: 'attached' });
  await p.setInputFiles('.page-body input[type=file]', file);
  await p.waitForSelector('.openedfile');
  await clickText(p, 'Keep these rounds on this device', '.openedfile button');
  await p.waitForFunction(() => /Added to this device/.test(document.querySelector('.openedfile')?.textContent || ''), null, { timeout: 5000 });

  await p.goto(origin + '#/play');
  await p.reload();
  await p.waitForFunction(() => window.__mapReady === true && window.__map?.isStyleLoaded(), null, { timeout: 45000 });
  await p.waitForSelector('.sheet .list li', { timeout: 20000 });
  await p.evaluate(() => {
    const li = [...document.querySelectorAll('.sheet .list li')].find((l) => /Cut zones round/.test(l.textContent));
    [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Resume').click();
  });
  await p.waitForSelector('.qrow', { timeout: 15000 });
  await p.evaluate(() => window.__map.jumpTo({ center: [-122.4194, 37.7793], zoom: 12.3 }));

  await setRule(p, 'Loose');
  const loose = await zones(p);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
  const outside = loose.cut.flatMap((c) => (c.geom.type === 'Polygon' ? [c.geom.coordinates[0]] : c.geom.coordinates.map((x) => x[0])))
    .flat().filter((pt) => metres(CIVIC, pt) > RADIUS + 15).length;
  check('loose: zones the radar crosses are drawn cut', loose.cut.length > 0 && loose.cut.every((c) => straddlers.includes(c.id)), { cut: loose.cut.length, straddlers: straddlers.length });
  check('...to the part inside the radar only', outside === 0, { pointsOutside: outside });
  check('...and MapLibre drew them', loose.drawnCut > 0 && loose.drawn > 0, { drawnCut: loose.drawnCut, drawn: loose.drawn });
  check('the counter agrees with the zones drawn alive', loose.counter?.startsWith(`${loose.alive}/`), { counter: loose.counter, alive: loose.alive });

  await setRule(p, 'Strict');
  const strict = await zones(p);
  check('strict: whole circles, nothing cut', strict.cut.length === 0 && strict.drawnCut === 0, { cut: strict.cut.length });
  check('strict narrows at least as far as loose', strict.alive <= loose.alive && strict.counter?.startsWith(`${strict.alive}/`), { strict: strict.alive, loose: loose.alive });
  await clickText(p, '^Map$', '.topbar button');
  await p.waitForSelector('.setting');
  check('the setting is called Strict / Loose', /Rule zones out by/.test(await p.textContent('.sheet')) && await p.evaluate(() => ['Strict', 'Loose'].every((t) => [...document.querySelectorAll('.setting button')].some((b) => b.textContent === t))));

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('verify:cuts crashed:', e); process.exit(1); });
