import { corsHeaders, json } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/supabase.ts';
import { stripe, isProduct } from '../_shared/stripe.ts';

const PRICE_IDS: Record<string, string | undefined> = {
  single_game: Deno.env.get('STRIPE_PRICE_SINGLE_GAME'),
  week_pass: Deno.env.get('STRIPE_PRICE_WEEK_PASS'),
};

// Where Checkout sends the player back. Override per-deploy (a Pages
// preview) via the APP_URL secret; defaults to the production apex.
const APP_URL = Deno.env.get('APP_URL') ?? 'https://jetleg-sf.pages.dev';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUserFromRequest(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => null);
  if (!isProduct(body?.product)) return json({ error: 'invalid product' }, 400);

  const price = PRICE_IDS[body.product];
  if (!price) return json({ error: 'product not configured' }, 500);

  // client_reference_id / metadata carry the device's own auth.uid(), never
  // anything the request body claims — the webhook trusts this metadata
  // precisely because Stripe, not the client, is the one echoing it back.
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { device_id: user.id, product: body.product },
    success_url: `${APP_URL}/?checkout=success`,
    cancel_url: `${APP_URL}/?checkout=cancel`,
  });

  return json({ url: session.url });
});
