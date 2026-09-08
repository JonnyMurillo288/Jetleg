import type { Units } from '../store/game';

const FEET_PER_M = 3.280839895;
const M_PER_MILE = 1609.344;

/**
 * Every distance the app computes, formatted in one place.
 *
 * Two rules keep this honest:
 *
 * 1. **Rule constants stay metric, always.** The rulebook is metric, the
 *    printed cards say "within 2 km", and both players must say the same
 *    number out loud. Question text is never converted — only distances the
 *    app works out for itself.
 * 2. **Nothing here ever feeds the engine.** This is display, at the edge.
 *    Formatting inside the engine is what once put "0.42 km" in the ask log
 *    while the panel above it read "0.26 mi".
 */
export function formatDistance(m: number, units: Units): string {
  if (!Number.isFinite(m)) return '—';
  if (units === 'metric') {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
  }
  const feet = m * FEET_PER_M;
  if (feet < 1000) return `${Math.round(feet)} ft`;
  const miles = m / M_PER_MILE;
  return `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
}

/**
 * Radius presets for the measuring circle.
 *
 * The metric set is deliberately the radar catalog's own distances: the most
 * useful circle to draw is usually "what would radar 1 km actually cut?", and
 * a preset that matches a question you can ask answers that in one tap.
 */
export function radiusPresets(units: Units): { label: string; m: number }[] {
  return units === 'metric'
    ? [
        { label: '500 m', m: 500 },
        { label: '1 km', m: 1000 },
        { label: '2 km', m: 2000 },
        { label: '5 km', m: 5000 },
        { label: '10 km', m: 10_000 },
      ]
    : [
        { label: '¼ mi', m: M_PER_MILE / 4 },
        { label: '½ mi', m: M_PER_MILE / 2 },
        { label: '1 mi', m: M_PER_MILE },
        { label: '2 mi', m: M_PER_MILE * 2 },
        { label: '5 mi', m: M_PER_MILE * 5 },
      ];
}

/** How the setting is offered. Named for what it shows, not for a country:
 *  the UK is itself mixed — miles on the road, metres on the ground — so
 *  "US or UK" would not tell a player which one gives them feet. */
export const UNIT_CHOICES: { value: Units; label: string; hint: string }[] = [
  { value: 'imperial', label: 'Miles & feet', hint: 'US customary' },
  { value: 'metric', label: 'Km & metres', hint: 'Matches the rulebook' },
];

/** The unit a radius is typed in, and the conversion either way. */
export const radiusUnit = (units: Units) => (units === 'metric' ? 'm' : 'ft');
export const toRadiusInput = (m: number, units: Units) =>
  units === 'metric' ? Math.round(m) : Math.round(m * FEET_PER_M);
export const fromRadiusInput = (v: number, units: Units) =>
  units === 'metric' ? v : v / FEET_PER_M;
