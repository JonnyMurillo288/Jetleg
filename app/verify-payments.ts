// Verification for the entitlements/payments layer (0002_entitlements.sql,
// supabase/functions/). Exercises the real RPC + RLS path against a running
// Supabase (local by default), the same way verify-sync.ts does for game
// history: asserts what a device can and cannot see or do, not just that
// the SQL reads correctly in isolation.
//
// The Stripe webhook's signature verification is exercised separately (see
// PAYMENTS_TESTING.md -- `stripe listen` + `stripe trigger`), since signing
// a real webhook payload needs Stripe's own tooling. This script instead
// uses the service-role key to insert a 'pending' row directly, standing in
// for "the webhook already ran" -- the part of this feature that's actually
// security-critical is the RPC and its RLS, not the shape of Stripe's HTTP
// call into it.
//
// Requires `supabase start` first. Run against another environment with
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY env vars.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
// Fixed local-only demo key, same category as the anon key above (every
// Supabase CLI project on every machine gets the same one locally) --
// never valid against a real project.
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};

async function signInDevice() {
  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`sign-in failed: ${error?.message}`);
  return { client, id: data.user.id };
}

type Eligibility = { eligible: boolean; product: string | null; expires_at: string | null; game_id: string | null };

async function checkEligibility(client: SupabaseClient): Promise<Eligibility> {
  const { data, error } = await client.rpc('check_and_activate_entitlement').single();
  if (error) throw new Error(`rpc failed: ${error.message}`);
  return data as Eligibility;
}

(async () => {
  const service = createClient(url, serviceRoleKey);
  const deviceA = await signInDevice();
  const deviceB = await signInDevice();
  const deviceC = await signInDevice();

  const before = await checkEligibility(deviceA.client);
  check('a device with no purchase is ineligible', before.eligible === false);

  const sessionId = `verify-payments-${crypto.randomUUID()}`;
  const email = `verify-payments-${Date.now()}@example.com`;
  const { error: insertError } = await service.from('entitlements').insert({
    device_id: deviceA.id,
    product: 'single_game',
    duration_s: 72 * 3600,
    stripe_session_id: sessionId,
    stripe_customer_email: email,
  });
  check('service role can insert a pending entitlement (stands in for the webhook)', !insertError, insertError?.message);

  const activated = await checkEligibility(deviceA.client);
  check('the device becomes eligible on first use', activated.eligible === true);
  check('the activated product matches the purchase', activated.product === 'single_game');
  const hoursLeft = activated.expires_at ? (new Date(activated.expires_at).getTime() - Date.now()) / 3_600_000 : 0;
  check('the window is ~72 hours from first use, not from purchase', hoursLeft > 71.9 && hoursLeft <= 72, `${hoursLeft.toFixed(2)}h`);

  const recheck = await checkEligibility(deviceA.client);
  check('a repeat check does not re-activate or extend the window', recheck.expires_at === activated.expires_at);

  const outsiderCheck = await checkEligibility(deviceB.client);
  check('an outsider device is independently ineligible', outsiderCheck.eligible === false);

  const { data: outsiderRead, error: outsiderError } = await deviceB.client
    .from('entitlements')
    .select('id')
    .eq('device_id', deviceA.id);
  check(
    "an outsider device reads back zero rows for another device's entitlement",
    !outsiderError && (outsiderRead?.length ?? -1) === 0,
    outsiderRead,
  );

  const { error: outsiderInsertError } = await deviceB.client
    .from('entitlements')
    .insert({ device_id: deviceB.id, product: 'single_game', duration_s: 259200, stripe_session_id: crypto.randomUUID() });
  check('a client can never grant itself an entitlement directly (no insert policy exists)', !!outsiderInsertError);

  // Restore: device C, using device A's purchasing email, should receive
  // the entitlement -- and it should move, not copy, so device A loses it.
  const { data: restoreData, error: restoreError } = await deviceC.client.functions.invoke('restore-entitlement', {
    body: { email },
  });
  check('restore-entitlement succeeds for the purchasing email', !restoreError, restoreError?.message);
  check(
    'restore reports the transferred product',
    restoreData?.restored === true && restoreData?.product === 'single_game',
    restoreData,
  );

  const deviceCEligible = await checkEligibility(deviceC.client);
  check('the restoring device is now eligible', deviceCEligible.eligible === true);

  const deviceAAfterRestore = await checkEligibility(deviceA.client);
  check(
    'the original device loses eligibility once restored elsewhere (a transfer, not a copy)',
    deviceAAfterRestore.eligible === false,
  );

  // Admin grants (grant-entitlement.ts): a row with no device_id at all,
  // exactly what that script inserts for someone who hasn't opened the app
  // yet. restore-entitlement should bind it to the first device that
  // redeems the email, with no code path specific to "this one was unowned"
  // -- it's the same function, same query, as any other restore.
  const deviceD = await signInDevice();
  const grantEmail = `verify-payments-grant-${Date.now()}@example.com`;
  const { error: grantError } = await service.from('entitlements').insert({
    product: 'week_pass',
    duration_s: 7 * 24 * 3600,
    stripe_session_id: `admin-${crypto.randomUUID()}`,
    stripe_customer_email: grantEmail,
    // device_id intentionally omitted, mirroring grant-entitlement.ts.
  });
  check('an admin grant with no device_id at all can be inserted', !grantError, grantError?.message);

  const preClaimCheck = await checkEligibility(deviceD.client);
  check('an unclaimed admin grant is invisible to a device that hasn\'t redeemed it', preClaimCheck.eligible === false);

  const { data: claimData, error: claimError } = await deviceD.client.functions.invoke('restore-entitlement', {
    body: { email: grantEmail },
  });
  check('restore-entitlement redeems an unclaimed admin grant', !claimError && claimData?.restored === true, claimError?.message ?? claimData);
  check('the redeemed grant is the week_pass product', claimData?.product === 'week_pass');

  const deviceDEligible = await checkEligibility(deviceD.client);
  check('the redeeming device is now eligible from the admin grant', deviceDEligible.eligible === true);

  // Games (0004_games_teams.sql): a game groups multiple entitlements --
  // the shape grant-entitlement.ts uses to add several players to one
  // outing. Two admin grants under the same game_id, redeemed by two
  // different devices, should both report that same game_id back.
  const { data: game, error: gameCreateError } = await service.from('games').insert({}).select('id').single();
  check('service role can create a game', !gameCreateError && !!game, gameCreateError?.message);

  const deviceE = await signInDevice();
  const deviceF = await signInDevice();
  const emailE = `verify-payments-game-e-${Date.now()}@example.com`;
  const emailF = `verify-payments-game-f-${Date.now()}@example.com`;

  const { error: grantEError } = await service.from('entitlements').insert({
    product: 'single_game',
    duration_s: 72 * 3600,
    stripe_session_id: `admin-${crypto.randomUUID()}`,
    stripe_customer_email: emailE,
    game_id: game!.id,
  });
  const { error: grantFError } = await service.from('entitlements').insert({
    product: 'single_game',
    duration_s: 72 * 3600,
    stripe_session_id: `admin-${crypto.randomUUID()}`,
    stripe_customer_email: emailF,
    game_id: game!.id,
  });
  check('two grants can share one game_id', !grantEError && !grantFError, [grantEError?.message, grantFError?.message]);

  await deviceE.client.functions.invoke('restore-entitlement', { body: { email: emailE } });
  await deviceF.client.functions.invoke('restore-entitlement', { body: { email: emailF } });

  const eEligible = await checkEligibility(deviceE.client);
  const fEligible = await checkEligibility(deviceF.client);
  check(
    'two devices redeeming grants under the same game both report that game_id',
    eEligible.game_id === game!.id && fEligible.game_id === game!.id,
    { e: eEligible.game_id, f: fEligible.game_id, expected: game!.id },
  );

  // Schema smoke check: `games` has RLS enabled with zero policies, so it
  // should be closed by default, not by accident -- a plain device reading
  // it directly gets back an empty set, not an error (that's how Postgres
  // RLS behaves with no matching policy), and definitely not the row.
  const { data: gamesRead, error: gamesReadError } = await deviceE.client.from('games').select('id');
  check('a plain device reading games directly gets zero rows back (closed by default)', !gamesReadError && (gamesRead?.length ?? -1) === 0, gamesRead);

  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:payments crashed:', e);
  process.exit(1);
});
