import type Stripe from 'npm:stripe@17';
import { getServiceClient } from '../_shared/supabase.ts';
import { stripe, DURATION_S, isProduct } from '../_shared/stripe.ts';

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

/**
 * The only thing in this codebase that ever writes an entitlement row.
 * Authenticity comes entirely from Stripe's signature, never from a
 * Supabase auth header -- Stripe's servers call this directly, so
 * verify_jwt is off for this function in supabase/config.toml.
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const deviceId = session.metadata?.device_id;
    const product = session.metadata?.product;

    if (deviceId && isProduct(product)) {
      const supabase = getServiceClient();
      // upsert + ignoreDuplicates on the unique stripe_session_id is the
      // idempotency guard: Stripe redelivers webhooks at-least-once, and
      // this must never grant a second window for the same payment.
      const { error } = await supabase.from('entitlements').upsert(
        {
          device_id: deviceId,
          product,
          duration_s: DURATION_S[product],
          stripe_session_id: session.id,
          stripe_customer_email: session.customer_details?.email ?? null,
        },
        { onConflict: 'stripe_session_id', ignoreDuplicates: true },
      );
      if (error) {
        console.error('entitlement insert failed', error);
        return new Response('db error', { status: 500 });
      }
    }
  }

  return new Response('ok', { status: 200 });
});
