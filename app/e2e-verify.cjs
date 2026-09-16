const { chromium } = require('playwright');

// Drive the app with in-page DOM clicks. Playwright's actionability checks were
// hanging against MapLibre's continuous rAF loop; the app logic is what matters
// here, so dispatch directly and assert on rendered state.
const click = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t);
  el.click();
  return true;
}, [text, sel]);

const state = p => p.evaluate(() => ({
  count: document.querySelector('.count')?.textContent?.trim(),
  canvases: document.querySelectorAll('.map canvas').length,
  chips: [...document.querySelectorAll('.chip')].map(c => c.textContent.trim().split(' ')[0]),
  questions: document.querySelectorAll('.qrow').length,
  dead: document.querySelectorAll('.qrow.dead').length,
  logRows: document.querySelectorAll('.log li').length,
}));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({
    viewport: { width: 414, height: 896 }, deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  const p = await ctx.newPage();

  // Stub geolocation directly. Playwright's own geolocation emulation stalls
  // watchPosition in this headless build; the app only needs a plausible fix.
  await p.addInitScript(() => {
    const fix = { coords: { latitude: 37.7793, longitude: -122.4194, accuracy: 18 }, timestamp: Date.now() };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (cb) => setTimeout(() => cb(fix), 50),
        watchPosition: (cb) => { setTimeout(() => cb(fix), 50); return 1; },
        clearWatch: () => {},
      },
    });
  });
  const errors = [];
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });

  await p.goto('http://127.0.0.1:4310/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('.count'), null, { timeout: 30000 });
  await p.waitForTimeout(3500);
  console.log('1 loaded          ', JSON.stringify(await state(p)));
  await p.screenshot({ path: '/tmp/s1-start.png' });

  await click(p, 'Start a new round');
  await p.waitForTimeout(2000);
  console.log('2 round started   ', JSON.stringify(await state(p)));
  await p.screenshot({ path: '/tmp/s2-round.png' });

  // Open the 1 mi radar row (radar-2000 in imperial mode) and answer YES.
  await click(p, '^1 mi', '.qrow .qhead');
  await p.waitForTimeout(600);
  await p.screenshot({ path: '/tmp/s3-question.png' });
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^1 mi/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes').click();
  });
  await p.waitForTimeout(3000);
  console.log('3 radar 1mi YES   ', JSON.stringify(await state(p)));
  await p.screenshot({ path: '/tmp/s4-eliminated.png' });

  // Matching -> Park -> NO (draws a shaded exclusion overlay).
  await click(p, '^Matching', '.chip');
  await p.waitForTimeout(1500);
  const audit = await p.evaluate(() => [...document.querySelectorAll('.qrow')].map(r => ({
    label: r.querySelector('.qlabel').textContent.trim(),
    dead: r.classList.contains('dead'), weak: r.classList.contains('weak'),
    split: r.querySelector('.qsplit')?.textContent.trim(),
  })));
  console.log('4 matching audit:');
  for (const a of audit) console.log('     ', (a.dead?'NULL   ':a.weak?'NOSPLIT':'ok     '), a.label.padEnd(34), a.split);
  await p.screenshot({ path: '/tmp/s5-matching.png' });

  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Park/.test(r.querySelector('.qlabel').textContent));
    row.querySelector('.qhead').click();
  });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Park/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'No').click();
  });
  await p.waitForTimeout(3500);
  console.log('5 park NO         ', JSON.stringify(await state(p)));
  await p.screenshot({ path: '/tmp/s6-overlay.png' });

  await click(p, '^Log \\(');
  await p.waitForTimeout(1200);
  console.log('6 log             ', JSON.stringify(await state(p)));
  await p.screenshot({ path: '/tmp/s7-log.png' });

  await click(p, '^Hider$');
  await p.waitForTimeout(1500);
  await click(p, 'Start a new round');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/s8-hider.png' });
  console.log('7 hider mode      ', JSON.stringify(await state(p)));

  await click(p, '^Map$');
  await p.waitForTimeout(1000);
  await p.screenshot({ path: '/tmp/s9-layers.png' });

  console.log('errors:', errors.length ? errors.slice(0, 6) : 'none');
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
