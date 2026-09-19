import Stripe from 'npm:stripe@17';

export const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
});

/** 72 hours / 7 days, in seconds. Captured onto the row at purchase time so a
 * later change here never alters a token someone already bought. */
export const DURATION_S: Record<string, number> = {
  single_game: 72 * 3600,
  week_pass: 7 * 24 * 3600,
};

export type Product = keyof typeof DURATION_S;

export function isProduct(value: unknown): value is Product {
  return value === 'single_game' || value === 'week_pass';
}
