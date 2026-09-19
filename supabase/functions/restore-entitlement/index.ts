import { corsHeaders, json } from '../_shared/cors.ts';
import { getServiceClient, getUserFromRequest } from '../_shared/supabase.ts';

/**
 * Re-points the most recent still-usable entitlement bought under `email`
 * onto the calling device. A transfer, not a copy: one purchase is live on
 * one device at a time no matter how many times it's restored. Deliberately
 * not identity-verified (no OTP/magic link) -- self-service email lookup
 * only, an accepted tradeoff for a sub-$4 hobby app. See
 * PAYMENTS_TESTING.md.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUserFromRequest(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email) return json({ error: 'email required' }, 400);

  const supabase = getServiceClient();
  const { data: candidates, error: lookupError } = await supabase
    .from('entitlements')
    .select('id, product, status, expires_at, game_id')
    .eq('stripe_customer_email', email)
    .order('purchased_at', { ascending: false });

  if (lookupError) return json({ error: lookupError.message }, 500);

  const now = Date.now();
  const usable = (candidates ?? []).find(
    (row) => row.status === 'pending' || (row.status === 'activated' && new Date(row.expires_at).getTime() > now),
  );

  if (!usable) return json({ restored: false });

  const { error: updateError } = await supabase
    .from('entitlements')
    .update({ device_id: user.id })
    .eq('id', usable.id);

  if (updateError) return json({ error: updateError.message }, 500);

  return json({ restored: true, product: usable.product, expiresAt: usable.expires_at, gameId: usable.game_id });
});
