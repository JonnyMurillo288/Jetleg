import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectionAt } from '../engine/project';
import type { MapStation } from './format';
import { clashGraph, simplifyStations } from './simplify';

const shipped: MapStation[] = JSON.parse(readFileSync(join(__dirname, '../../public/data/stations.json'), 'utf8')).stations;

/** A seeded random number generator, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32;
}

/** Stations scattered over a square `sizeM` across, around San Francisco. */
function scatter(n: number, sizeM: number, seed: number, modes: MapStation['modes'][] = [['bus']]): MapStation[] {
  const r = rng(seed);
  const proj = projectionAt(-122.44, 37.76);
  const [cx, cy] = proj.toUTM([-122.44, 37.76]);
  return Array.from({ length: n }, (_, i) => {
    const [lon, lat] = proj.toLngLat([cx + r() * sizeM, cy + r() * sizeM]);
    return { id: `s${String(i).padStart(2, '0')}`, name: `S${i}`, lon, lat, modes: modes[i % modes.length], routes: [] };
  });
}

/** The true maximum, by exhaustive search. Only for small sets. */
function exactMax(g: number[][]): number {
  const n = g.length;
  const nb = g.map((list) => list.reduce((m, j) => m | (1 << j), 0));
  let best = 0;
  const go = (cand: number, size: number) => {
    if (cand === 0) { best = Math.max(best, size); return; }
    if (size + popcount(cand) <= best) return;
    const v = 31 - Math.clz32(cand);
    go(cand & ~(1 << v) & ~nb[v], size + 1); // take v
    go(cand & ~(1 << v), size); // leave it
  };
  go((1 << n) - 1, 0);
  return best;
}
const popcount = (x: number) => { let c = 0; while (x) { x &= x - 1; c++; } return c; };

const check = (stations: MapStation[], spacing: number, keep: string[] = []) => {
  const res = simplifyStations(stations, { minSpacingM: spacing, keep });
  const g = clashGraph(stations, spacing);
  const gone = new Set(res.remove);
  const locked = new Set(keep);
  const stay = stations.map((s) => !gone.has(s.id));
  return { res, g, stay, locked };
};

describe('simplify', () => {
  it('finds clashes exactly as checking every pair does', () => {
    const stations = scatter(80, 6000, 1);
    const proj = projectionAt(stations[0].lon, stations[0].lat);
    const xy = stations.map((s) => proj.toUTM([s.lon, s.lat]));
    const g = clashGraph(stations, 1000);
    for (let i = 0; i < stations.length; i++) {
      const brute = xy.map((p, j) => (j !== i && Math.hypot(p[0] - xy[i][0], p[1] - xy[i][1]) < 1000 ? j : -1)).filter((j) => j >= 0);
      expect(g[i].slice().sort((a, b) => a - b)).toEqual(brute);
    }
  });

  it('leaves no two zones overlapping, and drops nothing it did not have to', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { res, g, stay } = check(scatter(60, 5000, seed), 1000);
      for (let i = 0; i < g.length; i++) {
        if (!stay[i]) {
          // Maximal: every station dropped clashes with one that stayed.
          expect(g[i].some((j) => stay[j]), `seed ${seed}: station ${i} was dropped for nothing`).toBe(true);
        } else {
          expect(g[i].some((j) => stay[j]), `seed ${seed}: station ${i} still overlaps`).toBe(false);
        }
      }
      expect(res.clashesAfter).toBe(0);
      expect(res.kept).toBe(stay.filter(Boolean).length);
    }
  });

  it('keeps as many stations as the true best, or within one of it', () => {
    let exact = 0;
    let offByOne = 0;
    const trials = 300;
    for (let seed = 1; seed <= trials; seed++) {
      const stations = scatter(14 + (seed % 9), 3500, seed * 7919);
      const { res, g } = check(stations, 1000);
      const best = exactMax(g);
      expect(res.kept, `seed ${seed}`).toBeLessThanOrEqual(best);
      expect(best - res.kept, `seed ${seed}`).toBeLessThanOrEqual(1);
      if (res.kept === best) exact++; else offByOne++;
    }
    // Measured, so a weaker algorithm cannot pass quietly: it has to hit the
    // true best almost every time, not merely land near it.
    console.log(`simplify vs exact: ${exact}/${trials} optimal, ${offByOne} one short`);
    expect(exact / trials).toBeGreaterThan(0.95);
  });

  it('keeps what it is told to keep, and fits the rest around it', () => {
    const stations = scatter(50, 4000, 42);
    const plain = simplifyStations(stations, { minSpacingM: 1000 });
    const forced = plain.remove.slice(0, 3);
    const { res, g, stay } = check(stations, 1000, forced);
    for (const id of forced) expect(res.remove).not.toContain(id);
    // Apart from the locked ones themselves, still nothing overlaps.
    const lockedIdx = new Set(forced.map((id) => stations.findIndex((s) => s.id === id)));
    for (let i = 0; i < g.length; i++) {
      if (stay[i] && !lockedIdx.has(i)) expect(g[i].some((j) => stay[j])).toBe(false);
    }
  });

  it('between equals, keeps the rail station over the bus stop', () => {
    const [a, b] = scatter(2, 10, 3);
    const pair: MapStation[] = [{ ...a, id: 'bus', modes: ['bus'] }, { ...b, id: 'rail', modes: ['rail'] }];
    expect(simplifyStations(pair, { minSpacingM: 1000 }).remove).toEqual(['bus']);
    expect(simplifyStations([pair[1], pair[0]], { minSpacingM: 1000 }).remove).toEqual(['bus']);
  });

  it('allowing some overlap keeps more stations', () => {
    const stations = scatter(80, 6000, 9);
    const none = simplifyStations(stations, { minSpacingM: 1000 });
    const some = simplifyStations(stations, { minSpacingM: 750 });
    expect(some.kept).toBeGreaterThan(none.kept);
  });

  it('on the shipped San Francisco board, at 500 m', () => {
    const res = simplifyStations(shipped, { minSpacingM: 1000 });
    const half = simplifyStations(shipped, { minSpacingM: 500 });
    console.log(`SF, no overlap: keeps ${res.kept} of ${shipped.length} (${res.clashesBefore} overlapping pairs before). Half overlap allowed: keeps ${half.kept}.`);
    expect(res.clashesAfter).toBe(0);
    expect(res.kept).toBeGreaterThan(0);
    expect(half.kept).toBeGreaterThan(res.kept);
  });
});
