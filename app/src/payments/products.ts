/**
 * The only two things sold. One source of truth for the label/price copy
 * and the window length, shared by the paywall UI and the admin grant
 * script (`grant-entitlement.ts`) so the two can never drift apart the way
 * the engine and the map's own Voronoi cells once did.
 */
export type Product = 'single_game' | 'week_pass';

export const PRODUCTS: Record<Product, { label: string; price: string; durationS: number }> = {
  single_game: { label: '72 hours', price: '$0.99', durationS: 72 * 3600 },
  week_pass: { label: '1 week', price: '$3.50', durationS: 7 * 24 * 3600 },
};

export function isProduct(value: unknown): value is Product {
  return value === 'single_game' || value === 'week_pass';
}
