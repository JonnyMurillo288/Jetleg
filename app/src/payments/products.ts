/**
 * What is sold: a game room, for two days or a week, that up to ROOM_SEATS
 * accounts can join with its code and play unlimited rounds in. One source
 * of truth for the label/price copy and the window length, shared by the
 * paywall, the Game tab and the admin grant script (`grant-room.ts`). The
 * server charges from its own copy in
 * supabase/functions/_shared/stripe.ts — change both together.
 */
export type Product = 'room_2day' | 'room_week';

/** Per-device passes from before rooms (0002). No longer sold; one already held still works. */
export type LegacyProduct = 'single_game' | 'week_pass';

export const ROOM_SEATS = 8;

export const PRODUCTS: Record<Product, { label: string; room: string; price: string; durationS: number }> = {
  room_2day: { label: '2 days', room: '2-day room', price: '$5', durationS: 2 * 24 * 3600 },
  room_week: { label: '1 week', room: '1-week room', price: '$10', durationS: 7 * 24 * 3600 },
};

export function isProduct(value: unknown): value is Product {
  return value === 'room_2day' || value === 'room_week';
}
