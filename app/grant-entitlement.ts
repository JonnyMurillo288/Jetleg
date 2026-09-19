// Admin tool: mint an entitlement for someone who hasn't opened the app yet,
// and print a ready-to-send email so you can hand it to them yourself — no
// email vendor wired up here on purpose, this repo has no transactional
// email account and adding one wasn't worth it for a tool one person runs
// by hand.
//
// The row is created with no device_id (0003_admin_grants.sql made that
// column nullable for exactly this) and the recipient's email as the join
// key. It's invisible to every device's RLS read policy and to
// check_and_activate_entitlement() until they redeem it -- the existing
// restore-entitlement function does the binding, completely unmodified: to
// it, an admin grant looks identical to an ordinary restore of a
// Stripe-purchased row that just happens to start with no owner yet.
//
// An optional third argument scopes the grant to a game (0004_games_teams.sql)
// -- a container for multiple teams/opponents, for future shared-data and
// hider/seeker-location features. Omit it to start a new game (its id is
// printed so you can pass it to the next grant); pass an existing one to
// add another player to that same game.
//
// Usage:
//   cd app
//   SUPABASE_SERVICE_ROLE_KEY=... npx tsx grant-entitlement.ts someone@example.com week_pass [gameId]
//
// Defaults to the local Supabase stack's fixed demo service-role key if
// SUPABASE_SERVICE_ROLE_KEY isn't set -- fine against `supabase start`,
// useless (and safely rejected) against a real project.
import { createClient } from '@supabase/supabase-js';
import { PRODUCTS, isProduct } from './src/payments/products';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const [, , email, productArg, gameIdArg] = process.argv;

function usageAndExit(): never {
  console.error('Usage: npx tsx grant-entitlement.ts <email> <single_game|week_pass> [gameId]');
  console.error(`  single_game — ${PRODUCTS.single_game.label} (normally ${PRODUCTS.single_game.price})`);
  console.error(`  week_pass   — ${PRODUCTS.week_pass.label} (normally ${PRODUCTS.week_pass.price})`);
  console.error('  gameId      — omit to start a new game; pass one to add another player to it');
  process.exit(1);
}

if (!email || !email.includes('@') || !isProduct(productArg)) usageAndExit();
const product = productArg;

(async () => {
  const supabase = createClient(url, serviceRoleKey);
  const sessionId = `admin-${crypto.randomUUID()}`;

  let gameId: string;
  if (gameIdArg) {
    const { data: game, error: gameError } = await supabase.from('games').select('id').eq('id', gameIdArg).single();
    if (gameError || !game) {
      console.error(`No game found with id ${gameIdArg} — a typo here would silently orphan the grant, so refusing instead.`);
      process.exit(1);
    }
    gameId = game.id;
  } else {
    const { data: game, error: gameError } = await supabase.from('games').insert({}).select('id').single();
    if (gameError || !game) {
      console.error('Could not create a new game:', gameError?.message);
      process.exit(1);
    }
    gameId = game.id;
  }

  const { error } = await supabase.from('entitlements').insert({
    product,
    duration_s: PRODUCTS[product].durationS,
    stripe_session_id: sessionId,
    stripe_customer_email: email.trim().toLowerCase(),
    game_id: gameId,
    // device_id omitted — null until restore-entitlement binds it.
  });

  if (error) {
    console.error('Could not create the grant:', error.message);
    process.exit(1);
  }

  const { label, price } = PRODUCTS[product];
  console.log(`Granted ${label} (normally ${price}) to ${email}.`);
  console.log(`Game id: ${gameId}${gameIdArg ? '' : ' (new — pass this to grant-entitlement.ts to add more players to this game)'}\n`);
  console.log('----- copy everything below this line -----\n');
  console.log(`Subject: Your JetLeg SF pass is ready\n`);
  console.log(
    [
      `Hey — you're set for a ${label} JetLeg SF pass, on the house.`,
      ``,
      `Open the app, tap "Start a new round", then "Restore a purchase",`,
      `and enter this email address exactly: ${email}`,
      ``,
      `The clock starts the moment you actually play, not now — so there's`,
      `no rush to use it today.`,
    ].join('\n'),
  );
  console.log('\n----- copy everything above this line -----');
})().catch((e) => {
  console.error('grant-entitlement crashed:', e);
  process.exit(1);
});
