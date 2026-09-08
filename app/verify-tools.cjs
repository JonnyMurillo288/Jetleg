// Verification for the measuring toolbar and the plan layer.
// Asserts what MapLibre actually drew, not what the app thinks it drew.
const { chromium } = require('playwright');

const click = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
  return true;
}, [text, sel]);

const drawn = p => p.evaluate(() => {
  const m = window.__map;
  const q = id => { try { return m.queryRenderedFeatures({ layers: [id] }).length; } catch { return -1; } };
  return {
    styleLoaded: m.isStyleLoaded(),
    zones: q('zones-alive'), stations: q('stations-dot'),
    measureLine: q('measure-line'), measureDraft: q('measure-draft'),
    measureVertex: q('measure-vertex'), measureLabel: q('measure-label'),
    measureSegLabel: q('measure-seg-label'),
    planLine: q('plan-line'), planLabel: q('plan-label'),
    total: m.queryRenderedFeatures().length,
  };
});

// Poll rather than sleep: the number that matters is how long a drawing takes
// to appear on a throttled phone, and a fixed wait either hides that or fails
// for the wrong reason.
const waitDrawn = async (p, ids, ms = 8000) => {
  const t0 = Date.now();
  const want = Array.isArray(ids) ? ids : [ids];
  try {
    await p.waitForFunction(
      (layers) => layers.every(([layer, min]) => {
        try { return window.__map.queryRenderedFeatures({ layers: [layer] }).length >= min; } catch { return false; }
      }),
      want.map(w => (Array.isArray(w) ? w : [w, 1])),
      { timeout: ms, polling: 100 },
    );
    return Date.now() - t0;
  } catch { return -1; }
};

/** Wait for a layer to go empty — the only honest signal that a redraw landed. */
const waitCleared = async (p, id, ms = 8000) => {
  const t0 = Date.now();
  try {
    await p.waitForFunction(
      (layer) => { try { return window.__map.queryRenderedFeatures({ layers: [layer] }).length === 0; } catch { return false; } },
      id, { timeout: ms, polling: 100 },
    );
    return Date.now() - t0;
  } catch { return -1; }
};

/**
 * Click a point on the map, addressed as a fraction of the visible canvas.
 *
 * Fixed pixel coordinates are wrong here: the sheet grows when a round starts,
 * so the same y that was map before the round is panel after it, and the click
 * silently does nothing.
 */
const clickMap = async (p, fx, fy) => {
  const r = await p.evaluate(() => {
    const b = document.querySelector('.map canvas').getBoundingClientRect();
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: Math.min(b.height, sheet.top - b.y) };
  });
  await p.mouse.click(r.x + r.w * fx, r.y + r.h * fy);
  return r;
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

  // Throttle the CPU for the whole run: a phone is not a laptop, and the two
  // freezes this project has shipped were both invisible at full speed.
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // Point at any deployment: `TARGET=https://jetleg-sf.pages.dev npm run verify:tools`
  const target = process.env.TARGET || 'http://127.0.0.1:4310/';
  console.log('target:', target, '\n');
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await p.waitForTimeout(4000);

  const base = await drawn(p);
  check('baseline map renders', base.styleLoaded && base.zones > 0 && base.stations > 0, JSON.stringify(base));

  await click(p, 'Start a new round');
  await p.waitForTimeout(1500);

  // ---------------------------------------------------------------- measure
  let t = Date.now();
  await click(p, '^Measure', '.maptools-row button');
  await p.waitForTimeout(300);
  check('measure panel opens', await p.$('.maplayers-panel.measure') !== null, `${Date.now() - t} ms`);

  t = Date.now();
  await click(p, '^Circle$', '.maplayers-panel.measure .seg button');
  await p.waitForTimeout(200);
  const armed = await p.$('.toolhint') !== null;
  check('circle tool arms and says so', armed, `${Date.now() - t} ms`);

  await clickMap(p, 0.72, 0.62);
  const circleMs = await waitDrawn(p, ['measure-line', 'measure-label']);
  let d = await drawn(p);
  check('circle drawn on the map', circleMs >= 0 && d.measureLabel > 0, `${circleMs} ms at 4x throttle  ${JSON.stringify({ line: d.measureLine, label: d.measureLabel })}`);
  // Arming closes the panel, so reopen it to read the shape list.
  const openMeasure = async () => {
    if (!(await p.$('.maplayers-panel.measure'))) await click(p, '^Measure', '.maptools-row button');
    await p.waitForTimeout(400);
  };
  await openMeasure();
  check('circle counts zones inside', /\d+\/\d+ zones/.test(await p.textContent('.list.measures') || ''), (await p.textContent('.list.measures li') || '').trim());

  // A second circle at a different radius.
  await click(p, '^1 km$|^1 mi$', '.maplayers-panel.measure .chip');
  await click(p, '^Measure', '.maptools-row button'); // close the panel again
  await p.waitForTimeout(300);
  await clickMap(p, 0.42, 0.72);
  await p.waitForTimeout(1500);
  await openMeasure();
  check('second circle drawn', (await p.$$('.list.measures li')).length === 2,
    JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.list.measures li')].map(li => li.textContent.trim()))));

  // ---- line tool
  t = Date.now();
  await click(p, '^Line$', '.maplayers-panel.measure .seg button');
  await p.waitForTimeout(300);
  check('arming a tool clears the panel off the map', await p.$('.maplayers-panel.measure') === null);
  await clickMap(p, 0.6, 0.4);
  await p.waitForTimeout(400);
  await clickMap(p, 0.8, 0.7);
  const draftMs = await waitDrawn(p, 'measure-draft');
  d = await drawn(p);
  check('draft line renders while being drawn', d.measureDraft > 0 && d.measureVertex > 0, `${draftMs} ms  ${JSON.stringify({ draft: d.measureDraft, vertex: d.measureVertex })}`);

  await clickMap(p, 0.45, 0.88);
  await p.waitForTimeout(600);
  const hint = (await p.textContent('.toolhint') || '').trim();
  check('hint tracks the points placed', /3 points/.test(hint), hint);
  await click(p, '^Finish$', '.toolhint button');
  // The draft and the committed line draw identically, so the only thing that
  // proves the commit reached the map is the draft layer emptying.
  const segMs = await waitCleared(p, 'measure-draft');
  d = await drawn(p);
  check('committed line replaces the draft on the map', segMs >= 0 && d.measureSegLabel > 0,
    `${segMs} ms  ${JSON.stringify({ seg: d.measureSegLabel, draft: d.measureDraft })}`);
  await openMeasure();
  const lineRow = await p.evaluate(() => [...document.querySelectorAll('.list.measures li')].map(li => li.textContent.trim()));
  check('line length reported in the panel', lineRow.some(r => /3 pts · [\d.]+ (mi|km|ft|m)/.test(r)), JSON.stringify(lineRow));
  await p.screenshot({ path: '/tmp/tools-measure.png' });

  // Turning the tool off must hand taps back to the game.
  await click(p, '^Done$', '.toolhint button');
  await p.waitForTimeout(300);
  check('tool disarms', await p.$('.toolhint') === null);

  // Shapes survive a reload — an all-day game reloads.
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await waitDrawn(p, 'measure-line');
  d = await drawn(p);
  check('drawing survives a reload', d.measureLine > 0 && d.measureSegLabel > 0, JSON.stringify({ line: d.measureLine, seg: d.measureSegLabel }));

  // ------------------------------------------------------------------- plan
  const addToPlan = async (label) => {
    await p.evaluate((l) => {
      const row = [...document.querySelectorAll('.qrow')].find(r => new RegExp('^' + l).test(r.querySelector('.qlabel').textContent));
      if (!row) throw new Error('no question row ' + l);
      row.querySelector('.qhead').click();
    }, label);
    await p.waitForTimeout(400);
    await p.evaluate((l) => {
      const row = [...document.querySelectorAll('.qrow')].find(r => new RegExp('^' + l).test(r.querySelector('.qlabel').textContent));
      row.querySelector('.planbtn').click();
    }, label);
    await p.waitForTimeout(300);
  };

  t = Date.now();
  await addToPlan('1 km');
  await addToPlan('2 km');
  await addToPlan('5 km');
  check('three questions shortlisted', (await p.$$('.qrow.planned')).length === 3, `${Date.now() - t} ms`);

  await addToPlan('10 km');
  const planned = await p.evaluate(() => [...document.querySelectorAll('.qrow.planned .qlabel')].map(e => e.textContent.replace('plan', '').trim()));
  check('shortlist caps at three, oldest drops', planned.length === 3 && !planned.includes('1 km'), JSON.stringify(planned));

  t = Date.now();
  await click(p, '^Plan', '.seg.wide button');
  await p.waitForTimeout(1500);
  const cards = await p.$$('.plancard');
  check('plan panel lists the candidates', cards.length === 3, `${cards.length} cards, ${Date.now() - t} ms`);

  const planMs = await waitDrawn(p, 'plan-line');
  d = await drawn(p);
  check('candidate regions drawn on the map', planMs >= 0, `${planMs} ms  ${JSON.stringify({ planLine: d.planLine, planLabel: d.planLabel })}`);

  const cardText = await p.evaluate(() => [...document.querySelectorAll('.plancard')].map(c => c.textContent.replace(/\s+/g, ' ').trim()));
  check('each card reports a worst case', cardText.every(c => /zones left at worst/.test(c)), JSON.stringify(cardText.map(c => c.slice(0, 90))));
  check('exactly one is marked sharpest', cardText.filter(c => /sharpest/.test(c)).length === 1);
  check('a candidate that cannot split is flagged', cardText.filter(c => /no split/.test(c)).length === 1,
    JSON.stringify(cardText.filter(c => /no split/.test(c)).map(c => c.slice(0, 60))));
  await p.screenshot({ path: '/tmp/tools-plan.png' });

  // Turning the plan off must clear the map, not just the checkbox.
  await p.evaluate(() => [...document.querySelectorAll('.panel label input[type=checkbox]')][0].click());
  await p.waitForTimeout(1000);
  d = await drawn(p);
  check('hiding the plan clears its regions', d.planLine === 0, JSON.stringify({ planLine: d.planLine }));
  await p.evaluate(() => [...document.querySelectorAll('.panel label input[type=checkbox]')][0].click());
  check('showing it again brings them back', (await waitDrawn(p, 'plan-line')) >= 0);

  // "Ask this" must land on the question it names.
  t = Date.now();
  await click(p, '^Ask this$', '.plancard button');
  await p.waitForTimeout(800);
  const openRow = await p.evaluate(() => document.querySelector('.qrow .qbody')?.closest('.qrow')?.querySelector('.qlabel')?.textContent.replace('plan', '').trim());
  check('“Ask this” opens that question', /^2 km|^5 km|^10 km/.test(openRow || ''), `${openRow}  ${Date.now() - t} ms`);

  // Answering a shortlisted question must not disturb the plan.
  await p.evaluate(() => {
    const row = document.querySelector('.qrow .qbody').closest('.qrow');
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes').click();
  });
  await p.waitForTimeout(3500);
  d = await drawn(p);
  const count = await p.textContent('.count');
  check('answering still eliminates, with the plan up', d.zones > 0 && d.planLine > 0, `${count.trim()} ${JSON.stringify({ zones: d.zones, planLine: d.planLine })}`);

  console.log('\nconsole errors:', errors.length ? errors.slice(0, 6) : 'none');
  await b.close();
  if (fail.length || errors.length) { console.log('\nFAILURES:', fail.join(', ') || '(console errors only)'); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1); });
