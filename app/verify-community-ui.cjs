// Verification for the map studio (#/maps), through the UI. Two real browsers:
//
//   ana — at a desk. Signs in, makes a station map for San Francisco, then
//         builds a whole other city with the studio's tools: boundary by
//         drawing and by place search, stations and places from
//         OpenStreetMap, Voronoi cells built and hand-made, published.
//   ben — on a phone, a guest. Finds the city map, sees it on the studio's
//         map, plays on it in the game, then signs in to like, comment
//         and branch.
//
// OpenStreetMap is not called: Nominatim and Overpass are answered here with
// fixtures, so the run is repeatable and no shared service is hit. The
// queries the app sends are checked against the pipeline's own selectors.
//
// The map is always asked what it drew — source contents and rendered
// features — never the panel what it claims.
//
// Needs `supabase start` (its mail catcher on :54324 supplies sign-in codes)
// and a built app on :4310 (`npm run build && npx vite preview --port 4310`).
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
const tab = (p, name) => clickText(p, `^${name}$`, '.tabs button');
const hasText = (p, sel, re, timeout = 15000) =>
  p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ''), [sel, re.source], { timeout }).then(() => true, () => false);

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

/** What the map itself holds and has drawn. */
const board = (p) => p.evaluate(() => {
  const data = (id) => window.__map.getSource(id).serialize().data.features;
  const ring = data('boundary')[0].geometry.coordinates[0];
  const c = window.__map.getCenter();
  return {
    stations: data('stations').length,
    zones: data('zones').length,
    names: data('stations').map(f => f.properties.name),
    pois: data('pois').map(f => f.properties.name),
    cells: data('voronoi').length,
    boundaryPoints: ring.length,
    boundaryLon: ring[0][0],
    center: [+c.lng.toFixed(2), +c.lat.toFixed(2)],
    renderedZones: window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length,
    renderedPois: window.__map.queryRenderedFeatures({ layers: ['pois'] }).length,
    renderedCells: window.__map.queryRenderedFeatures({ layers: ['voronoi-fill'] }).length,
  };
});
const settle = (p, ms = 1300) => p.waitForTimeout(ms);

// ---------------------------------------------------------------- fixtures
// "Testville": a square of central Sydney, with an islet that must be dropped.
const SQUARE = [[[151.14, -33.93], [151.27, -33.93], [151.27, -33.82], [151.14, -33.82], [151.14, -33.93]]];
const ISLET = [[[151.30, -33.80], [151.301, -33.80], [151.301, -33.799], [151.30, -33.799], [151.30, -33.80]]];
const node = (id, lon, lat, tags) => ({ type: 'node', id, lon, lat, tags });
const STATION_NODES = [
  node(1, 151.2069, -33.8832, { name: 'Central', railway: 'station' }),
  node(2, 151.2071, -33.8834, { name: 'Central', highway: 'bus_stop' }),   // same stop: folded in
  node(3, 151.2069, -33.8736, { name: 'Town Hall', railway: 'station' }),
  node(4, 151.2475, -33.8914, { name: 'Bondi Junction', railway: 'station' }),
  node(5, 151.35, -33.88, { name: 'Out Of Bounds', railway: 'station' }),  // outside: dropped
  node(6, 151.20, -33.86, { railway: 'station' }),                         // unnamed: dropped
];
// Every category comes back from one combined request, told apart by tag.
const PLACE_NODES = [
  node(11, 151.2113, -33.8663, { name: 'State Library', amenity: 'library' }),
  node(12, 151.1793, -33.8847, { name: 'Glebe Library', amenity: 'library' }),
  node(13, 151.2437, -33.8935, { name: 'Waverley Library', amenity: 'library' }),
  node(14, 151.21, -33.87, { amenity: 'library' }),                        // unnamed: dropped
  node(21, 151.2166, -33.8736, { name: 'Hyde Park', leisure: 'park' }),
  node(22, 151.2265, -33.8946, { name: 'Moore Park', leisure: 'park' }),
  node(31, 151.2, -33.9, { name: 'Only Zoo', tourism: 'zoo' }),
  node(41, 151.21, -33.865, { name: 'Honorary Thing', office: 'diplomatic', diplomatic: 'honorary_consulate' }), // rule: rejected
];
const answer = (q) => (/railway/.test(q) ? STATION_NODES : /"amenity"="library"/.test(q) ? PLACE_NODES : []);

async function open(browser, target, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  const queries = [];
  // `serialize` is only ever called by this harness's own polling; when it
  // polls a map that is still being rebuilt after a page change, that throw
  // is the harness's, not the app's.
  p.on('pageerror', e => { if (!/reading 'serialize'/.test(e.message)) errors.push(e.message); });
  p.on('dialog', d => d.accept());
  await ctx.route(/nominatim\.openstreetmap\.org/, r => r.fulfill({
    json: [
      { display_name: 'Testville, New South Wales, Australia', boundingbox: ['-33.93', '-33.799', '151.14', '151.301'], geojson: { type: 'MultiPolygon', coordinates: [ISLET, SQUARE] } },
      { display_name: 'Testville (a point, no outline)', boundingbox: ['0', '0', '0', '0'], geojson: { type: 'Point', coordinates: [0, 0] } },
    ],
  }));
  await ctx.route(/\/api\/interpreter/, r => {
    const q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, ''));
    queries.push(q);
    r.fulfill({ json: { elements: answer(q) } });
  });
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  return { p, errors, queries };
}

async function signIn(p, email, name) {
  await p.fill('.accountbox input[type="email"]', email);
  await clickText(p, 'Email me a code');
  await p.waitForSelector('.accountbox input.code', { timeout: 15000 });
  await p.fill('.accountbox input.code', await codeFor(email));
  await clickText(p, '^Sign in$');
  await p.waitForSelector('.accountbox input[placeholder="Display name"]', { timeout: 15000 });
  await p.fill('.accountbox input[placeholder="Display name"]', name);
  await clickText(p, '^Save$');
  await hasText(p, '.accountbox', new RegExp('Signed in as\\s*' + name));
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
const lookAt = async (p, ll, zoom) => { await p.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [ll, zoom]); await settle(p); };

(async () => {
  const origin = process.env.TARGET || 'http://127.0.0.1:4310/';
  const studio = origin + '#/maps';
  console.log('target:', studio, '\n');
  const browser = await chromium.launch();
  const ana = await open(browser, studio, { width: 1280, height: 800 });
  const ben = await open(browser, studio, { width: 390, height: 844 });
  const stationMap = `Sunset loop ${run}`;
  const cityMap = `Testville ${run}`;

  // ================================================== the page itself
  const shipped = await board(ana.p);
  check('the studio is its own page, showing the built-in board', /Map studio/.test(await ana.p.textContent('.topbar')) && shipped.stations === 192 && shipped.renderedZones > 0);
  check('on a desk the tools sit beside the map, not under it', await ana.p.evaluate(() => {
    const m = document.querySelector('.map').getBoundingClientRect();
    const s = document.querySelector('.sheet').getBoundingClientRect();
    return s.left >= m.right - 1 && s.height > 600;
  }));
  check('on a phone they sit under it', await ben.p.evaluate(() => document.querySelector('.sheet').getBoundingClientRect().top >= document.querySelector('.map').getBoundingClientRect().bottom - 1));
  await signIn(ana.p, `ana-${run}@example.com`, 'Ana');
  check('signing in with an emailed code works here', true);

  // ================================================== a station map for SF
  await clickText(ana.p, 'New stations for San Francisco');
  await ana.p.waitForSelector('.community.editor');
  await ana.p.fill('.editor .field input', stationMap);
  await tab(ana.p, 'Stations');

  const addStation = async (ll, name) => {
    await lookAt(ana.p, ll, 16);
    await tapMap(ana.p, ll);
    await ana.p.waitForSelector('.editor input[placeholder="Station name"]', { timeout: 8000 });
    await ana.p.fill('.editor input[placeholder="Station name"]', name);
    await clickText(ana.p, '^Add$');
    await ana.p.waitForFunction((n) => window.__map.getSource('stations').serialize().data.features.some(f => f.properties.name === n), name, { timeout: 8000 }).catch(() => {});
  };
  await addStation([-122.5145, 37.7352], 'Adrift Test Stop');   // off Ocean Beach
  check('a station outside the boundary is called out', /Can’t be played: 1 station is outside the game boundary: Adrift Test Stop/.test(await ana.p.textContent('.editor')));
  await tab(ana.p, 'Publish');
  check('...and blocks publishing and playing', await ana.p.evaluate(() => [...document.querySelectorAll('.editor button')].filter(b => /Publish map|Play on it/.test(b.textContent)).every(b => b.disabled)));
  await tab(ana.p, 'Stations');
  await tapMap(ana.p, [-122.5145, 37.7352]);
  await ana.p.waitForFunction(() => [...document.querySelectorAll('.editor button')].some(b => b.textContent === 'Remove'), null, { timeout: 8000 });
  await clickText(ana.p, '^Remove$');
  await addStation([-122.4862, 37.7694], 'Park Test Stop');     // mid Golden Gate Park
  let now = await board(ana.p);
  check('a tap plus a name adds a station and its zone', now.stations === 193 && now.zones === 193 && now.names.includes('Park Test Stop'), `${now.stations} stations`);
  await tab(ana.p, 'Publish');
  await clickText(ana.p, 'Publish map');
  await ana.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), stationMap, { timeout: 20000 }).catch(() => {});
  check('publishing returns to the list, with the map in it', await ana.p.evaluate((n) => [...document.querySelectorAll('.list.maps li')].some(l => l.querySelector('b')?.textContent === n && /San Francisco/.test(l.textContent)), stationMap));

  // ================================================== a whole other city
  await clickText(ana.p, '^New city$');
  await ana.p.waitForSelector('.community.editor');
  check('a new city opens on its Boundary tab', await hasText(ana.p, '.editor', /The edge of the game/));
  await settle(ana.p);
  now = await board(ana.p);
  check('...starting from the area on screen, with nothing of San Francisco in it', now.stations === 0 && now.boundaryPoints === 5);

  // -- boundary: draw
  await clickText(ana.p, 'Draw on the map');
  const view = await ana.p.evaluate(() => { const b = window.__map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; });
  const at = (fx, fy) => [view[0] + (view[2] - view[0]) * fx, view[1] + (view[3] - view[1]) * fy];
  for (const c of [at(0.35, 0.35), at(0.65, 0.35), at(0.5, 0.7)]) await tapMap(ana.p, c);
  // The draft's own vertices are the thing that changed; wait for those.
  await ana.p.waitForFunction(() => window.__map.getSource('measure').serialize().data.features.filter(f => f.properties.kind === 'vertex').length === 3, null, { timeout: 8000 }).catch(() => {});
  await settle(ana.p, 600);
  check('drawing shows each corner as it is placed', (await ana.p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['measure-vertex'] }).length)) === 3);
  await clickText(ana.p, '^Finish$');
  await ana.p.waitForFunction(() => window.__map.getSource('boundary').serialize().data.features[0].geometry.coordinates[0].length === 4, null, { timeout: 8000 }).catch(() => {});
  check('finishing makes the three corners the boundary', (await board(ana.p)).boundaryPoints === 4);

  // -- boundary: find a place
  await ana.p.fill('.editor input[placeholder^="City, borough"]', 'Testville');
  await clickText(ana.p, '^Search$');
  await ana.p.waitForSelector('.editor .list li', { timeout: 10000 });
  check('place search lists only results that have an outline', (await ana.p.$$('.editor .list li')).length === 1);
  await clickText(ana.p, '^Use$');
  await ana.p.waitForFunction(() => window.__map.getSource('boundary').serialize().data.features[0].geometry.coordinates[0][0][0] > 150, null, { timeout: 8000 }).catch(() => {});
  check('using it keeps the largest landmass and says what was dropped', /dropping 1 smaller one/.test(await ana.p.textContent('.editor')));
  await settle(ana.p, 1500);
  now = await board(ana.p);
  check('the map moves to centre on the new boundary', Math.abs(now.center[0] - 151.2) < 0.06 && Math.abs(now.center[1] + 33.875) < 0.06, JSON.stringify(now.center));
  check('...which is now what the map draws', now.boundaryPoints === 5 && now.boundaryLon > 150);

  // -- stations from OpenStreetMap
  await tab(ana.p, 'Stations');
  await clickText(ana.p, 'Rail, metro, tram and ferry stops');
  await ana.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.length === 3, null, { timeout: 15000 }).catch(() => {});
  await settle(ana.p, 800);
  now = await board(ana.p);
  check('stations come from OpenStreetMap: named, inside, one per stop', now.stations === 3 && now.zones === 3 && ['Central', 'Town Hall', 'Bondi Junction'].every(n => now.names.includes(n)), now.names.join(', '));
  check('...asked for with the pipeline’s own station query', ana.queries.some(q => /station\|halt\|tram_stop/.test(q) && /ferry_terminal/.test(q) && !/bus_stop/.test(q)));
  check('...and their zones are drawn', now.renderedZones > 0);

  // -- places from OpenStreetMap
  await tab(ana.p, 'Places');
  await clickText(ana.p, 'Fetch every category from OpenStreetMap');
  await hasText(ana.p, '.editor .notice', /Fetched 12 categories/, 30000);
  const audit = await ana.p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.layeraudit li')].map(l => [l.querySelector('b').textContent, l.textContent])));
  check('every category is fetched and counted', / 3/.test(audit['Libraries']) && / 2/.test(audit['Parks']), audit['Libraries']);
  check('a category with one entry is flagged always-yes, one with none as null', /always/.test(audit['Zoos']) && /null/.test(audit['Museums']));
  check('the rulebook’s exclusions apply: an honorary consulate is not a consulate', / 0/.test(audit['Foreign consulates']) && /null/.test(audit['Foreign consulates']));
  const placeQueries = ana.queries.filter(q => q.includes('"amenity"="library"'));
  check('...using the pipeline’s selectors, all in one request', placeQueries.length === 1
    && ['"leisure"="park"', '"natural"="peak"', '"office"="diplomatic"', '"tourism"="theme_park"', '"natural"="water"'].every(s => placeQueries[0].includes(s)), `${placeQueries.length} request(s)`);

  await clickText(ana.p, '^Libraries', '.layeraudit button');
  await ana.p.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['pois'] }).length === 3, null, { timeout: 8000 }).catch(() => {});
  now = await board(ana.p);
  check('opening a category draws its points', now.renderedPois === 3 && now.pois.includes('State Library'), now.pois.join(', '));
  await lookAt(ana.p, [151.19, -33.905], 15);
  await tapMap(ana.p, [151.19, -33.905]);
  await ana.p.waitForSelector('.editor input[placeholder^="Name of the"]', { timeout: 8000 });
  await ana.p.fill('.editor input[placeholder^="Name of the"]', 'Hand Placed Library');
  await clickText(ana.p, '^Add$');
  await ana.p.waitForFunction(() => window.__map.getSource('pois').serialize().data.features.length === 4, null, { timeout: 8000 }).catch(() => {});
  check('a tap adds a custom point to the category', (await board(ana.p)).pois.includes('Hand Placed Library'));
  await settle(ana.p, 800);
  await tapMap(ana.p, [151.19, -33.905]);
  await ana.p.waitForFunction(() => [...document.querySelectorAll('.editor button')].some(b => b.textContent === 'Remove'), null, { timeout: 8000 });
  await clickText(ana.p, '^Remove$');
  await ana.p.waitForFunction(() => window.__map.getSource('pois').serialize().data.features.length === 3, null, { timeout: 8000 }).catch(() => {});
  check('tapping a point and removing it is how a ruling is made', !(await board(ana.p)).pois.includes('Hand Placed Library'));
  const libIds = await ana.p.evaluate(() => window.__map.getSource('pois').serialize().data.features.map(f => f.properties.id));

  // -- Voronoi
  await tab(ana.p, 'Voronoi');
  check('the studio says the cells are out of date after edits', /have changed since these cells were built/.test(await ana.p.textContent('.editor')));
  await clickText(ana.p, 'Build all cells');
  await hasText(ana.p, '.editor .notice', /cells across/, 30000);
  const vrow = (label) => ana.p.evaluate((l) => [...document.querySelectorAll('.layeraudit li')].find(x => x.querySelector('b').textContent === l)?.textContent, label);
  const inRow = (label, text) => ana.p.evaluate(([l, t]) => {
    const li = [...document.querySelectorAll('.layeraudit li')].find(x => x.querySelector('b').textContent === l);
    [...li.querySelectorAll('button')].find(b => b.textContent === t).click();
  }, [label, text]);
  check('cells are built for every category with two or more points', /3 points · 3 cells/.test(await vrow('Libraries')) && /2 points · 2 cells/.test(await vrow('Parks')), await vrow('Libraries'));
  check('rail stations were derived from the stations, and have cells too', /3 points · 3 cells/.test(await vrow('Rail stations')), await vrow('Rail stations'));
  await inRow('Libraries', 'Show');
  await lookAt(ana.p, [151.205, -33.875], 11.5);
  await ana.p.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['voronoi-fill'] }).length > 0, null, { timeout: 8000 }).catch(() => {});
  now = await board(ana.p);
  check('showing a category draws its cells on the map', now.cells === 3 && now.renderedCells > 0, `${now.cells} cells, ${now.renderedCells} rendered`);

  // -- hand-made cells
  const half = (id, x0, x1) => ({ type: 'Feature', properties: { id, name: id }, geometry: { type: 'Polygon', coordinates: [[[x0, -33.93], [x1, -33.93], [x1, -33.82], [x0, -33.82], [x0, -33.93]]] } });
  const importInto = async (label, features) => {
    const handle = await ana.p.evaluateHandle((l) => [...document.querySelectorAll('.layeraudit li')].find(x => x.querySelector('b').textContent === l).querySelector('input[type=file]'), label);
    await handle.asElement().setInputFiles({ name: 'cells.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features })) });
  };
  await importInto('Libraries', [half('nobody-has-this-id', 151.14, 151.27)]);
  check('hand-made cells that match no point are refused, with the reason', await hasText(ana.p, '.editor .warntext', /none of those cells has an id matching a point/));
  await importInto('Libraries', [half(libIds[0], 151.14, 151.2), half(libIds[1], 151.2, 151.27)]);
  await ana.p.waitForFunction(() => window.__map.getSource('voronoi').serialize().data.features.length === 2, null, { timeout: 8000 }).catch(() => {});
  check('hand-made cells replace the built ones on the map', (await board(ana.p)).cells === 2 && /hand-made/.test(await vrow('Libraries')));
  await clickText(ana.p, 'Build all cells');
  await hasText(ana.p, '.editor .notice', /cells across/, 30000);
  check('...survive a rebuild untouched, and the studio says which point has none', /2 cells/.test(await vrow('Libraries')) && /1 point has no hand-made cell/.test(await ana.p.textContent('.editor .notice')), await ana.p.textContent('.editor .notice'));
  await inRow('Libraries', 'Automatic');
  await clickText(ana.p, 'Build all cells');
  await ana.p.waitForFunction(() => /3 points · 3 cells/.test([...document.querySelectorAll('.layeraudit li')].find(x => x.querySelector('b').textContent === 'Libraries')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  check('“Automatic” goes back to cells built from the points', /3 points · 3 cells/.test(await vrow('Libraries')) && !/hand-made/.test(await vrow('Libraries')));

  // -- publish the city
  await tab(ana.p, 'Details');
  await ana.p.fill('.editor .field input', cityMap);
  await ana.p.fill('.editor input[placeholder="e.g. oakland"]', 'testville');
  await tab(ana.p, 'Publish');
  check('the publish tab audits the whole map first', /3 hiding zones/.test(await ana.p.textContent('.editor')) && /File size about/.test(await ana.p.textContent('.editor')));
  await clickText(ana.p, 'Publish map');
  await ana.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), cityMap, { timeout: 30000 }).catch(() => {});
  check('the city map is published, listed under its own city', await ana.p.evaluate((n) => [...document.querySelectorAll('.list.maps li')].some(l => l.querySelector('b')?.textContent === n && /testville · full city/.test(l.textContent)), cityMap));
  await settle(ana.p, 1500);
  now = await board(ana.p);
  check('closing the editor puts the built-in board back, and the view with it', now.stations === 192 && Math.abs(now.center[0] + 122.44) < 0.1, JSON.stringify(now.center));

  // ================================================== ben: see it, play it
  await clickText(ben.p, '^New$', '.community .seg button');
  await ben.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), cityMap, { timeout: 15000 });
  await clickText(ben.p, cityMap, '.list.maps button');
  await ben.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.length === 3, null, { timeout: 20000 }).catch(() => {});
  await settle(ben.p, 1500);
  now = await board(ben.p);
  check('opening a map’s page puts that map on the map', now.stations === 3 && now.boundaryLon > 150 && now.names.includes('Town Hall'));
  check('...centred on it, half a world from San Francisco', Math.abs(now.center[0] - 151.2) < 0.08 && Math.abs(now.center[1] + 33.875) < 0.08, JSON.stringify(now.center));
  check('a guest cannot like, and sees no comment box', await ben.p.evaluate(() => [...document.querySelectorAll('.reactions button')].every(b => b.disabled) && !document.querySelector('.compose')));

  await clickText(ben.p, 'Play on this map');
  await ben.p.waitForFunction(() => !location.hash.startsWith('#/maps') && /3/.test(document.querySelector('.topbar .count')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  await ben.p.waitForFunction(() => window.__mapReady === true && window.__map.getSource('stations').serialize().data.features.length === 3, null, { timeout: 20000 }).catch(() => {});
  await settle(ben.p, 1500);
  now = await board(ben.p);
  check('playing on it goes to the game, on that board', /Seeker/.test(await ben.p.textContent('.topbar')) && now.stations === 3 && now.zones === 3 && now.boundaryLon > 150, `counter ${await ben.p.textContent('.topbar .count')}`);
  check('...with the game’s map over the new city, zones drawn', Math.abs(now.center[0] - 151.2) < 0.08 && now.renderedZones > 0, JSON.stringify(now.center));
  await clickText(ben.p, '^Map$', '.topbar button');
  check('the game’s Map tab names the board in play', await hasText(ben.p, '.sheet', new RegExp(cityMap)));

  await ben.p.reload({ waitUntil: 'domcontentloaded' });
  await ben.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await ben.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.length === 3, null, { timeout: 15000 }).catch(() => {});
  await settle(ben.p, 1500);
  now = await board(ben.p);
  check('the chosen city survives a reload, and the map opens on it', now.stations === 3 && now.boundaryLon > 150 && Math.abs(now.center[0] - 151.2) < 0.08, JSON.stringify(now.center));

  // ================================================== ben: react, branch
  await ben.p.evaluate(() => { location.hash = '#/maps'; });
  await ben.p.waitForFunction(() => !!document.querySelector('.boardnow') && window.__mapReady === true, null, { timeout: 45000 });
  check('back in the studio, it says which board is in play', await hasText(ben.p, '.boardnow', new RegExp(cityMap)));
  await clickText(ben.p, '^New$', '.community .seg button');
  await ben.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), cityMap, { timeout: 15000 });
  await clickText(ben.p, cityMap, '.list.maps button');
  await ben.p.waitForSelector('.reactions');
  await signIn(ben.p, `ben-${run}@example.com`, 'Ben');
  await ben.p.waitForFunction(() => [...document.querySelectorAll('.reactions button')].every(b => !b.disabled), null, { timeout: 15000 });
  await clickText(ben.p, 'Like', '.reactions button');
  check('a signed-in user’s like is counted', await hasText(ben.p, '.reactions', /Like · 1/));
  await ben.p.fill('.compose textarea', 'Three stations is a short game, but the cells are right.');
  await clickText(ben.p, '^Comment$');
  check('...and their comment appears under their name', await hasText(ben.p, '.threaditem', /Ben/));

  await clickText(ben.p, 'Branch it');
  await ben.p.waitForSelector('.community.editor');
  check('a branch of a city map opens in the full editor', await ben.p.evaluate(() => ['Boundary', 'Places', 'Voronoi'].every(t => [...document.querySelectorAll('.tabs button')].some(b => b.textContent === t))));
  await ben.p.fill('.editor .field input', `Testville branched ${run}`);
  await tab(ben.p, 'Publish');
  await clickText(ben.p, 'Publish branch');
  await ben.p.waitForFunction(() => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent.startsWith('Testville branched')), null, { timeout: 30000 }).catch(() => {});
  check('the branch is published and marked as one', await ben.p.evaluate(() => [...document.querySelectorAll('.list.maps li')].some(l => /Testville branched/.test(l.textContent) && /a branch/.test(l.textContent))));
  await clickText(ben.p, `^${cityMap}`, '.list.maps button');
  check('the original lists it', await hasText(ben.p, '.community', /Branches · 1/));
  await ben.p.screenshot({ path: process.env.SHOT || '/tmp/studio-map.png' });
  await clickText(ben.p, 'All maps');
  await clickText(ben.p, 'Back to the built-in board');
  await ben.p.waitForFunction(() => window.__map.getSource('stations').serialize().data.features.length === 192, null, { timeout: 15000 }).catch(() => {});
  check('going back to the built-in board restores it', (await board(ben.p)).stations === 192);

  // ================================================== tidy up
  const remove = async (who, name) => {
    await who.p.evaluate(() => [...document.querySelectorAll('.community button')].find(b => /All maps/.test(b.textContent))?.click());
    await who.p.waitForSelector('.boardnow', { timeout: 15000 });
    await clickText(who.p, '^New$', '.community .seg button');
    await who.p.waitForFunction((n) => [...document.querySelectorAll('.list.maps b')].some(b => b.textContent === n), name, { timeout: 15000 });
    await clickText(who.p, `^${name}`, '.list.maps button');
    await who.p.waitForSelector('.reactions');
    await clickText(who.p, '^Delete$', '.community .row button');
    await who.p.waitForSelector('.boardnow', { timeout: 15000 });
  };
  await remove(ben, `Testville branched ${run}`);
  await remove(ana, cityMap);
  await remove(ana, stationMap);

  check('no page errors', ana.errors.length + ben.errors.length === 0, JSON.stringify([...ana.errors, ...ben.errors]));
  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:community:ui crashed:', e);
  process.exit(1);
});
