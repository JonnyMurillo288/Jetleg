// Admin tool: make a paid game room by hand — for comps, friends, testing —
// and print a ready-to-send message with its code. No email vendor is wired
// up on purpose: paste the message wherever you actually talk to people.
//
// The room is exactly what a Stripe purchase makes (0015_room_passes.sql),
// marked paid at once and with no buyer: anyone with the code joins it on
// the Game tab, up to eight accounts, and its clock starts at its first
// round.
//
// Usage:
//   cd app
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx grant-room.ts <room_2day|room_week> [note]
//
// Defaults to the local Supabase stack's fixed demo service-role key if
// SUPABASE_SERVICE_ROLE_KEY isn't set -- fine against `supabase start`,
// useless (and safely rejected) against a real project.
import { createClient } from '@supabase/supabase-js';
import { PRODUCTS, ROOM_SEATS, isProduct } from './src/payments/products';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const [, , productArg, note] = process.argv;

if (!isProduct(productArg)) {
  console.error('Usage: npx tsx grant-room.ts <room_2day|room_week> [note]');
  for (const [id, p] of Object.entries(PRODUCTS)) console.error(`  ${id.padEnd(10)} — ${p.label} (normally ${p.price})`);
  process.exit(1);
}
const product = productArg;

(async () => {
  const supabase = createClient(url, serviceRoleKey);
  const { data: room, error } = await supabase
    .from('games')
    .insert({
      pass_status: 'paid',
      pass_product: product,
      duration_s: PRODUCTS[product].durationS,
      max_seats: ROOM_SEATS,
      // Marks it as granted, not bought; unique like a real session id.
      stripe_session_id: `admin-${crypto.randomUUID()}${note ? ` ${note}` : ''}`,
    })
    .select('id, join_code')
    .single();
  if (error || !room) {
    console.error('Could not create the room:', error?.message);
    process.exit(1);
  }

  const { label, price } = PRODUCTS[product];
  console.log(`Made a ${label} game room (normally ${price}).`);
  console.log(`Room code: ${room.join_code}   (game id ${room.id})\n`);
  console.log('----- copy everything below this line -----\n');
  console.log(
    [
      `You're in a JetLeg game room, on the house: ${room.join_code}`,
      ``,
      `Open https://jetleg.pages.dev, go to Play → the Game tab, enter`,
      `${room.join_code}, and pick your team. Up to ${ROOM_SEATS} phones can join, and`,
      `everyone in it plays as many rounds as they like for ${label}.`,
      `The clock starts at the room's first round, not now.`,
    ].join('\n'),
  );
  console.log('\n----- copy everything above this line -----');
})().catch((e) => {
  console.error('grant-room crashed:', e);
  process.exit(1);
});
