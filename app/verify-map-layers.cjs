// Verification for the layers controls on the map: the studio's
// (studio/StudioLayers.tsx) and the game's Places section (ui/MapLayers.tsx).
// Every switch is checked by asking MapLibre what it drew, not by reading
// the checkbox back.
//
// Needs a built app on :4310. No server needed.
const { chromium } = require('playwright');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
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
/** Tick or untick the panel's row whose label starts with `label`. */
const tick = (p, panel, label) => p.evaluate(([panel, label]) => {
  const row = [...document.querySelectorAll(`${panel} .maplayers-panel label`)].find((l) => l.querySelector('span')?.firstChild?.textContent?.trim() === label);
  if (!row) throw new Error(`no layer row "${label}"`);
  row.querySelector('input').click();
}, [panel, label]);
const settle = (p) => p.waitForTimeout(500);
/** What the map drew: features per layer, and places per category. */
const drew = (p) => p.evaluate(() => {
  const n = (id) => window.__map.queryRenderedFeatures({ layers: [id] }).length;
  const places = {};
  for (const f of window.__map.queryRenderedFeatures({ layers: ['pois'] })) places[f.properties.layerKey] = (places[f.properties.layerKey] || 0) + 1;
  const cells = {};
  for (const f of window.__map.queryRenderedFeatures({ layers: ['voronoi-fill'] })) cells[f.properties.layer] = (cells[f.properties.layer] || 0) + 1;
  return { stations: n('stations-dot'), hits: n('stations-hit'), zones: n('zones-alive'), places, cells };
});

(async () => {
  console.log('target:', origin, '\n');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());

  // ------------------------------------------------------------ the studio
  await p.goto(origin + '#/maps/new');
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await start(p, '^New stations for San Francisco$');
  await p.waitForSelector('.editor');
  await settle(p);
  let d = await drew(p);
  check('the studio starts with stations and zones, and no places', d.stations > 0 && d.zones > 0 && Object.keys(d.places).length === 0, d);

  await click(p, '^Layers', '.studio-layers button');
  await tick(p, '.studio-layers', 'Station points');
  await settle(p);
  d = await drew(p);
  check('turning off station points hides them, and their tap targets', d.stations === 0 && d.hits === 0 && d.zones > 0, d);
  await tick(p, '.studio-layers', 'Hiding zones');
  await settle(p);
  d = await drew(p);
  check('turning off hiding zones hides them too', d.zones === 0, d);

  await tick(p, '.studio-layers', 'Parks');
  await settle(p);
  d = await drew(p);
  check('turning on Parks draws the parks, and nothing else', d.places.parks > 0 && Object.keys(d.places).length === 1, d.places);
  await tick(p, '.studio-layers', 'Aquariums');
  await settle(p);
  d = await drew(p);
  check('a second category joins the first', d.places.parks > 0 && d.places.aquariums > 0 && Object.keys(d.places).length === 2, d.places);
  await tick(p, '.studio-layers', 'Parks');
  await settle(p);
  d = await drew(p);
  check('and each can be turned off on its own', !d.places.parks && d.places.aquariums > 0, d.places);

  await p.evaluate(() => [...document.querySelectorAll('.studio-layers .maplayers-section')].find((s) => /Voronoi/.test(s.textContent)));
  const cellRow = await p.evaluate(() => [...document.querySelectorAll('.studio-layers .maplayers-panel .maplayers-scroll')][1].querySelector('label span').firstChild.textContent.trim());
  await p.evaluate(() => [...document.querySelectorAll('.studio-layers .maplayers-panel .maplayers-scroll')][1].querySelector('input').click());
  await settle(p);
  d = await drew(p);
  check(`Voronoi cells can be turned on by category (${cellRow})`, Object.keys(d.cells).length === 1 && Object.values(d.cells)[0] > 0, d.cells);
  await click(p, '^Clear cells$', '.studio-layers .maplayers-section button');
  await settle(p);
  d = await drew(p);
  check('…and all cleared at once', Object.keys(d.cells).length === 0, d.cells);
  await click(p, '^All$', '.studio-layers .maplayers-section button');
  await settle(p);
  d = await drew(p);
  check('"All" places draws every category', Object.keys(d.places).length >= 6, Object.keys(d.places));

  // The category being edited stays on, whatever the switch says.
  await click(p, '^None$', '.studio-layers .maplayers-section button');
  await click(p, 'Close draft', '.editor button');
  await start(p, '^Open the San Francisco board$');
  await click(p, '^Places$', '.tabs button');
  await click(p, '^Museums', '.layeraudit button');
  await settle(p);
  d = await drew(p);
  const locked = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.studio-layers .maplayers-panel label')].find((l) => l.querySelector('span')?.firstChild?.textContent?.trim() === 'Museums');
    return row ? { checked: row.querySelector('input').checked, disabled: row.querySelector('input').disabled } : null;
  });
  check('the category being edited stays drawn, and says so', d.places.museums > 0 && locked?.checked && locked?.disabled, { places: d.places, locked });

  // ------------------------------------------------------------ the game
  await p.goto(origin + '#/play');
  await p.reload();
  await p.waitForFunction(() => window.__mapReady === true && window.__map?.isStyleLoaded(), null, { timeout: 45000 });
  await settle(p);
  await click(p, '^Layers', '.maptools button');
  const sections = await p.evaluate(() => [...document.querySelectorAll('.maplayers-panel .maplayers-section')].map((s) => s.firstChild.textContent.trim()));
  check('the game’s map control now lists places too', sections.includes('Places'), sections);
  await tick(p, '.maptools', 'Parks');
  await settle(p);
  d = await drew(p);
  check('turning on Parks in the game draws the parks', d.places.parks > 0, d.places);
  await click(p, '^Layers', '.maptools button');
  await click(p, '^Map$', '.topbar button');
  const mapTab = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.list.layers label')].find((l) => /Parks/.test(l.textContent));
    return row?.querySelector('input')?.checked ?? null;
  });
  check('…the same switch as the Map tab’s, so the two agree', mapTab === true, mapTab);

  check('no page errors', errors.length === 0, errors.slice(0, 3));
  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('verify:layers crashed:', e); process.exit(1); });
