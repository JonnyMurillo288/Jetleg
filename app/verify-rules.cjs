// Verification for the four Map/UX rules changes:
//   1. zones are ruled out by the station in the middle, not the whole circle
//   2. the hider's radar shows the distance to the seekers
//   3. the matching overlay is the same polygon the Voronoi layer draws
//   4. the hider can place the seekers' thermometer run and answer it
const { chromium } = require('playwright');

const click = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
  return true;
}, [text, sel]);

const openRow = async (p, label) => {
  await p.evaluate(l => {
    const row = [...document.querySelectorAll('.qrow')].find(r => new RegExp('^' + l).test(r.querySelector('.qlabel').textContent));
    if (!row) throw new Error('no question row ' + l);
    row.querySelector('.qhead').click();
  }, label);
  await p.waitForTimeout(500);
};

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
  if (!ok) fail.push(name);
};

const clickMap = async (p, fx, fy) => {
  const r = await p.evaluate(() => {
    const b = document.querySelector('.map canvas').getBoundingClientRect();
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: Math.min(b.height, sheet.top - b.y) };
  });
  await p.mouse.click(r.x + r.w * fx, r.y + r.h * fy);
  await p.waitForTimeout(700);
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    const fix = { coords: { latitude: 37.7793, longitude: -122.4194, accuracy: 18 }, timestamp: Date.now() };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: cb => setTimeout(() => cb(fix), 50), watchPosition: cb => { setTimeout(() => cb(fix), 50); return 1; }, clearWatch: () => {} },
    });
  });
  const errors = [];
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

  const target = process.env.TARGET || 'http://127.0.0.1:4310/';
  console.log('target:', target, '\n');
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await p.waitForTimeout(3500);

  // ---------------------------------------------- 1. rule out by zone centre
  const setting = await p.evaluate(() => {
    const raw = document.querySelector('.count')?.textContent;
    return raw;
  });
  await click(p, '^Map$', '.topbar button');
  await p.waitForTimeout(800);
  const ruleLabel = await p.evaluate(() => {
    const l = [...document.querySelectorAll('.setting')].find(e => /Rule zones out by/.test(e.textContent));
    return l ? { on: l.querySelector('.seg button.on')?.textContent.trim(), text: l.textContent.replace(/\s+/g, ' ').slice(0, 130) } : null;
  });
  check('default is “Zone centre”', ruleLabel?.on === 'Zone centre', JSON.stringify(ruleLabel));

  await click(p, '^Play$', '.topbar button');
  await p.waitForTimeout(600);
  await click(p, 'Start a new round');
  await p.waitForTimeout(1500);

  // The visible symptom: the Ask list's split must equal what answering leaves.
  const before = await p.evaluate(() => document.querySelector('.count').textContent.trim());
  const split = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^1 mi/.test(r.querySelector('.qlabel').textContent));
    return row.querySelector('.qsplit').textContent.trim();
  });
  await openRow(p, '1 mi');
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^1 mi/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes').click();
  });
  await p.waitForTimeout(2500);
  const after = await p.evaluate(() => document.querySelector('.count').textContent.trim());
  const predicted = split.split('/')[0].trim();
  check('the previewed split is what answering actually leaves',
    after.split('/')[0].trim() === predicted, `preview ${split} → ${before} became ${after}`);

  // ------------------------------------- 3. matching overlay == voronoi cell
  await click(p, '^Matching', '.chip');
  await p.waitForTimeout(1200);
  await openRow(p, 'Museum');
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Museum/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'No').click();
  });
  await p.waitForTimeout(3000);

  // A "no" draws the yes-region as the excluded overlay. That polygon must be
  // the very cell the museums Voronoi layer draws, not a lookalike.
  const parity = await p.evaluate(async () => {
    const m = window.__map;
    // serialize() is the reliable read; `_data` is not updated by setData here.
    const overlay = m.getSource('overlays').serialize().data;
    if (!overlay?.features?.length) return { error: 'overlays source is empty', keys: Object.keys(overlay ?? {}) };
    const ov = overlay.features[overlay.features.length - 1];
    const res = await fetch('data/voronoi-museums.geojson');
    const cells = await res.json();
    const same = cells.features.find(f => JSON.stringify(f.geometry) === JSON.stringify(ov.geometry));
    return { overlayRings: JSON.stringify(ov.geometry).length, matchedCell: same?.properties?.name ?? null };
  });
  check('the matching overlay is a Voronoi cell, vertex for vertex',
    parity.matchedCell !== null, JSON.stringify(parity));

  // ------------------------------------------------ 2. hider radar distance
  await click(p, '^Hider$', '.topbar button');
  await p.waitForTimeout(1200);
  await click(p, 'Start a new round');
  await p.waitForTimeout(1500);
  await click(p, '^Radar$', '.chip');
  await p.waitForTimeout(800);
  const noPin = await p.evaluate(() => document.querySelector('.panel')?.textContent ?? '');
  check('radar prompts for the seekers’ pin when there is none',
    /Drop the seekers.{0,3} pin to see how far/.test(noPin));

  await click(p, '^Set pin$', '.seekerpin button');
  await p.waitForTimeout(400);
  await clickMap(p, 0.30, 0.30);
  await p.waitForTimeout(1200);
  const readout = await p.evaluate(() => {
    const el = [...document.querySelectorAll('.hint.fact')].find(e => /seekers are/i.test(e.textContent));
    return el?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  });
  check('radar shows the distance to the seekers', /The seekers are [\d.]+ (mi|ft|km|m) away/.test(readout || ''), readout);

  await openRow(p, '1 mi');
  const radarAnswer = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^1 mi/.test(r.querySelector('.qlabel').textContent));
    return row.querySelector('.hint')?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  });
  check('radar states the truthful answer outright', /so the answer is (YES|NO)/.test(radarAnswer || ''), radarAnswer);

  // -------------------------------------------- 4. hider thermometer run
  await click(p, '^Thermometer$', '.chip');
  await p.waitForTimeout(800);
  check('thermometer asks for the run first',
    /Place where the seekers started/.test(await p.evaluate(() => document.querySelector('.thermo')?.textContent ?? '')));

  await click(p, '^Set start$', '.thermo button');
  await p.waitForTimeout(300);
  await clickMap(p, 0.35, 0.35);
  await click(p, '^Set end$', '.thermo button');
  await p.waitForTimeout(300);
  await clickMap(p, 0.65, 0.65);
  const travelled = await p.evaluate(() => document.querySelector('.thermo')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
  check('the run reports its length', /They travelled [\d.]+ (mi|ft|km|m)/.test(travelled), travelled);

  const drawnRun = await p.evaluate(() => {
    const m = window.__map;
    const q = id => { try { return m.queryRenderedFeatures({ layers: [id] }).length; } catch { return -1; } };
    return { seg: q('measure-seg-label'), line: q('measure-line'), pins: q('pins') };
  });
  check('the run is drawn and labelled like a measurement',
    drawnRun.seg > 0 && drawnRun.line > 0 && drawnRun.pins >= 3, JSON.stringify(drawnRun));

  await openRow(p, '0.5 mi');
  const zonesBefore = await p.evaluate(() => document.querySelector('.count').textContent.trim());
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^0.5 mi/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Colder').click();
  });
  await p.waitForTimeout(3000);
  const zonesAfter = await p.evaluate(() => document.querySelector('.count').textContent.trim());
  const thermoDrawn = await p.evaluate(() => {
    try { return window.__map.queryRenderedFeatures({ layers: ['outofplay-fill'] }).length; } catch { return -1; }
  });
  check('answering hotter/colder cuts the board along the perpendicular',
    zonesAfter !== zonesBefore && thermoDrawn > 0, `${zonesBefore} → ${zonesAfter}, outofplay ${thermoDrawn}`);
  await p.screenshot({ path: '/tmp/rules-hider.png' });

  console.log('\nconsole errors:', errors.length ? errors.slice(0, 6) : 'none');
  await b.close();
  if (fail.length || errors.length) { console.log('\nFAILURES:', fail.join(', ') || '(console errors only)'); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1); });
