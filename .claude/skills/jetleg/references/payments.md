# Payments — deep reference

Phase 3 of `ROADMAP.md`. For pricing/what's-free-vs-paid from a product
angle, see `PAYMENTS.md` at the repo root. For how to actually run and
verify any of this, see `PAYMENTS_TESTING.md`. This file is the
implementation detail: schema, RLS, edge functions, the admin grant tool,
and the gotchas that only showed up by running things.

## The gating decision, and what it departs from

**Starting a round requires a paid, per-device entitlement — including
fully local, solo play.** That is a deliberate departure from this
project's own stated invariant that sign-in and network should never be
required to play (`ROADMAP.md`'s "the local path must keep working"). It
was decided explicitly, not defaulted into.

The line is **map display vs. game mechanics**, not "before vs. after a
round exists":

- **Always free**: the map itself (`MapView`, `LayerPanel`/`LayersPanel` —
  POI/Voronoi layer visibility), viewing and exporting rounds already
  played (`RoundGate`'s history list and backup section), the Results tab.
- **Requires an active, entitled round**: starting the round at all
  (`RoundGate`'s Start button, gated by `PaywallModal`), and — once
  active — everything that reads or writes the ask log: `SeekerPanel`,
  `HiderPanel`, the elimination shading, and the Measure/Plan toolbar
  (`MapToolbar`'s `canMeasure` prop, `App.tsx`: `!!round && !round.endedAt`).

`MapToolbar`'s Measure button used to render unconditionally — it wasn't
wired to round state at all, so a device with no entitlement and no round
could still use the zone-count-preview tool (engine-derived, a "planning"
mechanic, not map display). Fixed by passing `canMeasure` down and hiding
the button, its `toolhint`, and its panel together; an effect forces the
tool back to `'off'` if `canMeasure` flips false while it's armed
(round ends mid-measurement), so a hidden "Done" button can never leave a
tap silently swallowed by a tool with no visible way to release it.

## What's sold now: game rooms (`0015_room_passes.sql`, 6 Nov 2026)

Jonny replaced per-device passes with **game rooms**: $5 for 2 days
(`room_2day`), $10 for a week (`room_week`), up to 8 accounts per room,
unlimited rounds while it runs. The per-device sections further down describe
the older model, which still works for any pass already held but is no longer
sold.

- **A room is a `games` row** (the same table 0004/0005 use for live
  positions and chat), with `pass_status` (`null` = no pass, a developer's
  or a pre-0015 room; `'unpaid'`; `'paid'`), `pass_product`, `duration_s`,
  `max_seats` (8), `started_at`/`expires_at`, `stripe_session_id`,
  `buyer_email`.
- **Places are `room_seats`** (game, device = `auth.uid()`). They are taken
  by `take_seat_()` inside `enter_game_()`, so `join_game` and `create_game`
  both go through it. **A place is never given back:** `leave_game` leaves
  it alone, and `device_id ... on delete set null` keeps a deleted account's
  place counted. That is the anti-sharing rule. RLS on, no policies.
- **The lock is `for no key update`, not `for update`.** `join_game` with a
  new team inserts a `teams` row first, whose FK takes a key-share lock on
  the same `games` row. Two concurrent joins each holding that share and
  each asking `for update` deadlock. Caught only by joining eight phones
  with `Promise.all` in `verify-payments.ts`; sequential joins never show it.
- **The clock starts at the first round.** `check_and_activate_entitlement(start_clock
  boolean default false)` reports a seated, paid, unstarted room as
  eligible with `expires_at` null. The app calls it with `start_clock: true`
  only from `startRoomClock()` (`payments/entitlement.ts`), which RoundGate's
  Start button and `App.resumeRound` (ended rounds) call first. App load
  never starts a clock. `isStillValid` treats a room product with no expiry
  as valid. The function uses `#variable_conflict use_column`, because its
  OUT params share names with columns of both tables.
- **Checkout creates the room first, `'unpaid'`** (`stripe-checkout`), so the
  code is on the Checkout page (`custom_text.submit`) and in the receipt
  (`payment_intent_data.description`). Only `stripe-webhook` flips it to
  `'paid'`, matching `metadata.game_id` and `pass_status = 'unpaid'`
  (idempotent under redelivery), on `checkout.session.completed` with
  `payment_status = 'paid'` or on `async_payment_succeeded`. Prices are
  inline `price_data`, so there are no Stripe Price ids or `STRIPE_PRICE_*`
  secrets. An abandoned checkout leaves an unpaid room nobody can join.
- `create_game` is **developers only** now. Everyone else buys a room, and
  the Game tab's lobby shows `BuyRoom` (`ui/PaywallModal.tsx`) where
  "Create game" used to be.
- `entitled_game_code()` offers the buyer's own room first (paid or still
  unpaid, not expired), so the Game tab shows it ready to join after
  Checkout. `lookup_game` carries the pass and the place counts plus
  `seated`, and the Room view polls it for "3 of 8 places taken · 1 d 4 h
  left".
- Admin comps: `app/grant-room.ts <room_2day|room_week>` inserts a paid
  room with no buyer. `grant-entitlement.ts` is gone.
- Verified in `verify-payments.ts`'s rooms section. `verify-room.ts`,
  `verify-chat.ts` and `verify-room-ui.cjs` make their room with the
  service role, the way the webhook leaves it.

## What was sold before rooms, and the security boundary

- **$0.99** → a 72-hour window (`single_game`); **$3.50** → a 7-day window
  (`week_pass`). One-time Stripe Checkout payments, not subscriptions.
  Source of truth for labels/prices/durations: `app/src/payments/products.ts`
  — shared by `PaywallModal` and `grant-entitlement.ts` so the two can't
  drift the way the engine and the map's own Voronoi cells once did.
- The clock starts on **first use**, not purchase — `status` moves from
  `pending` to `activated` the first time `check_and_activate_entitlement()`
  is called for that device.
- Every device needs its own entitlement — there is no "team owner pays for
  everyone." A lost device, or a device that never made the purchase at all
  (an admin grant — see below), is bound via `restore-entitlement`, which
  re-points the row's `device_id` to the calling device. This is a
  **transfer, not a copy**, and is deliberately **not identity-verified**
  (no OTP/magic link) — an accepted tradeoff for a sub-$4 hobby app.
- **The only place money and eligibility are actually verified**: Stripe
  (payment) → `stripe-webhook` (signature-checked, service-role insert) →
  the `entitlements` table (RLS lets a device read only its own row, and no
  policy grants it insert or update at all — only the webhook's
  service-role key or the `check_and_activate_entitlement()` security-definer
  function can write one). `RoundGate`'s Start button is a convenience, not
  the security boundary — same trust model this app already gave
  `endRound()`'s fire-and-forget sync, applied to a gate instead of a write.
- **Offline**: an *already-activated* window keeps working with no signal
  for its remaining hours — `hasCachedValidEntitlement()` compares a cached
  `expiresAt` to the device clock. A device's very first activation still
  needs one successful round-trip.

## Admin-granted tokens (`app/grant-entitlement.ts`)

For comps, testing, or handing someone a pass before they've ever opened the
app. Deliberately has **no email vendor wired up** — it prints a
ready-to-send message to the terminal and you paste it wherever you
actually talk to the person. That was a real choice, not a placeholder for
"add Resend later": this is a tool one person runs by hand, and a whole
transactional-email integration wasn't worth it for that.

The interesting part is the data model. Every entitlement used to be bound
to a device the moment it was created — a Stripe purchase's `device_id` is
always the buying device's own `auth.uid()`, since Checkout is only
reachable from inside the already-anonymously-authenticated app. An admin
grant has no such device yet. `0003_admin_grants.sql` makes `device_id`
nullable for exactly this: the script inserts a row with `device_id` simply
omitted, keyed only by the recipient's email.

**No other code changed to support this.** RLS's read policy is
`device_id = auth.uid()`, which a `null` never satisfies, so an unclaimed
grant is invisible to every device — including, correctly, the person it
was granted to, until they redeem it. `check_and_activate_entitlement()`
has the same property for the same reason. `restore-entitlement` needed
zero changes at all: it already finds a row by email and sets `device_id`
to the caller, and it has no way to tell (nor any reason to care) whether
that column started `null` (an admin grant) or already pointed at a
purchasing device (an ordinary restore). One function, two callers that
look identical to it.

`grant-entitlement.ts` also takes an optional third argument, a game id —
see the next section.

## Games, teams, and the `sessions` rename (`0004_games_teams.sql`)

An entitlement can be scoped to a **game** — a container for multiple
**teams** (opponents), each holding multiple players via the existing
`team_members`. Built now, purely as a data foundation, for two explicitly
future features: showing players in the same game shared data (saved
results, map specifics), and a hider reading seeker location in-app, gated
by "hider's id is a player on a team in this game." Neither of those is
built. What exists today is just: `games` (id, created_on), `teams.game_id`,
`entitlements.game_id`, and `grant-entitlement.ts` accepting a third
argument to add a player to an existing game instead of starting a new one.

**Why this forced a rename.** The table that had been called `games` since
`0001_game_history.sql` means something else entirely — one team's *synced
history* of an already-completed round (`raw_state`, `team_id`,
`played_on`). That's not "a container of opponents," and both concepts
can't be named `games`. Renamed the old one to **`sessions`**
(`rounds.game_id` → `rounds.session_id` too, and every place that touched
it: `payload.ts`'s `GamePayload.game` → `.session`, `queue.ts`,
`verify-sync.ts`). Safe to do because nothing is deployed to a real cloud
project yet — this would be a real migration-and-backfill problem the
moment actual data exists anywhere but local dev.

**A capability this unlocks for free.** `teams` already has
`for all using (auth.uid() is not null)` — any signed-in device can already
read *any* team row, unrestricted by membership (this predates the games
work; it's needed so a join-code lookup works before you're a member). So
the moment `teams.game_id` exists, `select * from teams where game_id = X`
already returns every team in a game, with **zero new policy** — verified
directly in `verify-payments.ts` rather than assumed. `rounds`/`asks` stay
exactly as gated as always (`my_team_ids()` only) — this never exposes
round data or a hider's position across teams, only that another team
exists. The new `games` table itself is RLS-enabled with **no policies at
all** — closed to every non-service-role caller, verified by
`verify-payments.ts` asserting a plain device reads zero rows from it
directly. There's nothing on that row worth exposing yet (id + created_on);
open it once there's an actual field to read.

**`check_and_activate_entitlement()`'s return shape changed** (added
`game_id`), which needed `DROP FUNCTION` first — `CREATE OR REPLACE` can't
change a function's `RETURNS TABLE` columns. The new OUT parameter
(`game_id`) never appears bare in a predicate inside the function body
(always `row_.game_id`), so it doesn't reintroduce the ambiguous-column bug
described below — but that bug is exactly why this note exists instead of
assuming a new OUT parameter is automatically safe.

## Edge Functions (`supabase/functions/`)

First Edge Functions in this repo — Stripe requires a secret-key-holding
server for creating Checkout sessions and verifying webhook signatures,
which Postgres/RLS alone can't do.

- `stripe-checkout` — caller-scoped (`verify_jwt = true`, the default).
  Trusts only the caller's own `auth.uid()` from its JWT for
  `metadata.device_id`, never anything the request body claims.
- `stripe-webhook` — `verify_jwt = false` in `supabase/config.toml`, since
  Stripe's servers call this directly with no Supabase auth header at all.
  Authenticity comes entirely from `Stripe-Signature`, verified against
  `STRIPE_WEBHOOK_SECRET`. `on conflict (stripe_session_id) do nothing` is
  the idempotency guard against Stripe's at-least-once webhook redelivery
  granting a second window for one payment.
- `restore-entitlement` — caller-scoped. Handles both an ordinary restore
  and redeeming an admin grant, identically (see above).
- `_shared/stripe.ts`, `_shared/supabase.ts`, `_shared/cors.ts` — the Stripe
  client + `DURATION_S` map, a service-role client + JWT-to-user resolver,
  and CORS headers for the two browser-invoked functions, respectively.

## RLS, and the plpgsql version of the recursion trap

`0002_entitlements.sql` follows `0001_game_history.sql`'s conventions
exactly, but hit its own version of the RLS gotcha that bit `my_team_ids()`:
`check_and_activate_entitlement()`'s OUT parameters are named
`product`/`expires_at` to match the table's own columns for a readable
return shape, and an **unqualified reference to either inside the
function's embedded SQL is genuinely ambiguous** to plpgsql — it can't tell
the OUT-parameter variable from the table column of the same name. Fixed by
qualifying every reference with the `entitlements` table name. Caught by
actually calling the function from `verify-payments.ts`, not by reading the
SQL — the error was `column reference "expires_at" is ambiguous`, not a
type error, so nothing before runtime would have flagged it.

## Client (`app/src/payments/`)

Mirrors `app/src/sync/`'s `client.ts`/`index.ts` split.

- `products.ts` — `PRODUCTS` map (label/price/duration), shared with
  `grant-entitlement.ts`.
- `entitlement.ts` — `getOrCreateDeviceId()` (in `sync/identity.ts`, shared
  with team-sync identity) signs the device in anonymously with no display
  name required, since a solo player who never touches sync still needs a
  device id to pay. `CachedEntitlement.gameId` is plumbed through from the
  RPC/restore but not surfaced in any UI yet — there's nothing to show
  until the shared-data/opponents features exist. `checkEntitlement()`
  calls the RPC and caches the result in IndexedDB;
  `hasCachedValidEntitlement()` is the offline read of
  that cache; `startCheckout()`/`restorePurchase()` invoke the two
  caller-scoped functions. `functionErrorMessage()` unwraps a non-2xx edge
  function response's actual JSON body (`error.context.json()`) — the SDK's
  own `error.message` is just "Edge Function returned a non-2xx status
  code" otherwise, which hides the real reason (a missing secret, an
  invalid product) from anyone debugging a failed checkout.
- `PaywallModal.tsx` — no other modal/overlay convention exists in this
  app, so it matches `RoundGate`'s full-panel shape rather than inventing
  dialog CSS. Renders inside `RoundGate` in place of the Start button when
  the device isn't entitled; `RoundGate` itself stays otherwise unchanged
  (history/export sections render regardless).

## Verification ladder additions

```bash
npm run verify:payments   # verify-payments.ts — RPC + RLS + admin-grant redemption, against a live Supabase
```

Needs `supabase start` **and** `supabase functions serve` (the CLI doesn't
always keep the edge runtime up across a `db reset` — see
`PAYMENTS_TESTING.md` §1 if functions stop responding). Covers: ineligible
with no purchase, activation on first use (not insert), exact window
length, cross-device RLS isolation, no client insert policy at all, restore
transferring an entitlement (both an ordinary purchase and an unclaimed
admin grant), the original device losing eligibility once restored
elsewhere, two devices redeeming grants under one game both reporting that
same `game_id`, and a plain device reading `games` directly getting zero
rows back (RLS enabled, no policy — closed by default, not by accident).
`npm run verify:sync` is also part of this ladder now: it must still pass
unmodified against the renamed `sessions` table, proving the rename didn't
silently break the one thing that feature actually promises.
