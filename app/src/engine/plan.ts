import type { AskEntry, Boundary, LngLat, PoiLayer, Question, Station } from './types';
import { previewSplit, resolveAsk } from './candidates';
import type { Region } from './regions';
import { nearestFeature } from './regions';

/**
 * Scenario planning: what a question *would* do, before it is asked.
 *
 * Every question the seekers ask hands the hider cards, so the choice of which
 * to ask is the expensive decision in the game — and it is made under a clock,
 * on a phone, while moving. This turns that decision into a comparison of at
 * most three candidates, on the same numbers and the same geometry the real
 * answer will produce.
 *
 * The region is built by resolving a *synthetic* ask through the ordinary
 * engine rather than by a parallel implementation. A planning tool that draws a
 * slightly different shape from the one the answer draws is worse than no
 * planning tool at all.
 */
/**
 * One colour per plan slot, shared by the panel and the map.
 *
 * Deliberately outside the answer-overlay palette: a candidate region and an
 * answered region mean opposite things — one is a guess, the other is fact —
 * and they are on screen together.
 */
export const PLAN_COLORS = ['#2563eb', '#db2777', '#0d9488'];

export type PlanCandidate = {
  question: Question;
  /** The area the hider would be in if the answer were yes. Null when unbuildable. */
  region: Region | null;
  /** Zones on each side, by centre point — the same reading as the ask list. */
  split: { yes: number; no: number } | null;
  /** Zones left if the answer goes the way that helps least. */
  worst: number | null;
  /** Zones left if it goes the way that helps most. */
  best: number | null;
  /** Set when the question cannot be previewed from here, with the reason. */
  blocked?: string;
  /** What the yes side actually means, in words. */
  note?: string;
};

/** The answer used to build the preview region for each category. */
function yesAnswer(question: Question, origin: LngLat, layers: Record<string, PoiLayer>) {
  switch (question.category) {
    case 'radar':
      // "Choose" has no fixed radius, so there is no circle to draw until the
      // seeker picks one at the moment of asking.
      if (!question.distanceM) return { blocked: 'Pick a distance when you ask — there is no fixed radius to preview.' };
      return { answer: { kind: 'yesno', value: 'yes' } as const };
    case 'matching':
      return { answer: { kind: 'yesno', value: 'yes' } as const };
    case 'measuring':
      return { answer: { kind: 'closerFurther', value: 'closer' } as const };
    case 'tentacle': {
      const layer = question.layer ? layers[question.layer] : undefined;
      const near = layer ? nearestFeature(origin, layer) : null;
      // Outside the tentacle's reach there is nothing to name, so there is no
      // representative "yes" to draw.
      if (!near || !question.distanceM || near.distanceM > question.distanceM) {
        return { blocked: 'Nothing of this kind within reach, so there is nothing to preview.' };
      }
      const poiId = (near.feature.properties?.id ?? near.feature.properties?.name ?? null) as string | null;
      return {
        answer: { kind: 'tentacle', poiId } as const,
        note: `preview assumes they name ${near.feature.properties?.name ?? 'the nearest one'}`,
      };
    }
    case 'thermometer':
      return { blocked: 'Needs real travel — set both pins in the Ask tab, then compare.' };
    default:
      return { blocked: 'Photo questions carry no geometry.' };
  }
}

export function planCandidate(
  question: Question,
  origin: LngLat | null,
  alive: Station[],
  layers: Record<string, PoiLayer>,
  boundary: Boundary,
): PlanCandidate {
  const base: PlanCandidate = { question, region: null, split: null, worst: null, best: null };
  if (!origin) return { ...base, blocked: 'Waiting for a position.' };

  if (question.layer && !layers[question.layer]?.features.length) {
    return { ...base, blocked: `No ${question.label.toLowerCase()} on the board — this returns null.` };
  }

  const split = previewSplit(question, origin, alive, layers);
  const counts = split
    ? { split, worst: Math.max(split.yes, split.no), best: Math.min(split.yes, split.no) }
    : { split: null, worst: null, best: null };

  const chosen = yesAnswer(question, origin, layers);
  if ('blocked' in chosen && chosen.blocked) return { ...base, ...counts, blocked: chosen.blocked };

  const entry: AskEntry = {
    // Namespaced so a preview can never be mistaken for a logged ask, and so
    // the engine's region cache keys it separately.
    id: `plan:${question.id}`,
    questionId: question.id,
    askedAt: 0,
    origin,
    answer: chosen.answer!,
  };

  const resolved = resolveAsk(entry, question, layers, boundary);
  return {
    ...base,
    ...counts,
    region: resolved.region,
    note: chosen.note ?? resolved.note,
  };
}
