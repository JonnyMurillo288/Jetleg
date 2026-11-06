// Verification for the in-game chat, through the UI. Two real browsers — a
// seeker and a hider, each in a round — play questions the way players
// would, and every claim is checked where it would fail:
//
//   - the clock really counts down on the hider's screen (read twice)
//   - nothing is answered until the hider taps: no answer leaves the
//     hider's browser before then (its socket frames are read)
//   - the answer reaches the seeker, lands in the seeker's ask log once
//     (and still once after a reload), and moves the zone count
//   - a question asked while the hider's app was closed arrives when it opens
//   - a photo taken with a GPS tag in it leaves the hider's phone with no
//     metadata (the pieces it sent are reassembled and read), and the copy
//     the seeker keeps has none either
//   - nothing goes to a database or a bucket — no request for it is made
//   - the game file carries the chat and the photo; deleting the rounds that
//     name the game deletes both from the phone
//
// verify-chat.ts proves the relay keeps nothing. This proves the app.
//
// Needs `supabase start`, the testing code (supabase/functions/.env), and a
// built app on :4310 (`npm run build && npx vite preview --port 4310`).
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const TEST_CODE = process.env.TEST_LOGIN_CODE ||
  (fs.existsSync('../supabase/functions/.env') ? (fs.readFileSync('../supabase/functions/.env', 'utf8').match(/^TEST_LOGIN_CODE=(\S+)/m) || [])[1] : '') || '';
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(tmpdir(), 'jetleg-chat-'));
const TARGET = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');

const SEEKER_AT = { latitude: 37.7793, longitude: -122.4194 }; // Civic Center
const HIDER_AT = { latitude: 37.7694, longitude: -122.4477 };  // must never leave the hider's browser

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
  if (!ok) fail.push(name);
};

const clickText = (p, text, sel = 'button') => p.evaluate(([t, s]) => {
  const el = [...document.querySelectorAll(s)].find(e => new RegExp(t, 'i').test(e.textContent || ''));
  if (!el) throw new Error('no element matching ' + t + ' in ' + s);
  el.click();
}, [text, sel]);
const waitText = (p, sel, re, timeout = 15000) =>
  p.waitForFunction(([s, r]) => [...document.querySelectorAll(s)].some(e => new RegExp(r).test(e.textContent || '')), [sel, re], { timeout })
    .then(() => true, () => false);
/** Polls a Node-side condition (frames, IndexedDB) until it holds. */
const until = async (p, fn, ms = 10000) => {
  for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await p.waitForTimeout(250); }
  return false;
};

/** An EXIF APP1 segment carrying a GPS IFD, the way a phone camera writes one. */
function exifGps(lat, lon) {
  const tiff = Buffer.alloc(128);
  tiff.write('II*\0', 0, 'latin1'); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // IFD0: one entry, the GPS pointer
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(4, 26); // GPS IFD: four entries
  const entry = (at, tag, type, count, value) => { tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2); tiff.writeUInt32LE(count, at + 4); value(at + 8); };
  entry(28, 1, 2, 2, (o) => tiff.write(lat >= 0 ? 'N\0' : 'S\0', o, 'latin1'));
  entry(40, 2, 5, 3, (o) => tiff.writeUInt32LE(80, o));
  entry(52, 3, 2, 2, (o) => tiff.write(lon >= 0 ? 'E\0' : 'W\0', o, 'latin1'));
  entry(64, 4, 5, 3, (o) => tiff.writeUInt32LE(104, o));
  tiff.writeUInt32LE(0, 76);
  const dms = (v, at) => {
    const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 100);
    [[d, 1], [m, 1], [s, 100]].forEach(([n, den], i) => { tiff.writeUInt32LE(n, at + i * 8); tiff.writeUInt32LE(den, at + i * 8 + 4); });
  };
  dms(lat, 80); dms(lon, 104);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
}
const metadataIn = (buf) => ({ exif: buf.includes(Buffer.from('Exif\0\0', 'latin1')), tiff: buf.includes(Buffer.from('II*\0', 'latin1')) || buf.includes(Buffer.from('MM\0*', 'latin1')) });

/**
 * Broadcasts a page sent on its socket, as { topic, event, payload }.
 *
 * realtime-js sends a user broadcast as a *binary* frame, not the JSON array
 * every other message uses (lib/serializer.js, `_encodeUserBroadcastPush`):
 * a kind byte (3), five length bytes (join ref, ref, topic, event, metadata),
 * an encoding byte (1 = JSON), then those strings and the payload. Reading
 * frames as text sees none of them — and a "nothing was sent" check passes.
 */
function broadcastsIn(frames) {
  const out = [];
  for (const f of frames) {
    if (typeof f === 'string') {
      let m; try { m = JSON.parse(f); } catch { continue; }
      if (Array.isArray(m) && m[3] === 'broadcast' && m[4]) out.push({ topic: m[2], event: m[4].event, payload: m[4].payload });
      continue;
    }
    const b = Buffer.from(f);
    if (b[0] !== 3 || b[6] !== 1) continue;
    let o = 7 + b[1] + b[2];
    const topic = b.toString('utf8', o, o + b[3]); o += b[3];
    const event = b.toString('utf8', o, o + b[4]); o += b[4] + b[5];
    try { out.push({ topic, event, payload: JSON.parse(b.toString('utf8', o)) }); } catch { /* not ours */ }
  }
  return out;
}
/** A photo, put back together from the pieces a page sent. */
function photoFrom(frames, questionId) {
  const pieces = broadcastsIn(frames).filter(b => b.event === 'pc' && b.payload.questionId === questionId).map(b => b.payload);
  if (!pieces.length) return null;
  const byIndex = new Map(pieces.map(p => [p.index, p.data]));
  if (byIndex.size !== pieces[0].total) return null;
  return Buffer.concat([...byIndex.keys()].sort((a, b) => a - b).map(i => Buffer.from(byIndex.get(i), 'base64')));
}

/** This app's IndexedDB (idb-keyval's default store), read from inside the page. */
const idbKeys = (p) => p.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('keyval-store');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction('keyval', 'readonly').objectStore('keyval').getAllKeys();
    req.onsuccess = () => resolve(req.result.filter(k => typeof k === 'string'));
  };
}));
const idbBytes = (p, key) => p.evaluate((key) => new Promise((resolve) => {
  const open = indexedDB.open('keyval-store');
  open.onsuccess = () => {
    const req = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(key);
    req.onsuccess = async () => {
      const v = req.result;
      if (!(v instanceof Blob)) return resolve(null);
      const b = new Uint8Array(await v.arrayBuffer());
      let s = ''; for (const x of b) s += String.fromCharCode(x);
      resolve(btoa(s));
    };
  };
}), key).then(b64 => b64 && Buffer.from(b64, 'base64'));

async function player(browser, at, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript((where) => {
    const fix = () => ({ coords: { ...where, accuracy: 15 }, timestamp: Date.now() });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: cb => setTimeout(() => cb(fix()), 50), watchPosition: cb => { setTimeout(() => cb(fix()), 50); return 1; }, clearWatch: () => {} },
    });
  }, at);
  const pl = { ctx, name, frames: [], requests: [], errors: [], p: null };
  /** Opens the app in a new tab of the same browser — same storage, as reopening it on a phone. */
  pl.open = async () => {
    const p = await ctx.newPage();
    p.on('websocket', ws => ws.on('framesent', f => pl.frames.push(f.payload)));
    p.on('request', r => pl.requests.push(`${r.method()} ${r.url()}`));
    p.on('pageerror', e => pl.errors.push(`${name}: ${e.message}`));
    p.on('dialog', d => d.accept());
    await p.goto(TARGET + '#/play', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
    pl.p = p;
    return p;
  };
  await pl.open();
  return pl;
}

async function startRound(pl, role, email) {
  await clickText(pl.p, `^${role}$`, '.topbar button');
  await pl.p.waitForTimeout(1500);
  await clickText(pl.p, 'Start a new round');
  await pl.p.waitForSelector('.accountbox input[type="email"]', { timeout: 10000 });
  await pl.p.fill('.accountbox input[type="email"]', email);
  await clickText(pl.p, 'I have a testing code');
  await pl.p.fill('.accountbox input.code', TEST_CODE);
  await clickText(pl.p, '^Sign in$');
  await pl.p.waitForFunction(() => !/Play in a game room/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 20000 });
  await clickText(pl.p, 'Start a new round');
}

(async () => {
  if (!TEST_CODE) {
    console.log('SKIP  everything: asking and answering need a round, and a round needs the testing code (supabase/functions/.env)');
    process.exit(0);
  }
  console.log('target:', TARGET, '\nscreenshots:', shots, '\n');
  const browser = await chromium.launch();
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const stamp = Date.now();
  const emails = [`chat-seeker-${stamp}@example.com`, `chat-hider-${stamp}@example.com`];
  for (const email of emails) {
    await admin.from('developers').upsert({ email, note: 'verify:chat:ui' });
    await admin.from('test_logins').upsert({ email, note: 'verify:chat:ui' });
  }

  const seeker = await player(browser, SEEKER_AT, 'seeker');
  const hider = await player(browser, HIDER_AT, 'hider');
  try {
    await startRound(seeker, 'Seeker', emails[0]);
    await seeker.p.waitForSelector('.qlist', { timeout: 15000 });
    await startRound(hider, 'Hider', emails[1]);
    await hider.p.waitForSelector('.seekerpin', { timeout: 15000 });
    check('both players are in a round', true);

    // ---- the room
    check('there is no Chat button outside a game', !(await seeker.p.$('.chatbtn')));
    await seeker.p.click('.gamebtn');
    await seeker.p.fill('.gameroom .field input', 'Sam');
    await seeker.p.fill('.gameroom input[placeholder="Your team\'s name"]', 'Blue');
    await clickText(seeker.p, 'Create game');
    await seeker.p.waitForSelector('.gamecode strong', { timeout: 15000 });
    const code = (await seeker.p.textContent('.gamecode strong')).trim();
    await hider.p.click('.gamebtn');
    await hider.p.fill('.gameroom .field input', 'Hana');
    await hider.p.fill('.gameroom input.code', code);
    await clickText(hider.p, 'Find game');
    await hider.p.waitForSelector('.gameroom .hint.fact .list', { timeout: 15000 });
    await hider.p.fill('.gameroom input[placeholder="Or a new team\'s name"]', 'Red');
    await clickText(hider.p, 'Add team');
    await hider.p.waitForSelector('.gamecode strong', { timeout: 15000 });
    check('in a game, a Chat button appears next to it', !!(await seeker.p.$('.chatbtn')) && !!(await hider.p.$('.chatbtn')));
    const gpsrow = await seeker.p.evaluate(() => { const r = document.querySelector('.topbar-row'); return { scroll: r.scrollWidth, client: r.clientWidth, page: document.documentElement.scrollWidth }; });
    check('the top bar still fits a 390 px phone with Chat in it', gpsrow.scroll <= gpsrow.client && gpsrow.page <= 390, JSON.stringify(gpsrow));
    const { data: game } = await admin.from('games').select('id').eq('join_code', code).single();
    for (const pl of [seeker, hider]) {
      const joined = await until(pl.p, () => broadcastsIn(pl.frames).some(b => b.topic === `realtime:chat:${game.id}` && b.event === 'hello'));
      check(`the ${pl.name}’s chat is joined (its hello went out)`, joined);
    }

    // ---- a matching question, asked from the chat
    const zonesBefore = Number(await seeker.p.textContent('.topbar .count strong'));
    await seeker.p.click('.chatbtn');
    await seeker.p.waitForSelector('.askcomposer select', { timeout: 10000 });
    // The blank in "is your nearest park the same as mine?", filled in: the
    // seeker's own nearest park, worked out here from the park data itself,
    // independently of the app's engine.
    const parks = JSON.parse(fs.readFileSync('public/data/poi-parks.geojson', 'utf8')).features;
    const metres = ([lon, lat]) => {
      const R = 6371000, r = Math.PI / 180, dLat = (lat - SEEKER_AT.latitude) * r, dLon = (lon - SEEKER_AT.longitude) * r;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(SEEKER_AT.latitude * r) * Math.cos(lat * r) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    const nearestPark = parks.reduce((best, f) => (metres(f.geometry.coordinates) < metres(best.geometry.coordinates) ? f : best)).properties.name;
    await seeker.p.selectOption('.askcomposer select', 'match-park');
    check('before asking, the seeker sees which park they will be naming', (await seeker.p.textContent('.askcomposer .subject')).includes(`Your nearest park: ${nearestPark}`), await seeker.p.textContent('.askcomposer .subject'));
    await clickText(seeker.p, '^Ask ·', '.askcomposer button');
    const asked = await seeker.p.waitForSelector('.cq.waiting[data-question="match-park"]', { timeout: 15000 }).then(() => true, () => false);
    check('the seeker’s question appears with its clock', asked && /\d:\d\d/.test(await seeker.p.textContent('.cq.waiting [role=timer]')));
    check('...naming the park on the card', (await seeker.p.textContent('.cq.waiting[data-question="match-park"] .subject')).includes(`Your nearest park: ${nearestPark}`));
    // Measuring names one too, with how far away it is — previewed, not asked.
    await clickText(seeker.p, '^Measuring', '.askcomposer .chip');
    await seeker.p.selectOption('.askcomposer select', 'meas-library');
    const measuring = await seeker.p.textContent('.askcomposer .subject');
    check('a measuring question names the seeker’s nearest library and how far it is', /Your nearest library: .+ · [\d.,]+ (mi|ft) away/.test(measuring), measuring);
    await seeker.p.screenshot({ path: path.join(shots, 'seeker-measuring-preview.png') });
    await seeker.p.selectOption('.askcomposer select', '');

    const badge = await hider.p.waitForFunction(() => document.querySelector('.chatbtn.owed .badge')?.textContent === '1', null, { timeout: 15000 }).then(() => true, () => false);
    check('the hider’s Chat button shows one question owed, before opening it', badge);
    await (await hider.p.$('.topbar-row')).screenshot({ path: path.join(shots, 'hider-owed-button.png') });
    await hider.p.click('.chatbtn');
    await hider.p.waitForSelector('.cq.waiting[data-question="match-park"] [role=timer]', { timeout: 15000 });
    const t1 = await hider.p.textContent('.cq.waiting [role=timer]');
    await hider.p.waitForTimeout(2200);
    const t2 = await hider.p.textContent('.cq.waiting [role=timer]');
    const secs = (t) => { const [m, s] = t.replace(/[^\d:]/g, '').split(':').map(Number); return m * 60 + s; };
    check('the hider’s clock counts down', secs(t1) - secs(t2) >= 1 && secs(t1) <= 300 && secs(t1) > 280, `${t1} → ${t2}`);
    const named = await hider.p.textContent('.cq.waiting[data-question="match-park"] .subject');
    check('the hider sees which park the seeker named — the seeker’s real nearest', named.includes(`Sam’s nearest park: ${nearestPark}`), named);
    check('the hider sees what the assistant reads, as a hint', /nearest park/i.test(await hider.p.textContent('.cq.waiting .answerbox .hint')));
    check('...and the Hit / Miss buttons, in those words', /Hit/.test(await hider.p.textContent('.cq.waiting .answerbox')) && /Miss/.test(await hider.p.textContent('.cq.waiting .answerbox')));
    await hider.p.screenshot({ path: path.join(shots, 'hider-question-open.png') });

    const answersSent = () => broadcastsIn(hider.frames).filter(b => b.event === 'q' && b.payload.answer);
    await hider.p.waitForTimeout(3000);
    check('nothing is answered until the hider taps — no answer has left its phone', answersSent().length === 0, answersSent().length);
    const dot = await hider.p.waitForFunction(() => window.__map.getSource('peers').serialize().data.features.some(f => f.properties.name === 'Sam'), null, { timeout: 20000 }).then(() => true, () => false);
    check('the asker’s live dot is on the hider’s map', dot);
    await clickText(hider.p, '^Miss$', '.cq.waiting .answerbox button');
    check('choosing an answer asks to confirm before anything is sent', /Send “Miss”/.test(await hider.p.textContent('.answerbox')) && answersSent().length === 0);
    await clickText(hider.p, '^Send “Miss”', '.answerbox button');
    check('the hider’s card shows the answer it sent', await waitText(hider.p, '.cq.done[data-question="match-park"] .answerchip', '^MISS$'));
    check('...and now exactly one answer has left its phone', answersSent().length === 1 && answersSent()[0].payload.answer.value === 'no', answersSent().length);

    check('the seeker receives “MISS”, live', await waitText(seeker.p, '.cq.done[data-question="match-park"] .answerchip', '^MISS$'));
    check('...with who answered and how long it took', /Hana answered in \d:\d\d/.test(await seeker.p.textContent('.cq.done[data-question="match-park"]')));
    // Poll for the thing that changes: the count, not the chip.
    const moved = await seeker.p.waitForFunction((n) => Number(document.querySelector('.topbar .count strong')?.textContent) < n, zonesBefore, { timeout: 10000 }).then(() => true, () => false);
    const zonesAfter = Number(await seeker.p.textContent('.topbar .count strong'));
    check('the answer is applied: the seeker’s zone count drops', moved, `${zonesBefore} → ${zonesAfter}`);
    const alive = await seeker.p.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['zones-alive'] }).length);
    check('...and the map still draws zones', alive > 0, alive);

    await clickText(seeker.p, '^Play$', '.topbar button');
    check('the answer is in the seeker’s ask log once', await waitText(seeker.p, '.seg button', '^Log \\(1\\)$', 5000));
    await seeker.p.reload({ waitUntil: 'domcontentloaded' });
    await seeker.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
    await seeker.p.waitForTimeout(4000); // catch-up hands the same answer over again
    check('...and still once after a reload, which hands the answer over again', await waitText(seeker.p, '.seg button', '^Log \\(1\\)$', 5000));
    check('...with the zone count kept', Number(await seeker.p.textContent('.topbar .count strong')) === zonesAfter);
    await seeker.p.click('.chatbtn');
    check('the chat is still there after a reload — it is kept on the phone', await waitText(seeker.p, '.cq.done[data-question="match-park"] .answerchip', '^MISS$', 8000));
    await clickText(seeker.p, '^Play$', '.topbar button');

    // ---- the hider's app is closed; a photo question is asked meanwhile
    await hider.p.close();
    await clickText(seeker.p, '^Photo', '.chips button');
    await clickText(seeker.p, '^A Tree', '.qhead');
    await clickText(seeker.p, 'Ask in game chat', '.qbody button');
    check('the catalog row confirms the question went to the chat', await waitText(seeker.p, '.qbody button', 'Asked in chat'));
    await seeker.p.waitForTimeout(1000);
    await hider.open();
    await hider.p.click('.chatbtn');
    const caughtUp = await hider.p.waitForSelector('.cq.waiting[data-question="photo-a-tree"] input[type=file]', { state: 'attached', timeout: 20000 }).then(() => true, () => false);
    check('a question asked while the hider’s app was closed arrives when it opens', caughtUp);

    // A real JPEG, from this browser's own encoder, with a phone camera's GPS tag spliced in.
    const plain = Buffer.from(await hider.p.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const g = c.getContext('2d'); g.fillStyle = '#2f7d32'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#6d4c41'; g.fillRect(300, 250, 40, 230);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }), 'base64');
    const camera = Buffer.concat([plain.subarray(0, 2), exifGps(HIDER_AT.latitude, HIDER_AT.longitude), plain.subarray(2)]);
    check('the fixture really carries EXIF GPS (or the strip checks below are blind)', metadataIn(camera).exif && metadataIn(camera).tiff);
    await hider.p.setInputFiles('.cq.waiting[data-question="photo-a-tree"] input[type=file]', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: camera });
    const pinned = await hider.p.waitForFunction(() => {
      const img = document.querySelector('.cq.done[data-question="photo-a-tree"] .photothumb img');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 30000 }).then(() => true, () => false);
    check('the photo is pinned to its question on the hider’s screen, and loads', pinned);

    const photoQ = broadcastsIn(hider.frames).find(b => b.event === 'q' && b.payload.questionId === 'photo-a-tree' && b.payload.answer);
    const sentPhoto = photoQ && photoFrom(hider.frames, photoQ.payload.id);
    check('the photo left the hider’s phone whole, as a JPEG', !!sentPhoto && sentPhoto[0] === 0xff && sentPhoto[1] === 0xd8, sentPhoto?.length);
    check('...with no EXIF and no TIFF block — the GPS tag never left the phone', !!sentPhoto && !metadataIn(sentPhoto).exif && !metadataIn(sentPhoto).tiff, JSON.stringify(sentPhoto && metadataIn(sentPhoto)));

    // The seeker: kept on the phone, pinned in the chat, dropping down under Photo.
    const seekerPhoto = await seeker.p.waitForSelector('.photodrawer .photoitem .photothumb img', { timeout: 30000 }).then(() => true, () => false);
    check('under the Photo category, the seeker gets a drop-down of the hider’s photos', seekerPhoto && /Photos from the hider/.test(await seeker.p.textContent('.photodrawer summary')));
    const kept = await idbBytes(seeker.p, `chat/photo/${game.id}/${photoQ?.payload.id}`);
    check('the seeker keeps the photo on its phone, with no metadata', !!kept && kept.length === sentPhoto?.length && !metadataIn(kept).exif, kept?.length);
    await seeker.p.screenshot({ path: path.join(shots, 'seeker-photo-drawer.png') });
    await seeker.p.click('.photodrawer .photothumb');
    const big = await seeker.p.waitForFunction(() => { const i = document.querySelector('.lightbox img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 }).then(() => true, () => false);
    check('tapping it brings the photo up full size', big);
    await seeker.p.screenshot({ path: path.join(shots, 'seeker-photo-full.png') });
    await clickText(seeker.p, '^Close$', '.lightbox button');
    check('...and it closes', !(await seeker.p.$('.lightbox')));
    check('the photo answer is logged for the seeker too', await waitText(seeker.p, '.seg button', '^Log \\(2\\)$', 8000));

    await clickText(hider.p, '^Play$', '.topbar button');
    const exposure = await waitText(hider.p, '.seg button', '^Exposure \\(2\\)$', 8000);
    check('the hider’s exposure log has both answers', exposure, exposure ? undefined : await hider.p.evaluate(() => [...document.querySelectorAll('.seg button')].map(b => b.textContent).join(' | ')));

    // ---- free chat, kept apart from questions
    await seeker.p.click('.chatbtn');
    await clickText(seeker.p, '^Chat', '.chatpanel .seg button');
    check('Chat is its own section, with no questions in it', !(await seeker.p.$('.chatpanel .cq')));
    check('an empty chat says so, in the middle of the thread', /No messages yet/.test(await seeker.p.textContent('.thread')));
    await seeker.p.fill('.composer input', 'you are so cooked');
    await seeker.p.press('.composer input', 'Enter');
    check('a sent message shows at once, on the right, while it goes', await waitText(seeker.p, '.msg.mine .bubble', 'you are so cooked', 1000));
    check('...and is marked delivered once the relay has it', await seeker.p.waitForFunction(() => !document.querySelector('.msg.pending') && /you are so cooked/.test(document.querySelector('.msg.mine:not(.pending) .bubble')?.textContent || ''), null, { timeout: 10000 }).then(() => true, () => false));
    const unread = await hider.p.waitForFunction(() => document.querySelector('.chatbtn .badge')?.textContent === '1', null, { timeout: 15000 }).then(() => true, () => false);
    check('the hider, on another tab, gets a badge for it', unread);
    await hider.p.click('.chatbtn');
    await clickText(hider.p, '^Chat', '.chatpanel .seg button');
    check('the hider reads it, on the left, with who sent it', await waitText(hider.p, '.msg.theirs .bubble', 'you are so cooked') && /Sam\s*seeker/.test(await hider.p.textContent('.msg.theirs.first .msg-who')));
    check('reading clears the badge', await hider.p.waitForFunction(() => !document.querySelector('.chatbtn .badge'), null, { timeout: 5000 }).then(() => true, () => false));
    await hider.p.fill('.composer input', 'never. you are 3 km off');
    await hider.p.click('.sendbtn');
    check('the seeker gets the reply, live', await waitText(seeker.p, '.msg.theirs .bubble', 'never'));
    await hider.p.fill('.composer input', 'try the park');
    await hider.p.press('.composer input', 'Enter');
    const grouped = await seeker.p.waitForFunction(() => {
      const theirs = [...document.querySelectorAll('.msg.theirs')];
      return theirs.length === 2 && theirs[0].matches('.first:not(.last)') && theirs[1].matches('.last:not(.first)');
    }, null, { timeout: 10000 }).then(() => true, () => false);
    check('two quick messages from one person read as one run: name once, time once', grouped);
    // A long thread scrolls by itself; the box to type in stays put.
    for (let i = 0; i < 14; i++) {
      await seeker.p.fill('.composer input', `filler ${i}`);
      await seeker.p.press('.composer input', 'Enter');
    }
    await seeker.p.waitForFunction(() => !document.querySelector('.msg.pending'), null, { timeout: 20000 });
    const layout = await seeker.p.evaluate(() => {
      const t = document.querySelector('.thread'), c = document.querySelector('.composer'), sheet = document.querySelector('.sheet');
      const cr = c.getBoundingClientRect();
      return { threadScrolls: t.scrollHeight > t.clientHeight, atBottom: t.scrollHeight - t.scrollTop - t.clientHeight < 4,
        composerOnScreen: cr.bottom <= innerHeight && cr.top > innerHeight / 2, sheetScrolls: sheet.scrollHeight > sheet.clientHeight + 1 };
    });
    check('a long thread scrolls inside itself, showing the newest', layout.threadScrolls && layout.atBottom, JSON.stringify(layout));
    check('...with the box to type in pinned at the bottom of the screen', layout.composerOnScreen && !layout.sheetScrolls, JSON.stringify(layout));
    await seeker.p.screenshot({ path: path.join(shots, 'seeker-chat.png') });
    await hider.p.screenshot({ path: path.join(shots, 'hider-chat.png') });
    await seeker.p.emulateMedia({ colorScheme: 'dark' });
    await seeker.p.screenshot({ path: path.join(shots, 'seeker-chat-dark.png') });
    await seeker.p.emulateMedia({ colorScheme: 'light' });
    check('no horizontal scroll on the chat at phone width', (await seeker.p.evaluate(() => document.documentElement.scrollWidth)) <= 390);

    // ---- nothing went to a database or a bucket
    const stored = [...seeker.requests, ...hider.requests].filter(r => /\/storage\/v1\/|\/rest\/v1\/(game_questions|game_messages|messages)/.test(r));
    check('neither phone made a single request to store chat or photos', stored.length === 0, stored[0]);
    let relayRows = null;
    try { relayRows = execFileSync('docker', ['exec', 'supabase_db_JetLeg', 'psql', '-U', 'postgres', '-tAc', `select count(*) from realtime.messages where topic = 'chat:${game.id}'`], { encoding: 'utf8' }).trim(); } catch {}
    if (relayRows === null) console.log('SKIP  relay table check: no local database to ask');
    else check('the relay kept nothing of this game’s chat', relayRows === '0', relayRows);

    // ---- the game file carries it
    await seeker.p.goto(TARGET + '#/stats', { waitUntil: 'domcontentloaded' });
    await seeker.p.waitForSelector('.pagebuttons button', { timeout: 15000 });
    const [download] = await Promise.all([seeker.p.waitForEvent('download'), clickText(seeker.p, '^Save all', '.pagebuttons button')]);
    const filePath = await download.path();
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fs.copyFileSync(filePath, path.join(shots, 'game-file.json'));
    const chat = (file.chats || []).find(c => c.gameId === game.id);
    check('the game file carries the chat: both questions and every message', chat?.questions?.length === 2 && chat?.messages?.length === 17, JSON.stringify([chat?.questions?.length, chat?.messages?.length]));
    const filePhoto = chat?.photos?.[photoQ?.payload.id] ? Buffer.from(chat.photos[photoQ.payload.id], 'base64') : null;
    check('...and the photo, with no metadata in it', !!filePhoto && !metadataIn(filePhoto).exif, filePhoto?.length);
    check('...and its rounds name the game', file.rounds.some(r => (r.chatGames || []).includes(game.id)));

    // ---- deleted with the game data
    // A change of hash alone does not reload, and window.__mapReady would
    // still be true from before: reload, so the wait below means something.
    await seeker.p.goto(TARGET + '#/play', { waitUntil: 'domcontentloaded' });
    await seeker.p.reload({ waitUntil: 'domcontentloaded' });
    await seeker.p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 });
    const chatKeys = async () => (await idbKeys(seeker.p)).filter(k => k.startsWith('chat/log/') || k.startsWith('chat/photo/'));
    check('before: the seeker’s phone holds the chat and the photo', (await chatKeys()).length === 2, JSON.stringify(await chatKeys()));
    await seeker.p.click('.gamebtn');
    await clickText(seeker.p, 'Leave game');
    await seeker.p.waitForSelector('.gameroom input.code', { timeout: 10000 });
    await seeker.p.waitForTimeout(1500);
    check('leaving the game keeps the chat, while a round on the phone still names it', (await chatKeys()).length === 2);
    await clickText(seeker.p, '^Play$', '.topbar button');
    await clickText(seeker.p, '^Log', '.seg button');
    await clickText(seeker.p, '^End game$');
    await seeker.p.waitForSelector('.list li button.link.danger', { timeout: 10000 });
    while (await seeker.p.$('.list li button.link.danger')) {
      await seeker.p.click('.list li button.link.danger');
      await seeker.p.waitForTimeout(300);
    }
    const gone = await until(seeker.p, async () => (await chatKeys()).length === 0, 5000);
    check('deleting the rounds deletes the chat and its photos from the phone', gone, JSON.stringify(await chatKeys()));

    // ---- and comes back from the file
    await seeker.p.goto(TARGET + '#/stats', { waitUntil: 'domcontentloaded' });
    await seeker.p.waitForSelector('input[type=file]', { state: 'attached', timeout: 15000 });
    await seeker.p.setInputFiles('input[type=file]', filePath);
    await waitText(seeker.p, 'button', 'Keep these rounds on this device');
    await clickText(seeker.p, 'Keep these rounds on this device');
    const back = await until(seeker.p, async () => (await chatKeys()).length === 2, 5000);
    check('opening the game file again puts the chat and photo back', back, JSON.stringify(await chatKeys()));

    check('no page errors', seeker.errors.length + hider.errors.length === 0, JSON.stringify([...seeker.errors, ...hider.errors]));
  } catch (e) {
    check('the run finished', false, e.message);
    await seeker.p?.screenshot({ path: path.join(shots, 'seeker-at-failure.png') }).catch(() => {});
    await hider.p?.screenshot({ path: path.join(shots, 'hider-at-failure.png') }).catch(() => {});
  } finally {
    for (const email of emails) {
      await admin.from('developers').delete().eq('email', email);
      await admin.from('test_logins').delete().eq('email', email);
    }
    await browser.close();
  }
  console.log(fail.length ? `\n${fail.length} FAILED:\n  ${fail.join('\n  ')}` : '\nall chat UI checks passed');
  process.exit(fail.length ? 1 : 0);
})();
