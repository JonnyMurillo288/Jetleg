import { projectionAt } from '../engine/project';
import type { MapStation } from './format';

/**
 * Simplify a station set: drop as few stations as possible so that no two
 * hiding zones overlap.
 *
 * Two zones of radius r overlap when their stations are less than 2r apart,
 * so the stations that can all stay are an *independent set* in the graph
 * that joins every pair closer than that — and keeping the most stations is
 * the maximum independent set problem. That is NP-hard in general, but these
 * graphs are unit-disk graphs (an edge is "within a fixed distance"), where
 * two well-known steps get very close to the best possible:
 *
 *  1. Greedy by fewest conflicts. Repeatedly keep the station that clashes
 *     with the fewest stations still undecided, and drop everything it
 *     clashes with. A station in a crowded cluster costs many others; one on
 *     the edge of a cluster costs few, so the edges get kept first.
 *  2. Local search: one out, two in. If dropping a kept station would free
 *     two stations that clash with nothing else kept — and not with each
 *     other — swap them in. Each swap keeps one more station; repeat until
 *     none is left (Andrade, Resende & Werneck's "(1,2)-swap").
 *
 * Between choices that keep the same number of stations, the more important
 * station wins: rail and metro over ferry and cable car over bus, then more
 * routes. A last pass swaps a kept station for a more important one that only
 * it was blocking, which never changes the count.
 *
 * Overlap can also be allowed, partly: with `minSpacingM` below 2r, stations
 * only clash when closer than that. And stations can be locked in (`keep`):
 * they stay whatever they clash with, and the rest is fitted around them.
 *
 * Distances are planar, in the stations' own UTM zone — never in degrees.
 */

export type SimplifyOptions = {
  /** Stations closer than this clash. 2 × the zone radius means no overlap at all. */
  minSpacingM: number;
  /** Station ids that must stay. */
  keep?: Iterable<string>;
};

export type SimplifyResult = {
  /** Station ids to remove, in the order given. */
  remove: string[];
  /** How many stay. */
  kept: number;
  /** Pairs of stations closer than `minSpacingM`, before and after. */
  clashesBefore: number;
  clashesAfter: number;
};

/** How much a station is worth keeping, for breaking ties. */
export function importance(s: MapStation): number {
  const tier = s.modes.some((m) => m === 'rail' || m === 'metro') ? 3
    : s.modes.some((m) => m === 'ferry' || m === 'cablecar') ? 2
    : 1;
  return tier + Math.min(s.routes.length, 10) / 20;
}

/** For each station, the indexes of the stations closer than `spacingM`. */
export function clashGraph(stations: MapStation[], spacingM: number): number[][] {
  const out: number[][] = stations.map(() => []);
  if (stations.length < 2 || !(spacingM > 0)) return out;
  const proj = projectionAt(stations[0].lon, stations[0].lat);
  const xy = stations.map((s) => proj.toUTM([s.lon, s.lat]));
  // A grid of spacing-sized cells: a clash can only be in this cell or the eight around it.
  const cell = (v: number) => Math.floor(v / spacingM);
  const grid = new Map<string, number[]>();
  xy.forEach(([x, y], i) => {
    const k = `${cell(x)},${cell(y)}`;
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  });
  xy.forEach(([x, y], i) => {
    const cx = cell(x), cy = cell(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j > i && Math.hypot(xy[j][0] - x, xy[j][1] - y) < spacingM) {
            out[i].push(j);
            out[j].push(i);
          }
        }
      }
    }
  });
  return out;
}

const pairs = (g: number[][], alive: (i: number) => boolean) =>
  g.reduce((n, nb, i) => (alive(i) ? n + nb.filter((j) => j > i && alive(j)).length : n), 0);

export function simplifyStations(stations: MapStation[], opts: SimplifyOptions): SimplifyResult {
  const n = stations.length;
  const g = clashGraph(stations, opts.minSpacingM);
  const weight = stations.map(importance);
  const keepIds = new Set(opts.keep ?? []);
  const locked = stations.map((s) => keepIds.has(s.id));

  // Better: more important, then a stable order by id so the answer never depends on the order given.
  const better = (a: number, b: number) =>
    weight[a] !== weight[b] ? weight[a] > weight[b] : stations[a].id < stations[b].id;

  const inSet = new Array<boolean>(n).fill(false);
  const undecided = new Array<boolean>(n).fill(true);
  const decide = (v: number) => {
    inSet[v] = true;
    undecided[v] = false;
    for (const u of g[v]) undecided[u] = false;
  };

  // Locked stations first, then whatever they leave room for.
  for (let v = 0; v < n; v++) if (locked[v]) { inSet[v] = true; undecided[v] = false; }
  for (let v = 0; v < n; v++) if (locked[v]) for (const u of g[v]) if (!locked[u]) undecided[u] = false;

  // 1. Greedy, fewest undecided conflicts first.
  const degree = g.map((nb) => nb.filter((u) => undecided[u]).length);
  for (;;) {
    let pick = -1;
    for (let v = 0; v < n; v++) {
      if (!undecided[v]) continue;
      if (pick < 0 || degree[v] < degree[pick] || (degree[v] === degree[pick] && better(v, pick))) pick = v;
    }
    if (pick < 0) break;
    const dropped = g[pick].filter((u) => undecided[u]);
    decide(pick);
    for (const u of [pick, ...dropped]) for (const w of g[u]) if (undecided[w]) degree[w]--;
  }

  // How many kept stations each station clashes with.
  const tight = new Array<number>(n).fill(0);
  for (let v = 0; v < n; v++) if (inSet[v]) for (const u of g[v]) tight[u]++;
  const add = (v: number) => { inSet[v] = true; for (const u of g[v]) tight[u]++; };
  const drop = (v: number) => { inSet[v] = false; for (const u of g[v]) tight[u]--; };
  const adjacent = (a: number, b: number) => g[a].includes(b);
  /** Anything that clashes with nothing kept goes in. */
  const fill = () => {
    for (let v = 0; v < n; v++) if (!inSet[v] && tight[v] === 0) add(v);
  };
  fill();

  // 2. One out, two in, until no swap gains a station.
  for (let improved = true; improved;) {
    improved = false;
    for (let v = 0; v < n; v++) {
      if (!inSet[v] || locked[v]) continue;
      // Only v stands in their way.
      const freed = g[v].filter((u) => !inSet[u] && tight[u] === 1);
      let best: [number, number] | null = null;
      for (let i = 0; i < freed.length; i++) {
        for (let j = i + 1; j < freed.length; j++) {
          const a = freed[i], b = freed[j];
          if (adjacent(a, b)) continue;
          if (!best || weight[a] + weight[b] > weight[best[0]] + weight[best[1]]) best = [a, b];
        }
      }
      if (best) {
        drop(v);
        add(best[0]);
        add(best[1]);
        fill();
        improved = true;
      }
    }
  }

  // 3. Same count, more important: swap a kept station for one only it was blocking.
  for (let improved = true; improved;) {
    improved = false;
    for (let v = 0; v < n; v++) {
      if (!inSet[v] || locked[v]) continue;
      const up = g[v].filter((u) => !inSet[u] && tight[u] === 1 && weight[u] > weight[v] + 1e-9);
      if (!up.length) continue;
      const u = up.reduce((a, b) => (better(a, b) ? a : b));
      drop(v);
      add(u);
      fill();
      improved = true;
    }
  }

  return {
    remove: stations.filter((_, i) => !inSet[i]).map((s) => s.id),
    kept: inSet.filter(Boolean).length,
    clashesBefore: pairs(g, () => true),
    clashesAfter: pairs(g, (i) => inSet[i]),
  };
}
