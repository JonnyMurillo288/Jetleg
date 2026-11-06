import type Stripe from 'npm:stripe@17';
import { getServiceClient } from '../_shared/supabase.ts';
import { stripe } from '../_shared/stripe.ts';

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

/**
 * The only thing in this codebase that ever marks a game room paid.
 * Authenticity comes entirely from Stripe's signature, never from a
 * Supabase auth header -- Stripe's servers call this directly, so
 * verify_jwt is off for this function in supabase/config.toml.
 *
 * A card payment is paid when the session completes; a slower method
 * (a bank debit) completes 'unpaid' and is paid when
 * async_payment_succeeded arrives.
 */
Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature');
  const body = await req.text();
  if (!signature) return new Response('missing signature', { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (e) {
    return new Response(`signature verification failed: ${e}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session;
    const gameId = session.metadata?.game_id;

    if (gameId && session.payment_status === 'paid') {
      const supabase = getServiceClient();
      // Only an unpaid room moves, and only the one this session created:
      // Stripe redelivers webhooks at-least-once, and a redelivery must
      // change nothing.
      const { error } = await supabase
        .from('games')
        .update({
          pass_status: 'paid',
          stripe_session_id: session.id,
          buyer_email: session.customer_details?.email ?? null,
        })
        .eq('id', gameId)
        .eq('pass_status', 'unpaid');
      if (error) {
        console.error('marking the room paid failed', error);
        return new Response('db error', { status: 500 });
      }
    }
  }

  return new Response('ok', { status: 200 });
});
