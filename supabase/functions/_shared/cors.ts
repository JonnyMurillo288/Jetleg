// Both caller-scoped functions (stripe-checkout, restore-entitlement) are
// invoked directly from the browser via supabase.functions.invoke(), which
// preflights with OPTIONS. stripe-webhook never needs this — Stripe's
// server calls it, never a browser.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
