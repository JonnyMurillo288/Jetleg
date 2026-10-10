// Verification for community maps, through the UI. Two real browsers:
//
//   ana — signs in with an emailed code, draws a map on the real map, publishes it
//   ben — browses it as a guest, plays on it, then signs in to like, comment and branch
//
// verify-community.ts proves the database's rules. This proves the app:
// that the editor's taps become stations, that choosing a map really swaps
// what the map draws, and that it is still there after a reload.
//
// Needs `supabase start` (its mail catcher on :54324 supplies the codes) and
// a built app on :4310 (`npm run build && npx vite preview --port 4310`).
const { chromium } = require('playwright');

const MAIL = process.env.MAILPIT_URL || 'http://127.0.0.1:54324';
const run = Date.now();

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
  if (!ok) fail.push(name);
};

const clickText = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || '') && !e.disabled);
  if (!el) throw new Error('no enabled element matching ' + t + ' in ' + s);
  el.click();
}, [text, sel]);

async function codeFor(email) {
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:' + email)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`)).json();
      const code = msg.Text.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('no code arrived for ' + email);
}

/** What the map itself says it has drawn — not what the panel claims. */
const board = (p) => p.evaluate(() => {
  const stations = window.__map.getSource('stations').serialize().data.features;
  const zones = window.__map.getSource('zones').serialize().data.features;
  return {
    stations: stations.length,
    zones: zones.length,
    names: stations.map(f => f.properties.name),
    rendered: window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length,
    counter: document.querySelector('.topbar .count')?.textContent,
  };
});

async function open(browser, target) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  return { p, errors };
}

const toCommunity = async (p) => {
  await clickText(p, '^Map$', '.topbar button');
  await clickText(p, 'Community maps');
  await p.waitForSelector('.community');
};

async function signIn(p, email, name) {
  await p.fill('.accountbox input[type="email"]', email);
  await clickText(p, 'Email me a code');
  await p.waitForSelector('.accountbox input.code', { timeout: 15000 });
  await p.fill('.accountbox input.code', await codeFor(email));
  await clickText(p, '^Sign in$');
  await p.waitForSelector('.accountbox input[placeholder="Display name"]', { timeout: 15000 });
  await p.fill('.accountbox input[placeholder="Display name"]', name);
  await clickText(p, '^Save$');
  await p.waitForFunction((n) => new RegExp('Signed in as\\s*' + n).test(document.querySelector('.accountbox')?.textContent || ''), name, { timeout: 15000 });
}

/** A real tap on the map canvas at a coordinate. */
async function tapMap(p, lngLat) {
  const pt = await p.evaluate((ll) => {
    const r = window.__map.getCanvas().getBoundingClientRect();
    const q = window.__map.project(ll);
    return { x: r.left + q.x, y: r.top + q.y };
  }, lngLat);
  await p.mouse.click(pt.x, pt.y);
}

(async () => {
  const target = process.env.TARGET || 'http://127.0.0.1:4310/';
  console.log('target:', target, '\n');
  const browser = await chromium.launch();
  const ana = await open(browser, target);
  const ben = await open(browser, target);
  const mapName = `Sunset loop ${run}`;

  // ---- ana signs in and draws a map
  const shipped = await board(ana.p);
  check('the built-in board is what loads first', shipped.stations === 192 && shipped.zones === 192 && shipped.rendered > 0, JSON.stringify({ ...shipped, names: undefined }));

  await toCommunity(ana.p);
  check('a guest sees the sign-in box, with the reason for it', /Sign in to publish/.test(await ana.p.textContent('.accountbox')));
  await signIn(ana.p, `ana-${run}@example.com`, 'Ana');
  check('signing in with an emailed code works', true);

  await clickText(ana.p, 'Make a map');
  await ana.p.waitForSelector('.community.editor');
  await ana.p.fill('.editor .field input', mapName);
  await ana.p.fill('.editor textarea', 'Outer Sunset and the park edge. Good for a two-hour game.');

  const addStation = async (ll, name) => {
    // Zoomed in, so a tap lands on open ground rather than one of 192 station targets.
    await ana.p.evaluate((c) => window.__map.jumpTo({ center: c, zoom: 16 }), ll);
    await ana.p.waitForTimeout(1200);
    await tapMap(ana.p, ll);
    await ana.p.waitForSelector('.editor input[placeholder="Station name"]', { timeout: 8000 });
    await ana.p.fill('.editor input[placeholder="Station name"]', name);
    await clickText(ana.p, '^Add$');
    // Poll for the change itself: the name only appears if the tap became a station.
    await ana.p.waitForFunction((n) => window.__map.getSource('stations').serialize().data.features.some(f => f.properties.name === n), name, { timeout: 8000 }).catch(() => {});
  };

  // First somewhere it must not be allowed: just off Ocean Beach, outside the boundary.
  await addStation([-122.5145, 37.7352], 'Adrift Test Stop');
  check('a station outside the boundary blocks publishing, and says why',
    /Can’t be played: 1 station is outside the game boundary: Adrift Test Stop/.test(await ana.p.textContent('.editor'))
    && await ana.p.evaluate(() => [...document.querySelectorAll('.editor button')].filter(b => /Publish map|Play on it/.test(b.textContent)).every(b => b.disabled)));
  await clickText(ana.p, '^Remove$');
  await ana.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.length === 192, null, { timeout: 8000 }).catch(() => {});

  // Then somewhere fine: the middle of Golden Gate Park.
  await addStation([-122.4862, 37.7694], 'Zoo Gate Test Stop');
  let now = await board(ana.p);
  check('a tap on the map plus a name adds a station, and its zone', now.stations === 193 && now.zones === 193 && now.names.includes('Zoo Gate Test Stop'), `${now.stations} stations`);
  const drawn = await ana.p.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['stations-dot'] }).some(f => f.properties.name === 'Zoo Gate Test Stop'), null, { timeout: 8000 }).then(() => true, () => false);
  check('...which the map actually draws', drawn);

  // Remove an existing station by tapping it.
  const victim = await ana.p.evaluate(() => {
    const f = window.__map.getSource('stations').serialize().data.features.find(x => x.properties.name !== 'Zoo Gate Test Stop');
    return { name: f.properties.name, ll: f.geometry.coordinates };
  });
  await ana.p.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 17 }), victim.ll);
  await ana.p.waitForTimeout(1200);
  await tapMap(ana.p, victim.ll);
  await ana.p.waitForFunction(() => [...document.querySelectorAll('.editor button')].some(b => b.textContent === 'Remove'), null, { timeout: 8000 });
  await clickText(ana.p, '^Remove$');
  await ana.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.length === 192, null, { timeout: 8000 }).catch(() => {});
  now = await board(ana.p);
  check('tapping a station and removing it takes it off the board', now.stations === 192 && !now.names.includes(victim.name), victim.name);
  check('the editor says what changed', /1 added, 1 removed/.test(await ana.p.textContent('.editor')));

  await clickText(ana.p, 'Publish map');
  await ana.p.waitForFunction((n) => document.querySelector('.community h2')?.textContent === n, mapName, { timeout: 15000 });
  check('publishing lands on the map’s own page', /by Ana/.test(await ana.p.textContent('.community')));
  now = await board(ana.p);
  check('leaving the editor puts the built-in board back', now.stations === 192 && now.names.includes(victim.name) && !now.names.includes('Zoo Gate Test Stop'));

  // ---- ben, a guest, finds it and plays on it
  await toCommunity(ben.p);
  await clickText(ben.p, '^New$', '.community .seg button');
  await ben.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), mapName, { timeout: 15000 });
  check('a guest sees the published map in the list', true);
  await clickText(ben.p, mapName, '.list.maps button');
  await ben.p.waitForFunction((n) => document.querySelector('.community h2')?.textContent === n, mapName, { timeout: 15000 });
  check('a guest cannot like', await ben.p.evaluate(() => [...document.querySelectorAll('.reactions button')].every(b => b.disabled)));
  check('a guest sees no comment box', (await ben.p.$('.compose')) === null);

  await clickText(ben.p, 'Play on this map');
  await ben.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.some(f => f.properties.name === 'Zoo Gate Test Stop'), null, { timeout: 15000 }).catch(() => {});
  now = await board(ben.p);
  check('playing on it swaps the board the map draws', now.stations === 192 && now.zones === 192 && now.names.includes('Zoo Gate Test Stop') && !now.names.includes(victim.name));
  check('...and the zones are really rendered', now.rendered > 0 && /192/.test(now.counter || ''), `${now.rendered} rendered, counter ${now.counter}`);

  await ben.p.context().setOffline(true);
  await ben.p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const offlineOk = await ben.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 20000 }).then(() => true, () => false);
  await ben.p.context().setOffline(false);
  if (!offlineOk) {
    // No service worker in this harness, so an offline reload cannot fetch the app itself; reload online instead.
    await ben.p.reload({ waitUntil: 'domcontentloaded' });
    await ben.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  }
  await ben.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.some(f => f.properties.name === 'Zoo Gate Test Stop'), null, { timeout: 15000 }).catch(() => {});
  now = await board(ben.p);
  check('the chosen map survives a reload', now.names.includes('Zoo Gate Test Stop') && !now.names.includes(victim.name));

  // ---- ben signs in, likes, comments
  await toCommunity(ben.p);
  check('the community page says which board is in play', (await ben.p.textContent('.boardnow')).includes(mapName));
  await clickText(ben.p, mapName, '.list.maps button');
  await ben.p.waitForSelector('.reactions');
  await signIn(ben.p, `ben-${run}@example.com`, 'Ben');
  await ben.p.waitForFunction(() => [...document.querySelectorAll('.reactions button')].every(b => !b.disabled), null, { timeout: 15000 });
  await clickText(ben.p, 'Like', '.reactions button');
  await ben.p.waitForFunction(() => /Like · 1/.test(document.querySelector('.reactions')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('a signed-in user’s like is counted', /Like · 1/.test(await ben.p.textContent('.reactions')));
  await ben.p.fill('.compose textarea', 'Love that the zoo finally counts. Not sure about dropping a downtown stop.');
  await clickText(ben.p, '^Comment$');
  await ben.p.waitForSelector('.threaditem', { timeout: 15000 });
  check('...and their comment appears under their name', /Ben/.test(await ben.p.textContent('.threaditem')));

  // ---- ana sees both, and replies
  await ana.p.reload({ waitUntil: 'domcontentloaded' });
  await ana.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await toCommunity(ana.p);
  await clickText(ana.p, '^New$', '.community .seg button');
  await ana.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), mapName, { timeout: 15000 });
  check('the list shows the like and the comment', await ana.p.evaluate((n) => {
    const li = [...document.querySelectorAll('.list.maps li')].find(l => l.querySelector('b')?.textContent === n);
    return /▲ 1/.test(li.textContent) && /1 comment/.test(li.textContent);
  }, mapName));
  await clickText(ana.p, mapName, '.list.maps button');
  await ana.p.waitForSelector('.threaditem');
  check('the author is still signed in after a reload', /Signed in as\s*Ana/.test(await ana.p.textContent('.community')));
  await clickText(ana.p, '^Reply$', '.threaditem button');
  await ana.p.fill('.comment.reply input', 'Fair. I might bring it back in v2.');
  await clickText(ana.p, '^Reply$', '.comment.reply button');
  await ana.p.waitForFunction(() => document.querySelectorAll('.threaditem .comment.reply p').length === 1, null, { timeout: 15000 }).catch(() => {});
  check('a reply is threaded under the comment', (await ana.p.$$('.threaditem .comment.reply p')).length === 1);

  // ---- ben branches it
  await ben.p.evaluate(() => { const b = [...document.querySelectorAll('.boardnow button, .community button')].find(x => /All maps/.test(x.textContent)); b.click(); });
  await clickText(ben.p, 'Back to the built-in board');
  await ben.p.waitForFunction(() => !window.__map.getSource('stations').serialize().data.features.some(f => f.properties.name === 'Zoo Gate Test Stop'), null, { timeout: 15000 }).catch(() => {});
  check('going back to the built-in board restores it', !(await board(ben.p)).names.includes('Zoo Gate Test Stop'));
  await clickText(ben.p, mapName, '.list.maps button');
  await ben.p.waitForSelector('.reactions');
  await clickText(ben.p, 'Branch it');
  await ben.p.waitForSelector('.community.editor');
  check('a branch starts from the original’s stations', (await board(ben.p)).names.includes('Zoo Gate Test Stop'));
  await ben.p.fill('.editor .field input', `Sunset loop, with downtown ${run}`);
  await clickText(ben.p, 'Publish branch');
  await ben.p.waitForFunction(() => /Branched from/.test(document.querySelector('.community')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('the branch’s page links back to where it came from', new RegExp(`Branched from\\s*${mapName} by Ana`).test(await ben.p.textContent('.community')));
  await clickText(ben.p, `${mapName} by Ana`);
  await ben.p.waitForFunction(() => /Branches · 1/.test(document.querySelector('.community')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('...and the original lists it as a branch', /Branches · 1/.test(await ben.p.textContent('.community')));
  await ben.p.screenshot({ path: process.env.SHOT || '/tmp/community-map.png', fullPage: false });

  // ---- tidy up: each author deletes their own map
  await clickText(ana.p, '^Delete$', '.community .row button');
  await ana.p.waitForSelector('.boardnow', { timeout: 15000 });
  await clickText(ben.p, 'All maps');
  await clickText(ben.p, '^New$', '.community .seg button');
  await ben.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent.startsWith('Sunset loop, with downtown')), null, { timeout: 15000 });
  check('deleting the original leaves the branch standing', !(await ben.p.textContent('.list.maps')).includes(`${mapName}by`) );
  await clickText(ben.p, `Sunset loop, with downtown ${run}`, '.list.maps button');
  await ben.p.waitForSelector('.reactions');
  check('...now marked as branched from a deleted map', /since been deleted/.test(await ben.p.textContent('.community')));
  await clickText(ben.p, '^Delete$', '.community .row button');
  await ben.p.waitForSelector('.boardnow', { timeout: 15000 });

  check('no page errors', ana.errors.length + ben.errors.length === 0, JSON.stringify([...ana.errors, ...ben.errors]));
  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:community:ui crashed:', e);
  process.exit(1);
});
