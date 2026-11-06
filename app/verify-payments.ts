// Verification for the entitlements/payments layer (0002_entitlements.sql,
// 0015_room_passes.sql, supabase/functions/). The per-device passes below
// are no longer sold but must keep working for whoever holds one; game
// rooms -- what is sold now -- are the section at the end. Exercises the real RPC + RLS path against a running
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

  // ---- Game rooms (0015_room_passes.sql): one purchase, up to eight places.
  // The room is inserted the way stripe-checkout does ('unpaid'), then marked
  // paid the way stripe-webhook does; everything after that is a device
  // calling the same RPCs the app calls.
  const join = (d: { client: SupabaseClient }, code: string, name: string) =>
    d.client.rpc('join_game', { code, display_name: name, team_name: `Team ${name}` });

  const buyer = await signInDevice();
  const { data: room, error: roomError } = await service.from('games')
    .insert({ created_by: buyer.id, pass_status: 'unpaid', pass_product: 'room_2day', duration_s: 48 * 3600 })
    .select('id, join_code, max_seats').single();
  check('a room is created unpaid, with eight places', !roomError && room?.max_seats === 8, roomError?.message ?? room);
  const code: string = room!.join_code;

  const offered = await buyer.client.rpc('entitled_game_code');
  check("the buyer's phone is offered the room's code", offered.data === code, offered.data);

  const early = await join(buyer, code, 'Buyer');
  check('an unpaid room cannot be joined', !!early.error && /not been paid/.test(early.error.message), early.error?.message);

  const forged = await buyer.client.from('games').update({ pass_status: 'paid' }).eq('id', room!.id).select('id');
  const stillUnpaid = (await service.from('games').select('pass_status').eq('id', room!.id).single()).data?.pass_status;
  check('a client cannot mark its own room paid', stillUnpaid === 'unpaid', { forged: forged.data, stillUnpaid });

  await service.from('games').update({ pass_status: 'paid', stripe_session_id: `verify-room-${crypto.randomUUID()}` }).eq('id', room!.id);

  const players = [buyer, ...(await Promise.all(Array.from({ length: 7 }, () => signInDevice())))];
  const before8 = await checkEligibility(players[1].client);
  check('a phone with no place is not eligible', before8.eligible === false);

  // All eight at once: the `for update` in take_seat_ is what keeps this at eight.
  const joins = await Promise.all(players.map((p, i) => join(p, code, `P${i}`)));
  check('eight phones join a paid room', joins.every((j) => !j.error), joins.map((j) => j.error?.message ?? 'ok'));

  const ninth = await signInDevice();
  const ninthJoin = await join(ninth, code, 'Ninth');
  check('a ninth phone is refused: the room is full', !!ninthJoin.error && /full/.test(ninthJoin.error.message), ninthJoin.error?.message);
  check('the refused phone is not eligible', (await checkEligibility(ninth.client)).eligible === false);

  const pending = await checkEligibility(players[3].client);
  check('a place in a paid room makes a phone eligible, before its clock starts', pending.eligible === true && pending.product === 'room_2day' && pending.expires_at === null && pending.game_id === room!.id, pending);

  const started = (await players[3].client.rpc('check_and_activate_entitlement', { start_clock: true }).single()).data as Eligibility;
  const hours = started?.expires_at ? (new Date(started.expires_at).getTime() - Date.now()) / 3_600_000 : 0;
  check("starting a round starts the room's 48-hour clock", hours > 47.9 && hours <= 48, `${hours.toFixed(2)}h`);

  const later = (await players[6].client.rpc('check_and_activate_entitlement', { start_clock: true }).single()).data as Eligibility;
  check("another player's first round does not restart the clock", later?.expires_at === started?.expires_at, [later?.expires_at, started?.expires_at]);
  check('every place-holder plays on the same clock', (await checkEligibility(players[0].client)).expires_at === started?.expires_at);

  await players[5].client.rpc('leave_game', { game: room!.id });
  check('leaving the room keeps the place, and the pass with it', (await checkEligibility(players[5].client)).eligible === true);
  const afterLeave = await join(ninth, code, 'Ninth');
  check('a place given up by leaving is not free for someone else', !!afterLeave.error && /full/.test(afterLeave.error.message), afterLeave.error?.message);

  const rejoin = await join(players[5], code, 'P5 again');
  check('the phone that left can come back into its own place', !rejoin.error, rejoin.error?.message);

  await service.auth.admin.deleteUser(players[7].id);
  const afterDelete = await join(ninth, code, 'Ninth');
  check("a deleted account's place stays counted", !!afterDelete.error && /full/.test(afterDelete.error.message), afterDelete.error?.message);

  const seatsRead = await players[0].client.from('room_seats').select('id');
  check('a phone reads no places directly (RLS, no policy)', !seatsRead.error && seatsRead.data?.length === 0, seatsRead.error?.message ?? seatsRead.data);
  const seatForge = await ninth.client.from('room_seats').insert({ game_id: room!.id, device_id: ninth.id });
  check('a phone cannot give itself a place directly', !!seatForge.error);

  const looked = (await players[0].client.rpc('lookup_game', { code })).data;
  check('the room reports 8 of 8 places and that this phone holds one', looked?.seats_taken === 8 && looked?.max_seats === 8 && looked?.seated === true, looked && { taken: looked.seats_taken, seated: looked.seated });

  const freeRoom = await ninth.client.rpc('create_game', { display_name: 'Free', team_name: 'Loader' });
  check('a phone that is not a developer cannot make a room for nothing', !!freeRoom.error, freeRoom.error?.message);

  await service.from('games').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', room!.id);
  check("when the room's time is up its players are no longer eligible", (await checkEligibility(players[0].client)).eligible === false);
  const lateRoom = await service.from('games')
    .insert({ pass_status: 'paid', pass_product: 'room_week', duration_s: 7 * 24 * 3600, started_at: new Date(Date.now() - 3_600_000).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() })
    .select('join_code').single();
  const lateJoin = await join(ninth, lateRoom.data!.join_code, 'Late');
  check('a room whose time is up cannot be joined', !!lateJoin.error && /time is up/.test(lateJoin.error.message), lateJoin.error?.message);

  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:payments crashed:', e);
  process.exit(1);
});
