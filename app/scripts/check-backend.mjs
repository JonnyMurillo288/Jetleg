/**
 * Which backend did this build bake in?
 *
 * `VITE_SUPABASE_URL` is compiled into the bundle, not read at runtime. A
 * build for the online dev copy that quietly picked up `.env.local` instead
 * ships pointing at `127.0.0.1:54321` — the laptop's Docker stack. It loads,
 * it draws the map, and every sign-in, game room and published map fails on
 * every phone, with nothing on screen to say why. So this reads the built
 * files and checks the URL that is actually in them.
 *
 *   node scripts/check-backend.mjs .env.dev.local
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.argv[2];
const fail = (msg) => { console.error(`check-backend: ${msg}`); process.exit(1); };

if (!envFile) fail('usage: node scripts/check-backend.mjs <env file the build should have used>');
if (!existsSync(join(app, envFile))) fail(`${envFile} does not exist. Copy ${envFile}.example and fill it in.`);
const want = readFileSync(join(app, envFile), 'utf8').match(/^VITE_SUPABASE_URL=(\S+)/m)?.[1]?.replace(/\/$/, '');
if (!want) fail(`${envFile} has no VITE_SUPABASE_URL.`);
if (/127\.0\.0\.1|localhost/.test(want)) fail(`${envFile} points at ${want}, which a phone cannot reach.`);
// Without a key the app builds no client at all and runs as if it had no
// server: no error, just no sign-in, no games, no maps.
const key = readFileSync(join(app, envFile), 'utf8').match(/^VITE_SUPABASE_ANON_KEY=(\S+)/m)?.[1];
if (!key) fail(`${envFile} has no VITE_SUPABASE_ANON_KEY; the app would run with no server.`);
if (!key.startsWith('eyJ')) fail(`${envFile}'s VITE_SUPABASE_ANON_KEY is not a legacy anon key (they start "eyJ").`);

const assets = join(app, 'dist', 'assets');
const bundle = readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
const local = bundle.match(/https?:\/\/(?:127\.0\.0\.1|localhost):54321/);
if (local) fail(`the build talks to ${local[0]}, the local stack, not ${want}.`);
if (!bundle.includes(want)) fail(`${want} is not in the built files; the build did not use ${envFile}.`);
console.log(`check-backend: the build talks to ${want}`);
