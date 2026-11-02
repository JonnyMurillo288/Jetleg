// Retakes the landing page's picture of the built-in board: public/landing-sf.jpg.
//
// The landing page shows a still, not a live map (src/pages/Landing.tsx), so
// this is the one place that image comes from. It opens the map studio —
// which draws the board itself, with no round, no location and no paywall —
// hides everything but the map, and photographs it.
//
//   npm run build && npx vite preview --port 4310     (in another terminal)
//   npm run shot:landing
//
// Needs a connection: the streets underneath are basemap tiles. It refuses to
// save a picture of an empty board, because a blank map throws nothing.
const { chromium } = require('playwright');
const path = require('node:path');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const out = path.join(__dirname, '..', 'public', 'landing-sf.jpg');
const WIDTH = 1600;
const HEIGHT = 1000;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto(origin + '#/maps', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });

  // Only the map: no top bar, no tool panel, no map buttons.
  await p.addStyleTag({
    content: `
      .app.studio { grid-template-columns: 1fr !important; grid-template-rows: 1fr !important; }
      .topbar, .sheet, .maplibregl-control-container { display: none !important; }
    `,
  });
  const bbox = await (await p.request.get(origin + 'data/bbox.json')).json();
  await p.evaluate(([w, s, e, n]) => {
    window.__map.resize();
    window.__map.fitBounds([[w, s], [e, n]], { padding: 48, animate: false });
  }, bbox);

  // Streets and labels arrive over the network; wait for them rather than for a guess at how long they take.
  const tiles = await p.waitForFunction(() => window.__map.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 60000 })
    .then(() => true, () => false);
  await p.waitForTimeout(1500);

  const drew = await p.evaluate(() => ({
    zones: window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length,
    stations: window.__map.queryRenderedFeatures({ layers: ['stations-dot'] }).length,
    // Only tiles have a source layer; the board's own layers are GeoJSON.
    basemap: window.__map.queryRenderedFeatures().filter((f) => f.sourceLayer).length,
  }));
  console.log('drew:', JSON.stringify(drew), tiles ? '' : '(basemap tiles never finished loading)');
  if (!drew.zones || !drew.stations) throw new Error('The board did not draw; not saving a picture of an empty map.');
  if (!tiles || !drew.basemap) throw new Error('The basemap did not load; the picture would have no streets. Check the connection and try again.');

  await p.locator('.map').screenshot({ path: out, type: 'jpeg', quality: 82 });
  await browser.close();
  console.log('saved', out);
})().catch((e) => { console.error('shot:landing failed:', e.message ?? e); process.exit(1); });
