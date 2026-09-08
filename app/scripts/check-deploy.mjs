/**
 * Verify a *live* deployment, not just the local build.
 *
 * The trap this exists for: Cloudflare Pages answers a request for a missing
 * file with `200 OK` and the contents of index.html. So a broken deploy passes
 * every naive check — the status is 200, the body is non-empty, nothing errors.
 * A worker whose import silently receives HTML instead of JavaScript just dies,
 * and the map renders blank with a clean console.
 *
 * So this checks content *types*, not status codes.
 *
 *   npm run verify:live https://jetleg-sf.pages.dev
 */
const url = (process.argv[2] ?? '').replace(/\/$/, '');
if (!url) {
  console.error('usage: node scripts/check-deploy.mjs https://your-site.pages.dev');
  process.exit(1);
}

const problems = [];
const ok = [];

async function fetchText(path) {
  const res = await fetch(url + path, { redirect: 'follow' });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

/** Pages serves index.html for anything missing, so detect that explicitly. */
const isHtmlFallback = (r) => r.type.includes('text/html') || r.body.trimStart().startsWith('<!doctype');

console.log(`Checking ${url}\n`);

// --- the shell
const index = await fetchText('/');
if (index.status !== 200 || !index.body.includes('<div id="root">')) {
  problems.push(`index.html did not load (HTTP ${index.status})`);
} else {
  ok.push('index.html');
}

// --- the JS bundle named by the shell
const bundlePath = index.body.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
if (!bundlePath) {
  problems.push('could not find the app bundle referenced by index.html');
} else {
  const bundle = await fetchText(bundlePath);
  if (isHtmlFallback(bundle)) {
    problems.push(`${bundlePath} served HTML instead of JavaScript`);
  } else {
    ok.push(bundlePath);

    // --- the MapLibre worker the bundle points at. This is the one that
    //     actually broke: present, but importing a chunk that was never
    //     uploaded, so the map rendered nothing.
    // Match the hashed worker filename wherever it appears — Vite may build the
    // URL by concatenation, so anchoring on surrounding quotes is too fragile.
    const workerPath = bundle.body.match(/assets\/maplibre-gl-worker-[A-Za-z0-9._-]+\.(?:m?js)/)?.[0];
    if (!workerPath) {
      problems.push('the bundle names no MapLibre worker — the map cannot render');
    } else {
      const p = workerPath.startsWith('/') ? workerPath : `/${workerPath}`;
      const worker = await fetchText(p);
      if (isHtmlFallback(worker)) {
        problems.push(`${p} served HTML instead of JavaScript — stale or incomplete deploy`);
      } else {
        ok.push(p);
        // A worker that still imports a sibling needs that sibling present.
        for (const [, spec] of worker.body.matchAll(/from\s*["'](\.\.?\/[^"']+)["']/g)) {
          const dep = new URL(spec, url + p).pathname;
          const r = await fetchText(dep);
          if (isHtmlFallback(r)) {
            problems.push(`the worker imports ${spec}, which is not deployed (${dep} returns HTML)`);
          } else {
            ok.push(dep);
          }
        }
      }
    }
  }
}

// --- game data
for (const f of ['/data/stations.json', '/data/boundary.geojson', '/data/zones.geojson']) {
  const r = await fetchText(f);
  if (isHtmlFallback(r)) problems.push(`${f} is missing (served HTML)`);
  else if (r.status !== 200) problems.push(`${f} returned HTTP ${r.status}`);
  else ok.push(f);
}

for (const o of ok) console.log(`  ok    ${o}`);

if (problems.length) {
  console.error('\nDEPLOY IS BROKEN:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRun `npm run deploy` to push the current build.\n');
  process.exit(1);
}

console.log('\nDeployment looks good — the map should render.\n');
