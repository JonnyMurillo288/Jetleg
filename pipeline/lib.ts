import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE = join(HERE, '.cache');
export const OUT = join(HERE, '..', 'app', 'public', 'data');

mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

/**
 * Fetch to a local cache. Every pipeline input is fetched exactly once and then
 * reused, so re-running a step is instant and does not hammer Overpass (which
 * rate-limits aggressively). Delete pipeline/.cache to force a refresh.
 */
export async function cached(name: string, url: string, init?: RequestInit): Promise<string> {
  const path = join(CACHE, name);
  if (existsSync(path)) {
    console.log(`  cache hit  ${name}`);
    return readFileSync(path, 'utf8');
  }
  console.log(`  fetching   ${name}`);

  // Overpass rejects Node's default User-Agent with 406, and rate-limits with
  // 429/504 under load. Both are routine, so retry with backoff.
  const headers = { 'User-Agent': 'jetleg-pipeline/1.0 (hide-and-seek game map builder)', ...(init?.headers ?? {}) };

  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (res.ok) {
      const body = await res.text();
      writeFileSync(path, body);
      return body;
    }
    lastErr = `HTTP ${res.status} ${res.statusText}`;
    if (res.status !== 429 && res.status !== 504 && res.status !== 503) break;
    const wait = attempt * 20;
    console.log(`  ${lastErr}, retrying in ${wait}s (attempt ${attempt}/4)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  throw new Error(`${url} -> ${lastErr}`);
}

/** Overpass QL query, cached by a caller-supplied name. */
export async function overpass(name: string, query: string): Promise<any> {
  const body = await cached(`${name}.json`, 'https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  const parsed = JSON.parse(body);
  if (!parsed.elements) throw new Error(`Overpass returned no elements for ${name}`);
  return parsed;
}

export function writeOut(name: string, data: unknown): void {
  const path = join(OUT, name);
  /**
   * Round to 7 decimal places on the way out — about 1 cm, far finer than GPS
   * and far finer than the game needs. Raw float output carries 17 significant
   * figures per coordinate, which roughly doubled the size of every layer for
   * no gain; these files ship to a phone and are precached for offline use.
   */
  const json = JSON.stringify(data, (_k, v) =>
    typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(7)) : v);
  writeFileSync(path, json);
  const kb = (Buffer.byteLength(json) / 1024).toFixed(0);
  console.log(`  wrote      data/${name}  (${kb} KB)`);
}

export function readOut<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(OUT, name), 'utf8'));
}

/** Fail the build loudly rather than shipping a silently-broken layer. */
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`\n  ASSERTION FAILED: ${msg}\n`);
    process.exit(1);
  }
}

export function expectRange(label: string, n: number, lo: number, hi: number): void {
  if (n < lo || n > hi) {
    console.warn(`  ! ${label}: ${n} is outside the expected range ${lo}-${hi}`);
  } else {
    console.log(`  ok         ${label}: ${n}`);
  }
}
