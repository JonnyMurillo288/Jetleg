import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import type { MapFile } from './format';

/**
 * The map this device is playing on, when it is not the built-in board.
 *
 * The whole map is kept, not just its id: the game has to work underground
 * all day, and a board that needs the network to draw its stations would
 * break the one thing the app is for. `versionId` pins exactly which version
 * was chosen — a map's author publishing a new one never changes the board
 * under a game already being played on the old one.
 */
export type ActiveMap = {
  /** Published maps only; a file opened from disk has neither id. */
  mapId: string | null;
  versionId: string | null;
  map: MapFile;
};

const KEY = 'community/active-map';

export async function loadActiveMap(): Promise<ActiveMap | null> {
  return (await idbGet<ActiveMap>(KEY)) ?? null;
}

export async function saveActiveMap(active: ActiveMap | null): Promise<void> {
  if (active) await idbSet(KEY, active);
  else await idbDel(KEY);
}

/**
 * What a round records about the board it was played on, so a finished
 * round is never silently re-scored against a different set of stations.
 * Built-in board: undefined.
 */
export type BoardStamp = { name: string; versionId: string | null; stationCount: number };

export const stampOf = (active: ActiveMap | null): BoardStamp | undefined =>
  active ? { name: active.map.name, versionId: active.versionId, stationCount: active.map.stations.length } : undefined;

/** Same board? A file from disk has no version id, so its name and size stand in. */
export function sameBoard(a: BoardStamp | undefined, b: BoardStamp | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.versionId || b.versionId) return a.versionId === b.versionId;
  return a.name === b.name && a.stationCount === b.stationCount;
}
