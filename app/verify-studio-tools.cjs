// Verification for the map editor's own tools (studio/Editor.tsx): a map's
// hiding-zone size, selecting several stations or places, bulk changes, Undo,
// and Simplify. Real browser, real app; asks the map what it drew.
//
// Needs a built app on :4310. No server needed: the drafts are never published.
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};

const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8')).stations;
const haversine = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};
/** Overlapping pairs, counted the slow, obvious way. */
const overlapPairs = (list, r) => {
  let n = 0;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (haversine([list[i].lon, list[i].lat], [list[j].lon, list[j].lat]) < 2 * r) n++;
  return n;
};

const click = (p, re, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t).test(e.textContent || '') && !e.disabled);
  if (!el) throw new Error(`no enabled ${s} matching ${t}`);
  el.click();
}, [re, sel]);

/** A way to start a map from the community page; the San Francisco ones sit behind "More". */
const start = async (p, re) => {
  await p.evaluate(() => [...document.querySelectorAll('.community button')].find((b) => /^More/.test(b.textContent) && b.getAttribute('aria-expanded') === 'false')?.click());
  await p.waitForTimeout(50);
  await click(p, re, '.community button');
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ') ?? '', sel);
const settle = (p) => p.waitForFunction(() => window.__map.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 15000 }).catch(() => {}).then(() => p.waitForTimeout(400));
const rings = (p) => p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['picked-ring'] }).length);
const boardnow = (p) => text(p, '.editor .boardnow');
const tapAt = async (p, ll) => {
  const pt = await p.evaluate((x) => {
    const r = window.__map.getCanvas().getBoundingClientRect();
    const q = window.__map.project(x);
    return { x: r.left + q.x, y: r.top + q.y };
  }, ll);
  await p.mouse.click(pt.x, pt.y);
  await p.waitForTimeout(250);
};
const fitBoard = async (p) => {
  await p.evaluate(() => {
    const b = window.__map.getStyle() && JSON.parse(JSON.stringify(window.__map.getSource('boundary').serialize().data));
    const coords = b.features[0].geometry.coordinates.flat(2);
    const xs = []; const ys = [];
    for (let i = 0; i < coords.length; i += 2) { xs.push(coords[i]); ys.push(coords[i + 1]); }
    window.__map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 20, animate: false });
  });
  await settle(p);
};

(async () => {
  console.log('target:', origin, '\n');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());

  await p.goto(origin + '#/maps/new');
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await start(p, '^New stations for San Francisco$');
  await p.waitForSelector('.editor');
  await click(p, '^Stations$', '.tabs button');
  await p.waitForSelector('.editor .radiusrow');
  await fitBoard(p);

  // ------------------------------------------------------------ zone size
  const radiusOn = () => text(p, '.editor .radiusrow .seg button.on');
  check('a new map starts at 500 m zones', (await radiusOn()) === '500 m', await radiusOn());
  const want500 = overlapPairs(stations, 500);
  const shown500 = Number((await boardnow(p)).match(/(\d+) pairs? of zones overlap/)?.[1]);
  check('the overlap count is the real one', Math.abs(shown500 - want500) <= 2, { shown: shown500, counted: want500 });

  await click(p, '^800 m$', '.editor .radiusrow button');
  await p.waitForTimeout(600);
  const drawn = await p.evaluate(() => {
    const f = window.__map.getSource('zones').serialize().data.features[0];
    return { id: f.properties.id, ring: f.geometry.coordinates[0].slice(0, 6) };
  });
  const st = stations.find((s) => s.id === drawn.id);
  const radii = drawn.ring.map((c) => Math.round(haversine([st.lon, st.lat], c)));
  check('choosing 800 m redraws every zone at 800 m', radii.every((r) => Math.abs(r - 800) <= 2), radii);
  const shown800 = Number((await boardnow(p)).match(/(\d+) pairs? of zones overlap/)?.[1]);
  check('…and the overlap count follows it', Math.abs(shown800 - overlapPairs(stations, 800)) <= 2 && shown800 > shown500, { shown: shown800, counted: overlapPairs(stations, 800) });
  await p.fill('.editor .radiusin input', '650');
  await p.press('.editor .radiusin input', 'Enter');
  await p.waitForTimeout(500);
  const r650 = await p.evaluate(() => window.__map.getSource('zones').serialize().data.features[0].geometry.coordinates[0][0]);
  check('a typed size works too', Math.abs(haversine([st.lon, st.lat], r650) - 650) <= 2);
  await click(p, '^500 m$', '.editor .radiusrow button');
  await p.waitForTimeout(400);

  // ------------------------------------------------------------ selecting
  await click(p, '^Select$', '.pickbar button');
  const a = stations[10], b = stations[40];
  for (const s of [a, b]) {
    await p.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 16 }), [s.lon, s.lat]);
    await settle(p);
    await tapAt(p, [s.lon, s.lat]);
  }
  check('in Select mode, tapping two stations selects them', /2 selected/.test(await text(p, '.pickbar')), await text(p, '.pickbar'));
  await fitBoard(p);
  check('…and both are ringed on the map', (await rings(p)) === 2, await rings(p));
  await p.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 16 }), [b.lon, b.lat]);
  await settle(p);
  await tapAt(p, [b.lon, b.lat]);
  check('tapping one again deselects it', /1 selected/.test(await text(p, '.pickbar')), await text(p, '.pickbar'));
  await tapAt(p, [b.lon, b.lat]);
  await fitBoard(p);

  // Bulk type change, then delete, then undo.
  const busOnlyBefore = stations.filter((s) => s.modes.every((m) => m === 'bus')).length;
  await click(p, '^rail', '.bulk button');
  await p.waitForTimeout(300);
  await click(p, '^None$', '.pickbar button');
  await click(p, '^Bus-only$', '.pickbar button');
  await settle(p);
  const busOnlyAfter = Number((await text(p, '.pickbar')).match(/(\d+) selected/)?.[1]);
  const expectedBusOnly = busOnlyBefore - [a, b].filter((s) => s.modes.every((m) => m === 'bus')).length;
  check('making both "rail" takes them off the bus-only list', busOnlyAfter === expectedBusOnly, { busOnlyBefore, busOnlyAfter, expectedBusOnly });
  check('"Bus-only" selects exactly the bus-only stations', (await rings(p)) === busOnlyAfter, { rings: await rings(p), busOnlyAfter });
  await click(p, '^Delete \\d+$', '.bulk button');
  await p.waitForTimeout(400);
  check('deleting the selection deletes exactly those', (await boardnow(p)).startsWith(`${stations.length - busOnlyAfter} stations`), await boardnow(p));
  await click(p, 'Undo', '.editorhead button');
  await p.waitForTimeout(400);
  check('Undo brings them back', (await boardnow(p)).startsWith(`${stations.length} stations`), await boardnow(p));
  await click(p, 'Undo', '.editorhead button');
  await p.waitForTimeout(300);
  // Undo clears the selection, so there is nothing to deselect first.
  await click(p, '^Bus-only$', '.pickbar button');
  check('…and Undo again takes back the type change', Number((await text(p, '.pickbar')).match(/(\d+) selected/)?.[1]) === busOnlyBefore);
  await click(p, '^None$', '.pickbar button');

  // ------------------------------------------------------------ simplify
  await click(p, '^Find stations to remove$', '.editor button');
  await p.waitForTimeout(800);
  const note = await text(p, '.editor .notice');
  const kept = Number(note.match(/leave (\d+) of/)?.[1]);
  const removing = Number(note.match(/Removing the (\d+)/)?.[1]);
  check('Simplify proposes removals, and only proposes them', kept > 0 && removing === stations.length - kept && (await boardnow(p)).startsWith(`${stations.length} stations`), note.slice(0, 120));
  check('…ringing every station it would remove', (await rings(p)) === removing, { rings: await rings(p), removing });
  // Lock three of the proposed removals, and run it again.
  const proposed = await p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['picked-ring'] }).slice(0, 3).map((f) => f.geometry.coordinates));
  await click(p, '^None$', '.pickbar button');
  for (const ll of proposed) {
    await p.evaluate((x) => window.__map.jumpTo({ center: x, zoom: 16 }), ll);
    await settle(p);
    await tapAt(p, ll);
  }
  await p.check('.editor label.check input');
  await fitBoard(p);
  await click(p, '^Find stations to remove$', '.editor button');
  await p.waitForTimeout(800);
  const lockedStill = await p.evaluate((pts) => {
    const ringed = window.__map.queryRenderedFeatures({ layers: ['picked-ring'] }).map((f) => f.geometry.coordinates.map((n) => n.toFixed(5)).join());
    return pts.filter((c) => ringed.includes(c.map((n) => n.toFixed(5)).join())).length;
  }, proposed);
  check('stations marked to keep are not proposed again', lockedStill === 0, lockedStill);
  await click(p, '^Delete \\d+$', '.bulk button');
  await p.waitForTimeout(600);
  const after = await boardnow(p);
  const left = Number(after.match(/^(\d+) stations/)?.[1]);
  const remaining = await p.evaluate(() => window.__map.getSource('zones').serialize().data.features.map((f) => f.properties.id));
  const keptStations = stations.filter((s) => remaining.includes(s.id));
  const leftOver = overlapPairs(keptStations, 500);
  check('after deleting, the zones left overlap only where a kept station forced it', left === keptStations.length && leftOver <= 3 * 3, { left, leftOver });
  await click(p, 'Undo', '.editorhead button');
  await p.waitForTimeout(400);
  check('Undo restores the whole board', (await boardnow(p)).startsWith(`${stations.length} stations`));

  // ----------------------------------------------------- places, on a city map
  await click(p, 'Close draft', '.editor button');
  await p.waitForSelector('.community h2');
  await start(p, '^Open the San Francisco board$');
  await p.waitForSelector('.editor');
  await click(p, '^Places$', '.tabs button');
  await click(p, '^Museums', '.layeraudit button');
  await p.waitForSelector('.pickbar');
  const museums = Number((await text(p, '.editor h3')).match(/· (\d+)/)?.[1]);
  await click(p, '^Select$', '.pickbar button');
  await click(p, '^All$', '.pickbar button');
  await p.waitForTimeout(300);
  await fitBoard(p);
  check('selecting a whole category rings every place in it', (await rings(p)) === museums && museums > 0, { rings: await rings(p), museums });
  await click(p, '^None$', '.pickbar button');
  // Two museums into Libraries.
  const two = await p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['pois'] }).filter((f) => f.properties.layerKey === 'museums').slice(0, 2).map((f) => f.geometry.coordinates));
  for (const ll of two) {
    await p.evaluate((x) => window.__map.jumpTo({ center: x, zoom: 17 }), ll);
    await settle(p);
    await tapAt(p, ll);
  }
  const picked = Number((await text(p, '.pickbar')).match(/(\d+) selected/)?.[1]);
  await p.selectOption('.bulk select', 'libraries');
  await p.waitForTimeout(400);
  const museumsAfter = Number((await text(p, '.editor h3')).match(/· (\d+)/)?.[1]);
  check('tapped places can be moved to another category', picked === 2 && museumsAfter === museums - 2, { picked, museums, museumsAfter });

  // -------------------------------------------- the size, played in the game
  await click(p, 'Close draft', '.editor button');
  await start(p, '^New stations for San Francisco$');
  await click(p, '^Stations$', '.tabs button');
  await click(p, '^800 m$', '.editor .radiusrow button');
  await click(p, '^Details$', '.tabs button');
  await p.fill('.editor .field input', 'Wide zones');
  await click(p, '^Publish$', '.tabs button');
  await click(p, 'Play on it', '.editor button');
  await p.waitForFunction(() => location.hash === '#/play', null, { timeout: 15000 }).catch(() => {});
  await p.waitForFunction(() => window.__mapReady === true && window.__map?.isStyleLoaded(), null, { timeout: 45000 });
  await p.waitForTimeout(1500);
  const game = await p.evaluate(() => {
    const f = window.__map.getSource('zones').serialize().data.features[0];
    return { id: f.properties.id, c: f.geometry.coordinates[0][0] };
  });
  const gs = stations.find((s) => s.id === game.id);
  check('a map played in the game keeps its zone size', Math.abs(haversine([gs.lon, gs.lat], game.c) - 800) <= 2, Math.round(haversine([gs.lon, gs.lat], game.c)));

  check('no page errors', errors.length === 0, errors.slice(0, 3));
  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('verify:studio crashed:', e); process.exit(1); });
