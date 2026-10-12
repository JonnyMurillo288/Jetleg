import { corsHeaders, json } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase.ts';

/**
 * Sign in with the fixed testing code instead of an emailed one.
 *
 * Does nothing unless TEST_LOGIN_CODE is set for this environment, and then
 * only for addresses in `test_logins` (0010). Every refusal looks the same
 * from outside -- off, not listed, wrong code -- so the endpoint cannot be
 * used to find out which addresses are testers.
 *
 * On success it does not hand back a session. It asks Auth for a one-time
 * token for that address and returns the token; the app redeems it through
 * the ordinary verify call, so the session is minted by Auth exactly as it
 * would be for an emailed code.
 */
const MAX_FAILED_ATTEMPTS = 10;
const REFUSED = { error: 'That code is wrong or has expired.' };

/** Length-independent comparison, so timing says nothing about the code. */
function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const secret = (Deno.env.get('TEST_LOGIN_CODE') ?? '').trim();
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!secret || !email || !code) return json(REFUSED, 401);

  const supabase = getServiceClient();
  const { data: tester } = await supabase.from('test_logins').select('email, failed_attempts').eq('email', email).maybeSingle();
  if (!tester || tester.failed_attempts >= MAX_FAILED_ATTEMPTS) return json(REFUSED, 401);

  if (!same(code, secret)) {
    await supabase.from('test_logins').update({ failed_attempts: tester.failed_attempts + 1 }).eq('email', email);
    return json(REFUSED, 401);
  }
  if (tester.failed_attempts > 0) await supabase.from('test_logins').update({ failed_attempts: 0 }).eq('email', email);

  // The account may not exist yet: a tester's first sign-in creates it,
  // already confirmed. "Already registered" is the ordinary case, not an error.
  await supabase.auth.admin.createUser({ email, email_confirm: true });

  const { data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) return json({ error: 'Could not start a test sign-in.' }, 500);
  return json({ tokenHash });
});
