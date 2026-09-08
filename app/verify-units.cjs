// Every distance the app computes must follow one setting.
//
// The strongest check available: put the app in metric and assert that no
// imperial unit appears anywhere on screen. That catches a hardcoded unit in a
// string nobody thought to look at, which is how the mixed readouts got there.
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

const clickMap = async (p, fx, fy) => {
  const r = await p.evaluate(() => {
    const b = document.querySelector('.map canvas').getBoundingClientRect();
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: Math.min(b.height, sheet.top - b.y) };
  });
  await p.mouse.click(r.x + r.w * fx, r.y + r.h * fy);
  await p.waitForTimeout(700);
};

const setUnits = async (p, label) => {
  await click(p, '^Map$', '.topbar button');
  await p.waitForTimeout(700);
  await p.evaluate((l) => {
    const row = [...document.querySelectorAll('.setting')].find(e => /^Distances/.test(e.textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === l).click();
  }, label);
  await p.waitForTimeout(500);
  await click(p, '^Play$', '.topbar button');
  await p.waitForTimeout(700);
};

/** Everything the player can read, minus the rulebook's own wording. */
const shownText = (p) => p.evaluate(() => {
  const clone = document.querySelector('.app').cloneNode(true);
  // Question text is the rulebook verbatim and is deliberately metric.
  clone.querySelectorAll('.qlabel, .qtext, .chip').forEach(e => e.remove());
  return clone.textContent.replace(/\s+/g, ' ');
});

/** Switching role drops the active round, so re-enter one before asking. */
const ensureRound = async (p) => {
  const gate = await p.evaluate(() =>
    !![...document.querySelectorAll('button')].find(b => /Start a new round/.test(b.textContent)));
  if (gate) { await click(p, 'Start a new round'); await p.waitForTimeout(1500); }
};

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
  if (!ok) fail.push(name);
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

  const settingButtons = await p.evaluate(async () => {
    [...document.querySelectorAll('.topbar button')].find(b => b.textContent.trim() === 'Map').click();
    await new Promise(r => setTimeout(r, 600));
    const row = [...document.querySelectorAll('.setting')].find(e => /^Distances/.test(e.textContent));
    return row ? [...row.querySelectorAll('button')].map(b => b.textContent.trim()).join(' / ') : null;
  });
  check('the setting exists in Map', !!settingButtons, settingButtons);

  await click(p, '^Play$', '.topbar button');
  await p.waitForTimeout(600);
  await click(p, 'Start a new round');
  await p.waitForTimeout(1500);

  // --- imperial: computed distances read in miles/feet
  await setUnits(p, 'Miles & feet');
  const gpsImp = await p.textContent('.gps');
  check('GPS accuracy is imperial', /±\d+(\.\d+)? (ft|mi)/.test(gpsImp), gpsImp.trim());

  // --- metric: nothing imperial may survive anywhere
  await setUnits(p, 'Km & metres');
  const gpsMet = await p.textContent('.gps');
  check('GPS accuracy is metric', /±\d+(\.\d+)? (m|km)\b/.test(gpsMet), gpsMet.trim());

  // Walk the surfaces that print distances, in metric, and sweep each.
  const sweeps = [];
  const sweep = async (where) => {
    const t = await shownText(p);
    const hits = t.match(/\d[\d.,]* ?(mi|ft)\b/g);
    sweeps.push({ where, hits: hits ? [...new Set(hits)] : [] });
  };

  await sweep('seeker ask list');
  await click(p, '^Measure', '.maptools-row button');
  await p.waitForTimeout(400);
  await click(p, '^Circle$', '.maplayers-panel.measure .seg button');
  await p.waitForTimeout(300);
  await clickMap(p, 0.7, 0.5);
  await click(p, '^Measure', '.maptools-row button');
  await p.waitForTimeout(500);
  await sweep('measure panel');
  await click(p, '^Done$', '.toolhint button');
  await p.waitForTimeout(300);

  await click(p, '^Thermometer', '.chip');
  await p.waitForTimeout(500);
  await sweep('seeker thermometer');

  await click(p, '^Hider$', '.topbar button');
  await p.waitForTimeout(1200);
  await ensureRound(p);
  await click(p, '^Set pin$', '.seekerpin button');
  await p.waitForTimeout(300);
  await clickMap(p, 0.3, 0.3);
  await click(p, '^Radar', '.chip');
  await p.waitForTimeout(600);
  await openRow(p, '2 km');
  await sweep('hider radar');

  await click(p, '^Thermometer', '.chip');
  await p.waitForTimeout(500);
  await click(p, '^Set start$', '.thermo button');
  await clickMap(p, 0.35, 0.35);
  await click(p, '^Set end$', '.thermo button');
  await clickMap(p, 0.65, 0.6);
  await sweep('hider thermometer');

  await click(p, '^Matching', '.chip');
  await p.waitForTimeout(500);
  await openRow(p, 'Library');
  await sweep('hider answer assistant');

  const dirty = sweeps.filter(s => s.hits.length);
  check('no imperial unit survives anywhere in metric mode',
    dirty.length === 0, dirty.length ? JSON.stringify(dirty) : sweeps.map(s => s.where).join(', '));

  // The rulebook's own numbers must NOT convert.
  await click(p, '^Radar', '.chip');
  await p.waitForTimeout(500);
  await setUnits(p, 'Miles & feet');
  await click(p, '^Hider$', '.topbar button');
  await p.waitForTimeout(800);
  await ensureRound(p);
  await click(p, '^Radar', '.chip');
  await p.waitForTimeout(600);
  const labels = await p.evaluate(() => [...document.querySelectorAll('.qlabel')].map(e => e.textContent.trim()));
  check('question text stays as the rulebook prints it',
    labels.includes('2 km') && labels.includes('500 m'), JSON.stringify(labels.slice(0, 5)));

  // --- radar "Choose" carries its radius
  await click(p, '^Seeker$', '.topbar button');
  await p.waitForTimeout(1200);
  await ensureRound(p);
  const before = await p.evaluate(() => document.querySelector('.count').textContent.trim());
  await click(p, '^Radar', '.chip');
  await p.waitForTimeout(600);
  await openRow(p, 'Choose');
  const unit = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Choose/.test(r.querySelector('.qlabel').textContent));
    return row.querySelector('.qbody label')?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  });
  check('the chosen radius is typed in the player’s own unit', /ft$/.test(unit || ''), unit);

  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Choose/.test(r.querySelector('.qlabel').textContent));
    const input = row.querySelector('input[type=number]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '5000'); // 5000 ft
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Choose/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes').click();
  });
  await p.waitForTimeout(2500);
  const after = await p.evaluate(() => document.querySelector('.count').textContent.trim());
  const drawn = await p.evaluate(() => {
    try { return window.__map.queryRenderedFeatures({ layers: ['outofplay-fill'] }).length; } catch { return -1; }
  });
  check('radar “Choose” actually constrains the board',
    after !== before && drawn > 0, `${before} → ${after}, outofplay ${drawn}`);
  await p.screenshot({ path: '/tmp/units.png' });

  console.log('\nconsole errors:', errors.length ? errors.slice(0, 6) : 'none');
  await b.close();
  if (fail.length || errors.length) { console.log('\nFAILURES:', fail.join(', ') || '(console errors only)'); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1); });
