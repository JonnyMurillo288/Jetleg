import { resetCandidateCaches } from './candidates';
import { setProjectionCenter } from './project';
import { resetLayerIndexes } from './spatial';

/**
 * Point the engine at a board.
 *
 * The engine keeps several caches that were written when there was exactly
 * one board and nothing could change underneath them: projected coordinates,
 * per-layer spatial indexes keyed by layer name, answer regions keyed by the
 * question alone. A community map can replace the boundary, the layers and
 * even the hemisphere, so every one of those is dropped whenever the board
 * does change, and the projection is re-centred on the new one.
 *
 * Call this *before* anything is evaluated against the new board — a stale
 * region would not throw, it would quietly eliminate the wrong zones.
 */
export function enterBoard(bbox: [number, number, number, number]): void {
  setProjectionCenter((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
  resetLayerIndexes();
  resetCandidateCaches();
}
