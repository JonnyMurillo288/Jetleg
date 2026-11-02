// Verification for the site around the game: the landing page, Start a game,
// the stats page and the info pages — through the UI, in a real browser.
//
// Every number it checks is worked out a second way, here, without the app's
// code: the city counts straight from the maps table (not the directory
// view the app reads), the radar cut from the station list by great-circle
// distance, the distance to the hider likewise.
//
// Needs a built app on :4310 (`npm run build && npx vite preview --port 4310`).
// With `supabase start` running it also checks the community counts and plays
// on a published map (`npm run seed:community` gives it some); without, those
// steps say SKIP — they are not passes.
const { chromium } = require('playwright');
const { existsSync, readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const shots = process.env.SHOTS || mkdtempSync(path.join(tmpdir(), 'jetleg-flow-'));

const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
const supabaseUrl = process.env.SUPABASE_URL || env.match(/^VITE_SUPABASE_URL=(\S+)/m)?.[1] || '';
const anonKey = process.env.SUPABASE_ANON_KEY || env.match(/^VITE_SUPABASE_ANON_KEY=(\S+)/m)?.[1] || '';

const fail = [];
let skipped = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) fail.push(name);
};
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}  (${why})`); };

const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8')).stations;
const haversine = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};
const miles = (m) => m / 1609.344;

// ------------------------------------------------------------- the fixture
// One finished seeking round on the built-in board, with times and places
// chosen so every stat has one right answer.
const CIVIC_CENTER = [-122.4194, 37.7793];
const MISSION = [-122.4189, 37.7599];
const START = Date.UTC(2026, 9, 3, 17, 0, 0);
const MIN = 60000;
const ROUND = {
  id: 'flow-fixture-round',
  role: 'seeker',
  label: 'Fixture round',
  startedAt: START,
  endedAt: START + 95 * MIN,
  asks: [
    { id: 'f1', questionId: 'radar-2000', askedAt: START + 10 * MIN, origin: CIVIC_CENTER, answer: { kind: 'yesno', value: 'yes' } },
    { id: 'f2', questionId: 'match-park', askedAt: START + 25 * MIN, origin: CIVIC_CENTER, answer: { kind: 'yesno', value: 'no' } },
    { id: 'f3', questionId: 'match-zoo', askedAt: START + 27 * MIN, origin: MISSION, answer: { kind: 'null' } },
    { id: 'f4', questionId: 'meas-library', askedAt: START + 80 * MIN, origin: MISSION, answer: { kind: 'closerFurther', value: 'closer' } },
  ],
};
const gameFile = (rounds) => JSON.stringify({
  app: 'jetleg-sf', version: 1, exportedAt: START + 100 * MIN, role: 'seeker',
  settings: { gameSize: 'medium', strictness: 'strict', units: 'imperial', supervisorDistrictsAsAdmin4: false },
  rounds,
});

const clickText = (p, text, sel = 'button, a') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
}, [text, sel]);
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
const hashIs = (p, hash) => p.waitForFunction((h) => location.hash === h, hash, { timeout: 15000 }).then(() => true, () => false);
const mapDrew = (p) => p.evaluate(() => ({
  styleLoaded: window.__map.isStyleLoaded(),
  zones: window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length,
  stations: new Set(window.__map.queryRenderedFeatures({ layers: ['stations-dot'] }).map((f) => f.properties.id)).size,
}));
/** The game's map, once it has actually drawn something. */
const gameReady = async (p) => {
  await p.waitForFunction(() => window.__mapReady === true && window.__map?.isStyleLoaded(), null, { timeout: 45000 });
  await p.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length > 0, null, { timeout: 20000 }).catch(() => {});
};

(async () => {
  console.log('target:', origin, '\nscreenshots:', shots, '\n');

  // What the server holds, read straight from the table rather than from the view the app uses.
  let serverMaps = null;
  if (supabaseUrl && anonKey) {
    serverMaps = await fetch(`${supabaseUrl}/rest/v1/community_maps?select=id,name,city,country,kind,parent_map_name,station_count,like_count`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    }).then((r) => (r.ok ? r.json() : null), () => null);
  }
  const sfMaps = (serverMaps ?? []).filter((m) => m.city === 'sf');
  const sfMain = sfMaps.filter((m) => m.parent_map_name === null).length;
  const expectedSfLabel = sfMain + 1 > 10 ? '10+' : String(sfMain + 1);
  console.log(serverMaps ? `server: ${serverMaps.length} maps, ${sfMaps.length} for sf (${sfMain} main)\n` : 'server: not reachable — community steps will be skipped\n');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    const fix = { coords: { latitude: 37.7793, longitude: -122.4194, accuracy: 18 }, timestamp: Date.now() };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (cb) => setTimeout(() => cb(fix), 50), watchPosition: (cb) => { setTimeout(() => cb(fix), 50); return 1; }, clearWatch: () => {} },
    });
  });
  const errors = [];
  const writes = [];
  p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });
  p.on('request', (r) => { if (r.method() !== 'GET') writes.push(`${r.method()} ${r.url().slice(0, 120)}`); });
  p.on('dialog', (d) => d.accept());

  // ------------------------------------------------------------- landing
  await p.goto(origin, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.landing', { timeout: 20000 });
  await p.waitForFunction(() => document.querySelector('.hero img')?.complete, null, { timeout: 20000 });
  const hero = await p.evaluate(() => {
    const img = document.querySelector('.hero img');
    const r = img.getBoundingClientRect();
    return { natural: [img.naturalWidth, img.naturalHeight], shown: [Math.round(r.width), Math.round(r.height)], src: img.currentSrc };
  });
  // A missing file is served as the app's own HTML with a 200; only a decoded picture has a size.
  check('landing shows a decoded picture of the board', hero.natural[0] === 1600 && hero.natural[1] === 1000 && hero.shown[1] > 200, hero);
  const heroType = (await p.request.get(hero.src)).headers()['content-type'];
  check('that picture is served as an image', /^image\/jpeg/.test(heroType || ''), heroType);
  check('landing draws no live map', (await p.$('.maplibregl-canvas')) === null);
  const cards = await p.evaluate(() => [...document.querySelectorAll('.navgrid a, .pagefoot a')].map((a) => [a.querySelector('strong')?.textContent ?? a.textContent, a.getAttribute('href')]));
  check('landing links to every page', JSON.stringify(cards) === JSON.stringify([
    ['Start a game', '#/start'], ['Explore maps', '#/maps'], ['Create a map', '#/maps/new'], ['Game stats', '#/stats'], ['About', '#/about'], ['Privacy', '#/privacy'],
  ]), cards);
  await p.screenshot({ path: path.join(shots, 'landing-phone.png') });

  for (const [label, hash, sel, expect] of [
    ['About', '#/about', '.prose h2', /What JetLeg is/],
    ['Privacy', '#/privacy', '.prose h2', /The short version/],
    ['Game stats', '#/stats', '.page-body h2', /question by question/],
  ]) {
    await clickText(p, `^${label}`, '.landing a');
    const there = (await hashIs(p, hash)) && expect.test(await text(p, sel));
    check(`"${label}" opens its page`, there, await text(p, sel));
    await clickText(p, 'Home', '.topbar a');
    await p.waitForSelector('.landing');
  }

  await clickText(p, '^Explore maps', '.landing a');
  await hashIs(p, '#/maps');
  await gameReady(p);
  check('"Explore maps" opens the studio, and its map draws the board', /Community maps/.test(await text(p, '.community h2')) && (await mapDrew(p)).zones > 0, await mapDrew(p));
  await clickText(p, 'Home', '.topbar a');
  await p.waitForSelector('.landing');
  await clickText(p, '^Create a map', '.landing a');
  await hashIs(p, '#/maps/new');
  await p.waitForSelector('.community h2');
  const createButtons = await p.evaluate(() => [...document.querySelectorAll('.community button')].map((b) => b.textContent.trim()));
  check('"Create a map" opens the studio on its tools, not on the published list',
    /Create a map/.test(await text(p, '.community h2')) && createButtons.includes('New city') && (await p.$('.list.maps')) === null, createButtons);
  await clickText(p, '^New city$', '.community button');
  await p.waitForSelector('.editor', { timeout: 10000 }).catch(() => {});
  check('…and "New city" opens the map editor', (await p.$('.editor')) !== null);

  // ---------------------------------------------------------- start a game
  await p.goto(origin + '#/start', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.citypicker input');
  check('no dropdown until the city box is used', (await p.$('.citylist')) === null);
  await p.click('.citypicker input');
  await p.waitForSelector('.citylist li');
  if (serverMaps) await p.waitForFunction(() => document.querySelectorAll('.citylist li').length > 1, null, { timeout: 10000 }).catch(() => {});
  const options = () => p.evaluate(() => [...document.querySelectorAll('.citylist li')].map((li) => ({
    flag: li.querySelector('.flag')?.textContent ?? null,
    name: li.querySelector('.grow')?.textContent ?? '',
    count: li.querySelector('.mapcount b')?.textContent ?? null,
    countText: li.querySelector('.mapcount')?.textContent ?? null,
  })));
  await p.fill('.citypicker input', 'san');
  await p.waitForTimeout(200);
  let opts = await options();
  const sf = opts.find((o) => /^San Francisco/.test(o.name));
  check('typing "san" offers San Francisco with its flag', !!sf && sf.flag === '🇺🇸' && opts.every((o) => /san/i.test(o.name)), opts);
  check(`…and its number of main maps (${expectedSfLabel})`, sf?.count === expectedSfLabel && /^\S+ maps?$/.test(sf?.countText ?? ''), sf);
  await p.screenshot({ path: path.join(shots, 'start-dropdown.png') });

  if (serverMaps) {
    const other = serverMaps.find((m) => m.city !== 'sf');
    if (other) {
      await p.fill('.citypicker input', other.city);
      await p.waitForTimeout(200);
      const row = (await options())[0];
      const main = serverMaps.filter((m) => m.city === other.city && m.parent_map_name === null).length;
      const flagOk = other.country ? row?.flag !== '🌐' : row?.flag === '🌐';
      check(`a community city (“${other.city}”) is listed with its own count and flag`, row?.count === String(Math.min(main, 10)) + (main > 10 ? '+' : '') && flagOk, row);
    } else skip('a community city other than sf', 'none published');
  } else skip('community cities in the dropdown', 'no server');

  await p.fill('.citypicker input', 'atlantis');
  await p.waitForTimeout(200);
  const none = await text(p, '.citylist');
  check('a city with no maps says so and offers to create one', /No maps for “atlantis” yet/.test(none) && (await p.$('.citylist a[href="#/maps/new"]')) !== null, none);

  // Keyboard: type, arrow, enter.
  await p.fill('.citypicker input', 'san fr');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowUp');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.citymaps');
  check('choosing a city closes the dropdown and lists its maps', (await p.$('.citylist')) === null && /Maps for San Francisco/.test(await text(p, '.citymaps h3')));
  if (serverMaps) {
    await p.waitForFunction((n) => document.querySelectorAll('.citymaps .list.maps li').length === n, sfMaps.length + 1, { timeout: 10000 }).catch(() => {});
    const listed = await p.evaluate(() => document.querySelectorAll('.citymaps .list.maps li').length);
    check('the list is the built-in board plus every published map for the city', listed === sfMaps.length + 1, `${listed} listed, ${sfMaps.length} published`);
  }
  await p.screenshot({ path: path.join(shots, 'start-city.png'), fullPage: true });

  await clickText(p, '^Play$', '.citymaps li:first-child button');
  check('playing the built-in board lands in the game', await hashIs(p, '#/play'));
  await gameReady(p);
  const drew = await mapDrew(p);
  const count = (await text(p, '.topbar .count')).replace(/\s/g, '');
  check('the game map drew the whole board', drew.styleLoaded && drew.zones > 0 && drew.stations === stations.length && count === `${stations.length}/${stations.length}`, { ...drew, count });
  check('the game offers to start a round, as before', /Start a new round/.test(await text(p, '.sheet')));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.topbar .count', { timeout: 20000 });
  check('a reload stays in the game', await p.evaluate(() => location.hash === '#/play'));

  // ----------------------------------------------------------------- stats
  await p.goto(origin + '#/stats', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.page-body h2');
  check('stats starts empty', /No rounds yet/.test(await text(p, '.page-body')));
  const share = await p.$('.sharecheck input');
  if (share) check('sharing rounds with a team is off until asked for', (await share.isChecked()) === false);
  else skip('the sharing switch', 'this build has no server');

  const file = path.join(shots, 'fixture.json');
  writeFileSync(file, gameFile([ROUND, { id: 'broken', role: 'seeker' }]));
  writes.length = 0;
  await p.setInputFiles('.page-body input[type=file]', file);
  await p.waitForSelector('.openedfile');
  const opened = await text(p, '.openedfile');
  check('a game file opens, and says what it could not read', /fixture\.json/.test(opened) && /1 round/.test(opened) && /1 entry in the file could not be read and was left out/.test(opened), opened.slice(0, 160));

  const client = await ctx.newCDPSession(p);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await clickText(p, 'Fixture round', '.openedfile button');
  await p.waitForSelector('.qcards .qcard');
  const openMs = Date.now() - t0;
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  check('opening a round takes well under a second at 4x CPU throttle', openMs < 1500, `${openMs} ms`);

  const tiles = await p.evaluate(() => [...document.querySelectorAll('.resultstats .stat')].map((s) => ({
    value: s.querySelector('strong')?.textContent.trim(), label: s.querySelector('.muted')?.textContent.trim(), width: Math.round(s.getBoundingClientRect().width),
  })));
  check('stat tiles have real width', tiles.length >= 3 && tiles.every((t) => t.width > 60), tiles);
  const cardsOf = () => p.evaluate(() => [...document.querySelectorAll('.qcard')].map((c) => ({
    text: c.textContent.replace(/\s+/g, ' ').trim(),
    nums: c.querySelector('.cutnums')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    bar: Math.round(c.querySelector('.cutbar')?.getBoundingClientRect().width ?? 0),
    left: Math.round(c.querySelector('.cut-left')?.getBoundingClientRect().width ?? 0),
    gone: Math.round(c.querySelector('.cut-gone')?.getBoundingClientRect().width ?? 0),
  })));
  let q = await cardsOf();
  check('one card per question, in order', q.length === 4 && /^1 ?2 km/.test(q[0].text) && /^2 ?Park/.test(q[1].text) && /^3 ?Zoo/.test(q[2].text) && /^4 ?Library/.test(q[3].text), q.map((c) => c.text.slice(0, 40)));

  // Radar 2 km YES from Civic Center keeps the stations within 2 km. Counted here by great-circle
  // distance, with a few metres either way for the stations that sit on the line.
  const within = (m) => stations.filter((s) => haversine(CIVIC_CENTER, [s.lon, s.lat]) <= m).length;
  const radar = q[0].nums?.match(/^(\d+) → (\d+) zones/);
  check('question 1’s cut matches the stations actually within 2 km',
    !!radar && Number(radar[1]) === stations.length && Number(radar[2]) >= within(1990) && Number(radar[2]) <= within(2010),
    `${q[0].nums} — ${within(1990)}..${within(2010)} stations within 2 km`);
  const chain = q.map((c) => c.nums?.match(/^(\d+) → (\d+) zones/)).map((m) => m && [Number(m[1]), Number(m[2])]);
  check('each question starts from what the last one left', chain.every(Boolean) && chain.every((c, i) => i === 0 || c[0] === chain[i - 1][1]) && chain[3][1] < chain[0][1], chain);
  const leftTile = tiles.find((t) => /zones still possible/.test(t.label || ''));
  check('the headline count is what the last question left', !!chain[3] && leftTile?.value === String(chain[3][1]) && leftTile.label === `of ${stations.length} zones still possible`, leftTile);
  check('the null answer is shown as ruling out nothing', /ruled out nothing/.test(q[2].nums ?? '') && chain[2] && chain[2][0] === chain[2][1], q[2].nums);
  check('the bars are drawn to one scale, and split where a cut was made', q.every((c) => c.bar > 100 && c.bar === q[0].bar && c.left > 0) && q[0].gone > q[0].left && q[2].gone === 0, q.map((c) => [c.bar, c.left, c.gone]));
  check('gaps between questions are the fixture’s', /10 min after the start/.test(q[0].text) && /15 min after the last/.test(q[1].text) && /2 min after the last/.test(q[2].text) && /53 min after the last/.test(q[3].text), q.map((c) => c.text.match(/\d+ min after the \w+/)?.[0]));

  const highlights = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.highlight')].map((h) => [h.querySelector('.kicker').textContent, h.textContent.replace(/\s+/g, ' ')])));
  const shares = chain.map((c) => (c[0] - c[1]) / c[0]);
  const bestIdx = shares.indexOf(Math.max(...shares));
  const names = ['2 km', 'Park', 'Zoo', 'Library'];
  check('“Best question” is the one that cut the largest share', new RegExp(`Best question${names[bestIdx]} .*Question ${bestIdx + 1} cut`).test(highlights['Best question'] ?? ''), highlights['Best question']);
  check('“Weakest question” is the null one', /Weakest questionZoo NULL.*ruled out nothing.*3 cards/.test(highlights['Weakest question'] ?? ''), highlights['Weakest question']);
  check('“Longest wait” is the 53 minutes before question 4', /53 min.*question 3 and question 4/.test(highlights['Longest wait'] ?? ''), highlights['Longest wait']);
  check('nothing is said about the hider until the round is told where they were', !('Closest you got' in highlights) && !/from the hider/.test(q[0].text));

  // Tell the round where the hider was: a station the answers left standing.
  const hider = stations.filter((s) => haversine(CIVIC_CENTER, [s.lon, s.lat]) <= 1500)[0];
  await p.selectOption('.hiderpick select', hider.id);
  await p.waitForFunction(() => /from the hider/.test(document.querySelector('.qcard')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  q = await cardsOf();
  const shown = q.map((c) => c.text.match(/([\d.]+) (mi|ft) from the hider/)).map((m) => m && (m[2] === 'mi' ? Number(m[1]) : Number(m[1]) / 5280));
  const truth = ROUND.asks.map((a) => miles(haversine(a.origin, [hider.lon, hider.lat])));
  check('each card’s distance to the hider is the real one', shown.every((v, i) => v !== null && Math.abs(v - truth[i]) < 0.011), { shown, truth: truth.map((t) => +t.toFixed(3)) });
  check('…and the hider’s station is named', (await text(p, '.resultstats')).includes(hider.name));
  await p.screenshot({ path: path.join(shots, 'stats-round.png'), fullPage: true });

  check('reading a file and its stats wrote nothing to any server', writes.length === 0, writes);

  await clickText(p, 'All rounds', '.page-body button');
  await clickText(p, 'Keep these rounds on this device', '.openedfile button');
  await p.waitForFunction(() => /Added to this device/.test(document.querySelector('.openedfile')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.page-body h2');
  await p.waitForFunction(() => /Fixture round/.test(document.querySelector('.list.results')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  check('a kept round is on the device after a reload', /Fixture round/.test(await text(p, '.list.results')), await text(p, '.list.results'));

  // The same round, from the game's own Results tab.
  await p.goto(origin + '#/play', { waitUntil: 'domcontentloaded' });
  await gameReady(p);
  await clickText(p, '^Results$', '.topbar button');
  await clickText(p, 'Fixture round', '.list.results button');
  await p.waitForSelector('.qcards .qcard');
  const inGame = await p.evaluate(() => ({
    cards: document.querySelectorAll('.qcard').length,
    left: document.querySelector('.resultstats .stat strong')?.textContent,
  }));
  check('the Results tab shows the same round the same way', inGame.cards === 4 && inGame.left === String(chain[3][1]), inGame);

  // ------------------------------------------------- a published map, played
  if (serverMaps && sfMaps.length) {
    const pick = sfMaps.slice().sort((a, b) => a.station_count - b.station_count)[0];
    await p.goto(origin + '#/start', { waitUntil: 'domcontentloaded' });
    await p.fill('.citypicker input', 'san');
    await p.keyboard.press('Enter');
    await p.waitForFunction((name) => [...document.querySelectorAll('.citymaps li b')].some((b) => b.textContent === name), pick.name, { timeout: 10000 });
    await p.evaluate((name) => [...document.querySelectorAll('.citymaps li')].find((li) => li.querySelector('b').textContent === name).querySelector('button').click(), pick.name);
    const landed = await hashIs(p, '#/play');
    await gameReady(p);
    await p.waitForFunction((n) => (document.querySelector('.topbar .count')?.textContent ?? '').replace(/\s/g, '') === `${n}/${n}`, pick.station_count, { timeout: 15000 }).catch(() => {});
    const onMap = await mapDrew(p);
    check(`playing “${pick.name}” loads its ${pick.station_count} stations into the game`,
      landed && (await text(p, '.topbar .count')).replace(/\s/g, '') === `${pick.station_count}/${pick.station_count}` && onMap.stations === pick.station_count, onMap);

    await p.goto(origin + '#/maps/map/' + pick.id, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction((name) => document.querySelector('.community h2')?.textContent === name, pick.name, { timeout: 15000 }).catch(() => {});
    check('a map’s page has its own address', (await text(p, '.community h2')) === pick.name);
    await clickText(p, 'All maps', '.community button');
    check('…and leaving it goes back to the list', (await hashIs(p, '#/maps')) && /Community maps/.test(await text(p, '.community h2')));

    // Put the built-in board back, the way a player would.
    await p.goto(origin + '#/start', { waitUntil: 'domcontentloaded' });
    await p.fill('.citypicker input', 'san');
    await p.keyboard.press('Enter');
    await p.waitForSelector('.citymaps li');
    await clickText(p, '^Play$', '.citymaps li:first-child button');
    await hashIs(p, '#/play');
    await gameReady(p);
    await p.waitForFunction((n) => (document.querySelector('.topbar .count')?.textContent ?? '').replace(/\s/g, '') === `${n}/${n}`, stations.length, { timeout: 15000 }).catch(() => {});
    check('choosing the built-in board again puts all of it back', (await text(p, '.topbar .count')).replace(/\s/g, '') === `${stations.length}/${stations.length}`);
  } else skip('playing a published map, and a map page’s address', serverMaps ? 'no maps published for sf' : 'no server');

  // ------------------------------------------------------------ on a desk
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.goto(origin, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.landing');
  await p.waitForFunction(() => document.querySelector('.hero img')?.complete);
  const desk = await p.evaluate(() => {
    const hero = document.querySelector('.hero').getBoundingClientRect();
    const nav = document.querySelector('.navgrid').getBoundingClientRect();
    return { hero: [Math.round(hero.width), Math.round(hero.height)], navLeft: Math.round(nav.left), scrollW: document.documentElement.scrollWidth };
  });
  check('on a wide screen the picture sits beside the menu, with no sideways scroll', desk.navLeft >= desk.hero[0] && desk.hero[1] >= 780 && desk.scrollW <= 1280, desk);
  check('with a round on the device, the landing page still leads with “Start a game”', /Start a game/.test(await text(p, '.navcard.primary')));
  await p.screenshot({ path: path.join(shots, 'landing-desk.png') });

  check('no console or page errors the whole run', errors.length === 0, errors.slice(0, 5));

  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}${skipped ? ` — ${skipped} skipped` : ''}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('verify:flow crashed:', e); process.exit(1); });
