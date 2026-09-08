/**
 * Post-build guard: every relative import in the output must resolve.
 *
 * This exists because of a bug that was invisible until someone opened the app
 * on a phone. MapLibre's worker was emitted with `?url`, which copies a file
 * verbatim without processing it — so the worker kept its own
 * `import ... from "./maplibre-gl-shared.mjs"`, and that file was never
 * emitted. The worker 404'd on its own import, MapLibre parsed no source at
 * all, and the map rendered nothing: not the basemap, and not the hiding zones,
 * because those are parsed in the worker too.
 *
 * Nothing failed loudly. The build succeeded, every file returned 200, and the
 * only symptom was a blank grey rectangle. So: check the graph.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const assets = join(dist, 'assets');

if (!existsSync(assets)) {
  console.error('check-build: no dist/assets — run the build first.');
  process.exit(1);
}

const files = readdirSync(assets).filter((f) => /\.(js|mjs)$/.test(f));
const problems = [];

// `from"./x.mjs"`, `import"./x.js"`, `import("./x.js")`
const RELATIVE = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

for (const file of files) {
  const source = readFileSync(join(assets, file), 'utf8');
  for (const [, spec] of source.matchAll(RELATIVE)) {
    const target = resolve(assets, spec);
    if (!existsSync(target)) {
      problems.push(`${file} imports ${spec}, which was not emitted`);
    }
  }
}

// The worker is the specific thing that broke, so assert it exists at all.
if (!files.some((f) => /worker/i.test(f))) {
  problems.push('no MapLibre worker chunk in dist/assets — the map will not render');
}

if (problems.length) {
  console.error('\ncheck-build FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`check-build: ${files.length} chunks, all relative imports resolve`);
