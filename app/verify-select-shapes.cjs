// Verification for the studio's selection shapes (MapView `shapeTool`,
// studio/select.ts): rectangle and lasso dragged with a mouse and with a
// finger, polygon tapped out, add and remove, points and zones.
//
// What a shape selected is checked against an independent count: the
// shape's corners are read back from the map, and the stations inside are
// counted here with a plain ray-casting test. Also checked: the map does not
// pan while a shape is being drawn, and the shape is drawn as it is dragged.
//
// Needs a built app on :4310. No server needed.
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};

const stations = JSON.parse(readFileSync('public/data/stations.json', 'utf8')).stations;
const inside = ([x, y], ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Metres from a point to the nearest edge of a ring, flat-earth at this latitude: plenty for a few hundred metres. */
const toEdgeM = ([x, y], ring) => {
  const kx = 111_320 * Math.cos((y * Math.PI) / 180), ky = 110_540;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ax = (a[0] - x) * kx, ay = (a[1] - y) * ky, bx = (b[0] - x) * kx, by = (b[1] - y) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
};
const expect = (ring, zoneM) => stations.filter((s) => inside([s.lon, s.lat], ring) || (zoneM && toEdgeM([s.lon, s.lat], ring) <= zoneM)).length;

const click = (p, re, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find((e) => new RegExp(t).test(e.textContent || '') && !e.disabled);
  if (!el) throw new Error(`no enabled ${s} matching ${t}`);
  el.click();
}, [re, sel]);
const selected = async (p) => Number((await p.textContent('.pickbar')).match(/(\d+) selected/)?.[1]);
const centre = (p) => p.evaluate(() => { const c = window.__map.getCenter(); return [+c.lng.toFixed(6), +c.lat.toFixed(6)]; });
/** Screen points (page pixels) to map coordinates, the way the app reads them. */
const toMap = (p, pts) => p.evaluate((pts) => {
  const r = window.__map.getCanvasContainer().getBoundingClientRect();
  return pts.map(([x, y]) => { const ll = window.__map.unproject([x - r.left, y - r.top]); return [ll.lng, ll.lat]; });
}, pts);
// The canvas, not its container: MapLibre's container is zero pixels tall, with the canvas overflowing it.
const mapBox = (p) => p.evaluate(() => { const r = window.__map.getCanvas().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

async function openStations(p) {
  await p.goto(origin + '#/maps/new');
  await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
  await click(p, '^New stations for San Francisco$', '.community button');
  await click(p, '^Stations$', '.tabs button');
  await p.waitForSelector('.pickbar');
  await click(p, '^Select$', '.pickbar button');
  await p.waitForTimeout(500);
}

async function mouseDrag(p, path) {
  await p.mouse.move(...path[0]);
  await p.mouse.down();
  for (const pt of path.slice(1)) await p.mouse.move(pt[0], pt[1], { steps: 4 });
  const during = await p.evaluate(() => window.__map.getSource('shape').serialize().data.features.length);
  await p.mouse.up();
  await p.waitForTimeout(300);
  return during;
}

async function touchDrag(cdp, path) {
  const pt = ([x, y]) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(path[0]) });
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    for (let k = 1; k <= 4; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt([a[0] + ((b[0] - a[0]) * k) / 4, a[1] + ((b[1] - a[1]) * k) / 4]) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  console.log('target:', origin, '\n');
  const browser = await chromium.launch();

  // ------------------------------------------------------------ desktop, mouse
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.accept());
    await openStations(p);
    const box = await mapBox(p);
    const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];

    // Rectangle, points.
    await click(p, 'Rectangle', '.pickbar .shapes button');
    const before = await centre(p);
    const [a, b] = [at(0.35, 0.3), at(0.6, 0.55)];
    const during = await mouseDrag(p, [a, [b[0], a[1]], b]);
    const ring = await toMap(p, [a, [b[0], a[1]], b, [a[0], b[1]]]);
    const want = expect(ring);
    check('a rectangle is drawn while it is dragged', during === 1, during);
    check('dragging a rectangle does not pan the map', JSON.stringify(await centre(p)) === JSON.stringify(before), { before, after: await centre(p) });
    check('a dragged rectangle selects exactly the stations inside it', (await selected(p)) === want && want > 3, { selected: await selected(p), inside: want });
    const ringed = await p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['picked-ring'] }).length);
    check('…and rings them', ringed === want, ringed);
    check('the drawn shape goes once the selection is made', (await p.evaluate(() => window.__map.getSource('shape').serialize().data.features.length)) === 0);

    // Remove: a smaller rectangle inside takes its stations back out.
    await click(p, 'Remove', '.pickbar .shapes button');
    const [c, d] = [at(0.4, 0.35), at(0.5, 0.45)];
    await mouseDrag(p, [c, d]);
    const inner = expect(await toMap(p, [c, [d[0], c[1]], d, [c[0], d[1]]]));
    check('“Remove” takes out what a second shape covers', (await selected(p)) === want - inner && inner > 0, { selected: await selected(p), want: want - inner });

    // Zones: the same rectangle also catches stations whose 500 m zone reaches into it.
    await click(p, '^None$', '.pickbar button');
    await click(p, 'Add', '.pickbar .shapes button');
    await click(p, '^Zones$', '.pickbar .shapes button');
    await mouseDrag(p, [a, b]);
    const wantZones = expect(ring, 500);
    check('with Zones, stations whose zone reaches the rectangle are selected too', Math.abs((await selected(p)) - wantZones) <= 1 && wantZones > want, { selected: await selected(p), expected: wantZones, pointsOnly: want });
    await click(p, '^Points$', '.pickbar .shapes button');

    // Lasso: a triangle, freehand.
    await click(p, '^None$', '.pickbar button');
    await click(p, 'Lasso', '.pickbar .shapes button');
    const tri = [at(0.3, 0.7), at(0.5, 0.25), at(0.7, 0.7), at(0.31, 0.71)];
    await mouseDrag(p, tri);
    const wantTri = expect(await toMap(p, tri));
    check('a lasso selects the stations inside the loop drawn', (await selected(p)) === wantTri && wantTri > 3, { selected: await selected(p), inside: wantTri });

    // Polygon: four corners tapped, then Done.
    await click(p, '^None$', '.pickbar button');
    await click(p, 'Polygon', '.pickbar .shapes button');
    const quad = [at(0.2, 0.2), at(0.45, 0.25), at(0.5, 0.6), at(0.22, 0.55)];
    for (const q of quad) { await p.mouse.click(q[0], q[1]); await p.waitForTimeout(150); }
    check('polygon corners are counted as they are tapped', /4 corners/.test(await p.textContent('.pickbar')), (await p.textContent('.pickbar')).match(/\d+ corners?/)?.[0]);
    await click(p, '^Done$', '.pickbar button');
    await p.waitForTimeout(300);
    const wantQuad = expect(await toMap(p, quad));
    check('a tapped-out polygon selects the stations inside it', (await selected(p)) === wantQuad && wantQuad > 3, { selected: await selected(p), inside: wantQuad });

    // In a shape mode, a plain tap on a station still toggles it.
    await click(p, 'Rectangle', '.pickbar .shapes button');
    await click(p, '^None$', '.pickbar button');
    const s = stations[25];
    await p.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 16 }), [s.lon, s.lat]);
    await p.waitForTimeout(800);
    const pt = await p.evaluate((ll) => { const r = window.__map.getCanvasContainer().getBoundingClientRect(); const q = window.__map.project(ll); return [r.left + q.x, r.top + q.y]; }, [s.lon, s.lat]);
    await p.mouse.click(pt[0], pt[1]);
    await p.waitForTimeout(300);
    check('with a shape tool on, a single tap still selects one station', (await selected(p)) === 1, await selected(p));

    // Leaving Select mode gives the map its dragging back.
    await click(p, 'Selecting', '.pickbar button');
    const c0 = await centre(p);
    await p.mouse.move(700, 450); await p.mouse.down(); await p.mouse.move(820, 520, { steps: 6 }); await p.mouse.up();
    await p.waitForTimeout(400);
    check('out of Select mode, dragging pans the map again', JSON.stringify(await centre(p)) !== JSON.stringify(c0));
    // Places, on a full city map: museums, by rectangle.
    await click(p, 'Close draft', '.editor button');
    await p.waitForSelector('.community h2');
    await click(p, '^Open the San Francisco board$', '.community button');
    await click(p, '^Places$', '.tabs button');
    await click(p, '^Museums', '.layeraudit button');
    await click(p, '^Select$', '.pickbar button');
    await click(p, 'Rectangle', '.pickbar .shapes button');
    // An earlier check zoomed in on one station; look at the whole city again.
    await p.evaluate(async () => {
      const [w, so, e, n] = await (await fetch('data/bbox.json')).json();
      window.__map.fitBounds([[w, so], [e, n]], { padding: 20, animate: false });
    });
    await p.waitForTimeout(800);
    const [m0, m1] = [at(0.45, 0.15), at(0.95, 0.6)];
    await mouseDrag(p, [m0, m1]);
    const mRing = await toMap(p, [m0, [m1[0], m0[1]], m1, [m0[0], m1[1]]]);
    const museums = JSON.parse(readFileSync('public/data/poi-museums.geojson', 'utf8')).features;
    const wantM = museums.filter((f) => inside(f.geometry.coordinates, mRing)).length;
    check('a rectangle on the Places tab selects the places inside it', (await selected(p)) === wantM && wantM > 3, { selected: await selected(p), inside: wantM });

    check('no page errors (desktop)', errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  // ------------------------------------------------------------ phone, finger
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await openStations(p);
    // The panel takes the lower half of a phone; the map is above it.
    await click(p, 'Rectangle', '.pickbar .shapes button');
    const box = await mapBox(p);
    const visibleH = Math.min(box.h, (await p.evaluate(() => document.querySelector('.sheet').getBoundingClientRect().top)) - box.y);
    const at = (fx, fy) => [Math.round(box.x + box.w * fx), Math.round(box.y + visibleH * fy)];
    const before = await centre(p);
    const [a, b] = [at(0.15, 0.2), at(0.85, 0.8)];
    await touchDrag(cdp, [a, [b[0], a[1]], b]);
    await p.waitForTimeout(400);
    const want = expect(await toMap(p, [a, [b[0], a[1]], b, [a[0], b[1]]]));
    check('on a phone, a finger drags out a rectangle instead of panning', JSON.stringify(await centre(p)) === JSON.stringify(before), { before, after: await centre(p) });
    check('…and it selects exactly the stations inside', (await selected(p)) === want && want > 3, { selected: await selected(p), inside: want });

    await click(p, '^None$', '.pickbar button');
    await click(p, 'Lasso', '.pickbar .shapes button');
    const tri = [at(0.2, 0.8), at(0.5, 0.15), at(0.8, 0.8), at(0.21, 0.81)];
    await touchDrag(cdp, tri);
    await p.waitForTimeout(400);
    const wantTri = expect(await toMap(p, tri));
    check('a finger lasso selects the stations inside the loop', (await selected(p)) === wantTri && wantTri > 3, { selected: await selected(p), inside: wantTri });
    check('no page errors (phone)', errors.length === 0, errors.slice(0, 3));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('verify:shapes crashed:', e); process.exit(1); });
