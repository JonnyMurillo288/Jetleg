import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * Service-role client: bypasses RLS entirely. Only ever used server-side,
 * after Stripe's signature (webhook) or Supabase's own JWT check (the
 * caller-scoped functions) has already established who's asking.
 */
export function getServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

/**
 * Resolves the calling device's real `auth.uid()` from its own bearer token,
 * rather than trusting anything the request body claims about who it is.
 */
export async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
