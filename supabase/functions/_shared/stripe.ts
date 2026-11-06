import Stripe from 'npm:stripe@17';

export const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
});

/**
 * What is sold: a game room, for two days or a week, that up to ROOM_SEATS
 * accounts can join and play in. The app shows the same numbers from
 * app/src/payments/products.ts — change both together. The duration is
 * copied onto the room when it is bought, so a later change here never
 * alters a room someone already paid for.
 */
export const ROOM_SEATS = 8;

export const PRODUCTS = {
  room_2day: { name: 'JetLeg game room — 2 days', cents: 500, durationS: 2 * 24 * 3600 },
  room_week: { name: 'JetLeg game room — 1 week', cents: 1000, durationS: 7 * 24 * 3600 },
} as const;

export type Product = keyof typeof PRODUCTS;

export function isProduct(value: unknown): value is Product {
  return value === 'room_2day' || value === 'room_week';
}
