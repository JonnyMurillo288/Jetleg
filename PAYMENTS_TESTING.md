# Testing quickstart — payments / entitlements

Goal: prove a device can't play without a valid entitlement, a payment
actually grants one, and no device can ever read or grant itself another
device's entitlement — end-to-end, against real Postgres and (for the parts
that need it) real Stripe test-mode infrastructure.

This branch adds `supabase/functions/` (the first edge functions in this
repo) and `app/src/payments/`. See
`.claude/skills/jetleg/references/architecture.md` → "Payments" for what it
does and why. This doc is just how to check it.

---

## The short version

```bash
# once
npx supabase start                 # from the repo root; needs Docker running
npx supabase functions serve       # separate terminal — serves the 3 functions locally

cd app
npm install
npm test                           # unit tests for the cache/expiry logic — fast, no DB needed
npm run verify:payments            # the RPC + RLS check — signs in three devices, asserts isolation
```

All green means: a device with no purchase is blocked, a purchase activates
on first use (not at checkout), the 72h/7d window is exact, no device can
read or write another device's row, and restoring by email transfers rather
than duplicates. It does **not** by itself prove the real Stripe webhook
signature path — see §3.

---

## Prerequisites

- Docker running (`docker ps` shouldn't error)
- This branch checked out
- The [Stripe CLI](https://docs.stripe.com/stripe-cli) installed, for §3 and
  the manual pass in §4 (`brew install stripe/stripe-cli/stripe` or see
  their install docs) — logged in with `stripe login`, test mode

---

## 1. Start local Supabase and apply the schema

```bash
npx supabase start
```

Watch for `Applying migration 0002_entitlements.sql...` with no error under
it — same discipline as `0001_game_history.sql`. `npx supabase db reset`
wipes and reapplies from scratch, which is the right way to clear fixture
rows between test runs.

**Serve the edge functions.** Unlike the DB and auth, `supabase start` does
not automatically keep the edge runtime up across a `db reset` in every CLI
version — if `curl -X OPTIONS http://127.0.0.1:54321/functions/v1/restore-entitlement`
doesn't respond, run, in its own terminal:

```bash
npx supabase functions serve
```

It hot-reloads on file changes, so leave it running while you iterate.

**Studio** (`http://127.0.0.1:54323`) — browse the `entitlements` table
directly. Fastest way to see what a webhook or the RPC actually wrote.

---

## 2. Unit tests — cache/expiry logic, in isolation

```bash
cd app
npx vitest run src/payments
```

No Docker, no network — `isStillValid` is a pure function of a cached
entitlement and the current time. Run this on every change to
`payments/entitlement.ts`.

---

## 3. Integration test — the one that matters

```bash
npm run verify:payments
```

Runs `verify-payments.ts` via `tsx`, the same shape as `verify-sync.ts`:
signs in three anonymous devices, and — since a client has no insert
policy on `entitlements` at all — uses the local service-role key to insert
a `pending` row directly, standing in for "the webhook already ran." That's
a deliberate scope choice: **the security-critical part of this feature is
the RPC and its RLS, not Stripe's HTTP call into it**, so this script proves
that part exhaustively:

1. A device with no purchase is ineligible
2. It becomes eligible on **first use**, not at insert — the window starts
   when `check_and_activate_entitlement()` is first called, and a repeat
   call doesn't re-activate or extend it
3. The window length is exact (72h for `single_game`)
4. An outsider device is independently ineligible, reads back zero rows for
   another device's entitlement, and cannot insert one for itself
5. `restore-entitlement` (the real edge function, not a stand-in) transfers
   an entitlement by email to a new device and the original device loses it
6. An **admin grant** — a row inserted with `device_id` left `null`,
   exactly what `grant-entitlement.ts` does for someone who hasn't opened
   the app yet — is invisible to every device until redeemed, and
   `restore-entitlement` binds it to whichever device first calls it with
   the matching email, with no code path specific to "this one had no
   owner." See `PAYMENTS.md` for how to actually run that script.
7. **Games**: two admin-style grants sharing one `game_id`, redeemed by two
   different devices, both report that same `game_id` back from
   `check_and_activate_entitlement()`. And a plain device reading `games`
   directly gets zero rows back — that table has RLS enabled with no
   policies at all, closed by default, verified rather than assumed.

```bash
npm run verify:sync
```

Also part of this ladder now, even though it predates payments: adding the
`games` table forced renaming the *other* table that used to be called
`games` (one team's synced round history) to `sessions` — see
`.claude/skills/jetleg/references/payments.md` for why. `verify:sync` must
still pass completely unmodified against the renamed table, which is the
proof the rename didn't silently break the one thing that feature actually
promises: cross-device isolation.

Read every line — a `FAIL` naming `column reference "..." is ambiguous`
means a plpgsql OUT parameter (`product`, `expires_at`) is colliding with
the table's own column of the same name inside `check_and_activate_entitlement()`
— qualify the reference with the table name, as the migration's own comment
explains. This exact bug shipped once and was only caught by actually
calling the RPC, not by reading the SQL.

**What this script does *not* prove**: that Stripe's real webhook signature
verification works, since `stripe-webhook` needs a payload actually signed
by Stripe. That's §4 below.

---

## 4. Manual pass — a real (test-mode) purchase

```bash
# terminal 1
npx supabase functions serve

# terminal 2 — forwards Stripe's test-mode webhooks to your local function
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook
```

`stripe listen` prints a webhook signing secret (`whsec_...`) — put it in
the edge function's local env (see §5) as `STRIPE_WEBHOOK_SECRET`, then
restart `functions serve`.

```bash
# terminal 3 — fires a synthetic checkout.session.completed at your webhook
stripe trigger checkout.session.completed
```

This alone won't carry your app's `metadata.device_id`/`product` (it's a
generic fixture), so check Studio's `entitlements` table only for "a row
appeared with no error in the `functions serve` logs" — the metadata-driven
end-to-end path needs the browser:

```bash
cd app && npm run dev
```

Open the app, tap **Start a new round** with no entitlement → paywall,
choose a price → redirected to a real Stripe Checkout page → pay with
`4242 4242 4242 4242`, any future expiry, any CVC → redirected back with
`?checkout=success` → round starts, TopBar shows remaining time. Confirm in
Studio that the `entitlements` row's `device_id` matches this browser's
anonymous-auth uid (Diagnostics tab, or `supabase.auth.getUser()` in devtools).

**Test the offline path:** once entitled, stop `supabase functions serve`
and the whole `supabase start` stack, then start another round. It must
still work — `hasCachedValidEntitlement()` reads the last successful check
from IndexedDB and compares to the device clock, no network required, for
as long as that window hasn't expired. A **fresh** browser profile (a new
device, never activated) must still be blocked with the stack down — there
is no valid cache to fall back on, by design.

---

## 5. Testing against a real cloud project

Needs Jonny — none of this can be done by an agent:

- A Stripe account (or the existing one), test mode to start
- Two one-time Prices created in the dashboard: "72 hour pass" $0.99, "1
  week pass" $3.50 — copy their Price IDs (`price_...`)
- A webhook endpoint in the dashboard pointed at the deployed
  `stripe-webhook` function URL, subscribed to `checkout.session.completed`
  — copy the signing secret
- Set the edge function secrets (works for both local `functions serve`
  via `--env-file` and the deployed cloud project via `supabase secrets set`):

```bash
npx supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_SINGLE_GAME=price_... \
  STRIPE_PRICE_WEEK_PASS=price_... \
  APP_URL=https://jetleg-sf.pages.dev
```

- `npx supabase db push` to apply `0002_entitlements.sql` to the cloud project
- `npx supabase functions deploy stripe-checkout stripe-webhook restore-entitlement`
- Only once ready to take real money: switch `STRIPE_SECRET_KEY`/
  `STRIPE_WEBHOOK_SECRET` to live values and repeat the webhook-endpoint
  setup against the live dashboard (test and live webhooks are separate).

**Deferred, not v1:** Apple Pay domain verification. Checkout works fine
with card/Link without it — the Apple Pay button on the Checkout page
simply won't appear until that file is served from the production domain.

---

## Troubleshooting

**`verify:payments` fails at "service role can insert a pending entitlement"
with a permission error.** `SUPABASE_SERVICE_ROLE_KEY` is wrong for this
project — the script's built-in default is the fixed local-CLI demo key
(same one every `supabase start` prints); pass the real value via env var
for a cloud project.

**Every check after the first one fails with `column reference "..." is
ambiguous`.** See §3 — a plpgsql OUT parameter is colliding with a table
column of the same name inside `check_and_activate_entitlement()`; qualify
it with `entitlements.<column>`.

**A completed Checkout doesn't grant anything — `entitlements` stays
empty.** Check `functions serve`'s (or the deployed function's) logs for
the webhook call. A `signature verification failed` message means
`STRIPE_WEBHOOK_SECRET` doesn't match the endpoint the request actually
came from — `stripe listen` and the dashboard each mint their own secret;
using the wrong one is the usual cause.

**`stripe-checkout` or `stripe-webhook` crashes immediately with `Neither
apiKey nor config.authenticator provided`.** `STRIPE_SECRET_KEY` isn't set
in whatever's serving the function. Expected with no secrets configured at
all — see §5.

**A device that definitely paid still sees the paywall.** Check whether the
purchase is sitting as `status = 'pending'` in Studio — it only activates on
the *first call* to `check_and_activate_entitlement()`, which fires from
`App.tsx` on load and from `RoundGate`'s Start button. If it's genuinely
`activated` with a past `expires_at`, the window lapsed; that's correct
behaviour, not a bug — the fix is a new purchase or `restore-entitlement`,
not extending the row by hand.

**Worried a restore silently kicked someone else off their device.** That's
the intended behaviour, not a bug — restore transfers, it doesn't copy (see
§3, point 5). If two people share an email and one restores, the other
loses eligibility on their device; there is no v1 mechanism to prevent
this, documented as an accepted tradeoff in
`.claude/skills/jetleg/references/architecture.md`.
