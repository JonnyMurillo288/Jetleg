import circleOf from '@turf/circle';
import type { Feature, FeatureCollection } from 'geojson';
import type { MeasureState, Units } from '../store/game';
import { formatDistance } from '../ui/units';
import { metresCached } from '../engine/project';
import { PLAN_COLORS, type PlanCandidate } from '../engine/plan';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The measuring tool's drawing, as one FeatureCollection.
 *
 * Built here rather than in the map component because the labels are the whole
 * point of the tool, and the labels depend on the player's unit setting — which
 * the map has no business knowing about.
 */
export function buildMeasureFc(
  measure: MeasureState,
  units: Units,
  /**
   * An extra path drawn with the measuring tool's own styling.
   *
   * The hider's thermometer run is a two-point measurement — the seekers' start
   * and end — and it should look and read exactly like one. Reusing the tool's
   * rendering means one set of styles, one label format, one thing to keep right.
   */
  extraPath?: [number, number][],
): FeatureCollection {
  const features: Feature[] = [];

  for (const shape of measure.shapes) {
    if (shape.kind === 'circle') {
      const ring = circleOf(shape.center, shape.radiusM, { steps: 96, units: 'meters' });
      features.push({ ...ring, properties: { kind: 'circle' } } as Feature);
      features.push({
        type: 'Feature',
        properties: { kind: 'centre', label: `r ${formatDistance(shape.radiusM, units)}` },
        geometry: { type: 'Point', coordinates: shape.center },
      });
    } else {
      features.push(...pathFeatures(shape.points, units, false));
    }
  }

  // The line being drawn, so a half-finished measurement is still readable.
  if (measure.draft.length) features.push(...pathFeatures(measure.draft, units, true));
  if (extraPath?.length) features.push(...pathFeatures(extraPath, units, false));

  return { type: 'FeatureCollection', features };
}

/**
 * A path as one feature per leg.
 *
 * Splitting it lets each leg carry its own length label placed along that leg —
 * which is what you actually want to read when the question is "how far is it
 * from here to there, then on to there".
 */
function pathFeatures(points: [number, number][], units: Units, draft: boolean): Feature[] {
  const out: Feature[] = [];
  let total = 0;

  for (let i = 1; i < points.length; i++) {
    const legM = metresCached(points[i - 1], points[i]);
    total += legM;
    out.push({
      type: 'Feature',
      properties: { kind: 'segment', draft, label: formatDistance(legM, units) },
      geometry: { type: 'LineString', coordinates: [points[i - 1], points[i]] },
    });
  }

  for (const p of points) {
    out.push({ type: 'Feature', properties: { kind: 'vertex', draft }, geometry: { type: 'Point', coordinates: p } });
  }

  /*
   * One running total, at the far end — where your eye already is.
   *
   * Only for a path with more than one leg. On a two-point line the total is
   * the leg, so it printed the same distance twice, and on the hider's
   * thermometer run it landed on top of the "end" pin label.
   */
  if (points.length > 2) {
    out.push({
      type: 'Feature',
      properties: { kind: 'centre', label: `total ${formatDistance(total, units)}` },
      geometry: { type: 'Point', coordinates: points[points.length - 1] },
    });
  }
  return out;
}

/**
 * The plan's candidate regions.
 *
 * Outlines only, in the slot colours. These are hypotheses sitting on top of a
 * board that already carries four translucent washes; another fill would make
 * both harder to read, and a candidate region must never look like a fact.
 */
export function buildPlanFc(candidates: PlanCandidate[], show: boolean): FeatureCollection {
  if (!show) return EMPTY;
  const features: Feature[] = [];
  candidates.forEach((c, i) => {
    if (!c.region) return;
    features.push({
      ...(c.region as Feature),
      properties: { color: PLAN_COLORS[i % PLAN_COLORS.length], label: c.question.label },
    });
  });
  return { type: 'FeatureCollection', features };
}
