// Takes the landing page's other hero pictures: one city map each,
// photographed the way shot:landing photographs San Francisco — the studio's
// map alone, the board's zones and stations over the streets, nothing else.
// Writes public/marketing/hero-<city>.jpg.
//
// Each city comes from its map file (Marketing/maps/<city>.jetleg-map.json by
// default, or MAPS_DIR), opened in the studio exactly as "Import map file"
// opens one, so nothing has to be published anywhere.
//
//   npm run build && npx vite preview --port 4310     (in another terminal)
//   npm run shot:heroes
//
// Needs a connection: the streets underneath are basemap tiles. Like
// shot:landing, it refuses to save a picture of a board that did not draw.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const mapsDir = process.env.MAPS_DIR || path.join(__dirname, '..', '..', 'Marketing', 'maps');
const outDir = path.join(__dirname, '..', 'public', 'marketing');
const CITIES = ['paris', 'london', 'chicago', 'tokyo', 'toronto'];
const WIDTH = 1600;
const HEIGHT = 1000;

const extent = (geometry) => {
  const pts = (geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat()).flat();
  const xs = pts.map((c) => c[0]), ys = pts.map((c) => c[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
};

async function shoot(browser, city) {
  const file = path.join(mapsDir, `${city}.jetleg-map.json`);
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await p.goto(origin + '#/maps', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await p.setInputFiles('.community input[type=file]', file);
  await p.waitForSelector('.editor', { timeout: 20000 });

  // Only the map: no top bar, no tool panel, no map buttons.
  await p.addStyleTag({
    content: `
      .app.studio { grid-template-columns: 1fr !important; grid-template-rows: 1fr !important; }
      .topbar, .sheet, .maplibregl-control-container, .maptools { display: none !important; }
    `,
  });
  await p.evaluate((b) => {
    window.__map.resize();
    window.__map.fitBounds(b, { padding: 48, animate: false });
  }, extent(map.boundary.geometry ?? map.boundary));

  const tiles = await p.waitForFunction(() => window.__map.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 60000 })
    .then(() => true, () => false);
  await p.waitForTimeout(1500);
  const drew = await p.evaluate(() => ({
    zones: window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length,
    stations: window.__map.queryRenderedFeatures({ layers: ['stations-dot'] }).length,
    basemap: window.__map.queryRenderedFeatures().filter((f) => f.sourceLayer).length,
  }));
  console.log(`${city}: drew ${JSON.stringify(drew)} of ${map.stations.length} stations`, tiles ? '' : '(basemap tiles never finished loading)');
  if (!drew.zones || !drew.stations) throw new Error(`${city}: the board did not draw; not saving a picture of an empty map.`);
  if (!tiles || !drew.basemap) throw new Error(`${city}: the basemap did not load; the picture would have no streets.`);

  const out = path.join(outDir, `hero-${city}.jpg`);
  await p.locator('.map').screenshot({ path: out, type: 'jpeg', quality: 78 });
  console.log('saved', out);
  await ctx.close();
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const city of (process.env.CITIES ? process.env.CITIES.split(',') : CITIES)) await shoot(browser, city);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('shot:heroes failed:', e.message ?? e); process.exit(1); });
