import type { GameData } from '../data/load';
import type { LngLat, Question } from '../engine/types';
import { nearestFeature } from '../engine/regions';
import type { ChatSubject } from './chat';

/**
 * What a seeker names when they ask: their own nearest one.
 *
 * "Is your nearest library the same as my nearest library?" is only
 * answerable once the seeker says which library that is — at the table,
 * out loud. Their phone already knows, from where they stand, so it goes
 * with the question: the name, and for measuring the distance. A name and a
 * number, never a position.
 */
export function subjectFor(q: Question, from: LngLat | null, data: GameData): ChatSubject | null {
  if (!from || !q.layer || (q.category !== 'matching' && q.category !== 'measuring')) return null;
  const layer = data.layers[q.layer];
  if (!layer || layer.features.length === 0) return null;
  const near = nearestFeature(from, layer);
  if (!near) return null;
  const p = near.feature.properties ?? {};
  const name = String(p.name ?? p.ref ?? p.id ?? 'an unnamed one').slice(0, 120);
  return { name, distanceM: q.category === 'measuring' ? Math.round(near.distanceM) : null };
}
