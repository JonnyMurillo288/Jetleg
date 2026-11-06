import { corsHeaders, json } from '../_shared/cors.ts';
import { getServiceClient, getUserFromRequest } from '../_shared/supabase.ts';
import { stripe, isProduct, PRODUCTS, ROOM_SEATS } from '../_shared/stripe.ts';

// Where Checkout sends the player back. Override per-deploy (a Pages
// preview) via the APP_URL secret; defaults to the production apex.
const APP_URL = Deno.env.get('APP_URL') ?? 'https://jetleg.pages.dev';

/**
 * Buys a game room. The room is created here, 'unpaid', before Checkout
 * opens, so its code can be on the Checkout page and in Stripe's receipt —
 * the buyer has it even if they never come back to the app. An unpaid room
 * cannot be joined (take_seat_ in 0015_room_passes.sql); only stripe-webhook
 * marks it paid. One abandoned at Checkout is a harmless row nobody can use.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUserFromRequest(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => null);
  if (!isProduct(body?.product)) return json({ error: 'invalid product' }, 400);
  const product = PRODUCTS[body.product];

  const supabase = getServiceClient();
  const { data: room, error } = await supabase
    .from('games')
    .insert({
      created_by: user.id,
      pass_status: 'unpaid',
      pass_product: body.product,
      duration_s: product.durationS,
      max_seats: ROOM_SEATS,
    })
    .select('id, join_code')
    .single();
  if (error || !room) return json({ error: error?.message ?? 'could not create the room' }, 500);

  // metadata carries the buyer's own auth.uid() and the room id, never
  // anything the request body claims — the webhook trusts this metadata
  // precisely because Stripe, not the client, is the one echoing it back.
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: product.cents, product_data: { name: product.name } },
    }],
    client_reference_id: user.id,
    metadata: { device_id: user.id, product: body.product, game_id: room.id },
    payment_intent_data: {
      description: `JetLeg game room ${room.join_code} — up to ${ROOM_SEATS} players`,
    },
    custom_text: {
      submit: {
        message: `Your room code is ${room.join_code}. Send it to the people you're playing with — up to ${ROOM_SEATS} players, unlimited rounds. The clock starts at the room's first round.`,
      },
    },
    // The hash is the page (app/src/route.ts): back to the game, not the landing page.
    success_url: `${APP_URL}/?checkout=success#/play`,
    cancel_url: `${APP_URL}/?checkout=cancel#/play`,
  });

  await supabase.from('games').update({ stripe_session_id: session.id }).eq('id', room.id);

  return json({ url: session.url });
});
