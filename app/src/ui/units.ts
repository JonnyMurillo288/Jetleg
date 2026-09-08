import type { Units } from '../store/game';

const FEET_PER_M = 3.280839895;
const M_PER_MILE = 1609.344;

/**
 * Distances the player reads off the map.
 *
 * The rulebook is metric and every rule constant stays metric, but the game is
 * played in San Francisco and called out loud in miles. Formatting is the only
 * place the two meet: nothing here ever feeds the engine.
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

/** The unit a radius is typed in, and the conversion either way. */
export const radiusUnit = (units: Units) => (units === 'metric' ? 'm' : 'ft');
export const toRadiusInput = (m: number, units: Units) =>
  units === 'metric' ? Math.round(m) : Math.round(m * FEET_PER_M);
export const fromRadiusInput = (v: number, units: Units) =>
  units === 'metric' ? v : v / FEET_PER_M;
