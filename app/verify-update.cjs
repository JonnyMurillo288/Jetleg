// Verification that an installed copy of the app does not stay stale
// (src/update.ts). A phone ran a build from a day before, calling a server
// function that no longer existed, because nothing ever looked for a newer
// version: the service worker kept serving the copy it had.
//
// This serves the built app from its own server, lets a browser install it,
// then puts a "new version" at the same address, and checks both ways it is
// picked up:
//
//   - opening the app again: applied on its own, before anything is shown
//     for long (the opening window in update.ts)
//   - an app already open and in use: a banner, and the new version only
//     once Update is tapped — never a reload under the player's thumb
//
// Needs `npm run build` first. Uses no backend.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + detail : ''}`);
  if (!ok) fail.push(name);
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** Copies dist/ and stamps it as a version: a marker in index.html, and a changed sw.js that precaches it. */
function publish(dir, version) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync('dist', dir, { recursive: true });
  const index = path.join(dir, 'index.html');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<head>', `<head><meta name="jetleg-build" content="${version}">`));
  // The precache manifest names index.html with a revision; a new revision is what makes a new version.
  const sw = path.join(dir, 'sw.js');
  const text = fs.readFileSync(sw, 'utf8').replace(/("?url"?\s*:\s*"index\.html"\s*,\s*"?revision"?\s*:\s*")([^"]+)"/, `$1${version}"`);
  if (text === fs.readFileSync(sw, 'utf8')) throw new Error('could not find index.html in the precache manifest of dist/sw.js');
  fs.writeFileSync(sw, `${text}\n// ${version}\n`);
}

(async () => {
  if (!fs.existsSync('dist/sw.js')) { console.log('FAIL  no dist/sw.js — run `npm run build` first'); process.exit(1); }
  const root = fs.mkdtempSync(path.join(tmpdir(), 'jetleg-update-'));
  const site = path.join(root, 'site');
  publish(site, 'v1');
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(site, url === '/' ? 'index.html' : url);
    if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(site, 'index.html');
    // As Cloudflare does for the worker: always revalidate sw.js.
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': path.basename(file) === 'sw.js' ? 'no-cache' : 'public, max-age=0' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const build = (p) => p.evaluate(() => document.querySelector('meta[name="jetleg-build"]')?.content);
  const controlled = (p) => p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }).then(() => true, () => false);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${origin}/#/about`, { waitUntil: 'load' });
    check('the app installs its offline copy', await controlled(p));
    check('...of version 1', (await build(p)) === 'v1');

    // ---- opening the app after a deploy
    publish(site, 'v2');
    await p.close();
    p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${origin}/#/about`, { waitUntil: 'load' });
    const opened = await p.waitForFunction(() => document.querySelector('meta[name="jetleg-build"]')?.content === 'v2', null, { timeout: 30000 }).then(() => true, () => false);
    check('reopened after a deploy, the app switches to the new version on its own', opened, await build(p));
    check('...without asking (there was nothing to interrupt)', !(await p.$('.updatebanner')));

    // ---- a deploy while the app is open and in use
    await p.waitForTimeout(11_000); // past the opening window
    publish(site, 'v3');
    // What a phone does on coming back to the app.
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const banner = await p.waitForSelector('.updatebanner', { timeout: 30000 }).then(() => true, () => false);
    check('in use, a new version shows a banner instead of reloading', banner && (await build(p)) === 'v2', await build(p));
    await p.screenshot({ path: path.join(root, 'update-banner.png') });
    await p.click('.updatebanner button');
    const switched = await p.waitForFunction(() => document.querySelector('meta[name="jetleg-build"]')?.content === 'v3', null, { timeout: 30000 }).then(() => true, () => false);
    check('tapping Update switches to it', switched, await build(p));
    check('no page errors', errors.length === 0, JSON.stringify(errors));
    console.log(`\nscreenshot: ${path.join(root, 'update-banner.png')}`);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(fail.length ? `\n${fail.length} FAILED:\n  ${fail.join('\n  ')}` : '\nall update checks passed');
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
