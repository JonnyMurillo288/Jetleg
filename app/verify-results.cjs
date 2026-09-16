// Verification for the Results tab (ui/ResultsPanel.tsx). Plays a real round
// through the same UI a player uses, ends it, then checks the results list
// and detail view against what was actually asked — not just that the tab
// opens without throwing.
const { chromium } = require('playwright');

const click = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
  return true;
}, [text, sel]);

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
  await p.waitForTimeout(3000);

  // Empty state, before any round has ever ended.
  await click(p, '^Results$');
  await p.waitForTimeout(400);
  const empty = await p.textContent('.pad');
  check('empty state explains there are no results yet', /No finished rounds yet/.test(empty || ''), empty?.trim());
  await p.screenshot({ path: '/tmp/results-empty.png' });

  // Play a short real round: one radar YES, one matching NO.
  await click(p, '^Play$');
  await p.waitForTimeout(300);
  await click(p, 'Start a new round');
  await p.waitForTimeout(1500);

  await click(p, '^2 km', '.qrow .qhead');
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^2 km/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes').click();
  });
  await p.waitForTimeout(2000);

  await click(p, '^Matching', '.chip');
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Park/.test(r.querySelector('.qlabel').textContent));
    row.querySelector('.qhead').click();
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.qrow')].find(r => /^Park/.test(r.querySelector('.qlabel').textContent));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'No').click();
  });
  await p.waitForTimeout(2500);

  await click(p, '^Log \\(');
  await p.waitForTimeout(800);
  await click(p, '^End this round$');
  await p.waitForTimeout(500);

  // Results list should now show exactly this one finished round.
  await click(p, '^Results$');
  await p.waitForTimeout(500);
  const listText = await p.textContent('.list.results');
  check('finished round appears in the results list', /Seeking/.test(listText || '') && /2 questions/.test(listText || ''), listText?.trim());
  await p.screenshot({ path: '/tmp/results-list.png' });

  await click(p, 'Seeking round 1');
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/results-detail.png' });

  const stats = await p.evaluate(() =>
    [...document.querySelectorAll('.resultstats .stat')].map(s => ({
      value: s.querySelector('strong')?.textContent.trim(),
      label: s.querySelector('.muted')?.textContent.trim(),
      width: s.getBoundingClientRect().width,
    })),
  );
  check('stat tiles rendered with real width, not collapsed', stats.length >= 2 && stats.every(s => s.width > 20), JSON.stringify(stats));

  const zonesStat = stats.find(s => /zones still possible/.test(s.label || ''));
  const total = Number((zonesStat?.label || '').match(/of (\d+)/)?.[1] ?? NaN);
  const left = Number(zonesStat?.value ?? NaN);
  check('zone count is a real, narrowed number', Number.isFinite(left) && Number.isFinite(total) && left > 0 && left < total, `${left} of ${total}`);

  const questionStat = stats.find(s => /question/.test(s.label || ''));
  check('question count matches what was actually asked', questionStat?.value === '2', questionStat);

  const logText = await p.textContent('.list.log');
  check('detail log shows the radar answer', /2 km/.test(logText || '') && /YES/.test(logText || ''), undefined);
  check('detail log shows the matching answer', /Park/.test(logText || '') && /NO/.test(logText || ''), undefined);

  await click(p, 'Back to results', 'button');
  await p.waitForTimeout(300);
  const backAtList = await p.$('.list.results');
  check('back button returns to the list', backAtList !== null);

  check('no console/page errors the whole run', errors.length === 0, errors.slice(0, 5));

  await b.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch(e => { console.error('verify:results crashed:', e); process.exit(1); });
