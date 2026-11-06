# Payments

How JetLeg charges for play, what's free, how to hand someone a room by
hand, and how the money side works. For how to *test* any of this, see
`PAYMENTS_TESTING.md`. For the implementation detail (schema, RLS, edge
function code), see `.claude/skills/jetleg/references/payments.md`.

---

## What's sold: game rooms

One person buys a **game room** and gets its code. They send the code to the
people they're playing with. Everyone who joins the room with that code can
play as many rounds as they like until the room's time is up.

| Room | Price | Time | Players |
|---|---|---|---|
| `room_2day` | $5 | 2 days | up to 8 |
| `room_week` | $10 | 1 week | up to 8 |

- **The clock starts at the room's first round**, not at purchase, so a
  room can be bought the night before game day. Whoever starts the first
  round starts it for everyone in the room.
- **Eight places, one per account.** Joining takes a place. The buyer takes
  one too when they join, so the buyer plus seven others.
- **A place can't be passed on.** Leaving the room keeps the place taken,
  and so does deleting the account. Otherwise one place could go round a
  whole party one phone at a time.
- **No sign-in needed.** A player who never signs in plays on the anonymous
  account their phone was given, which lives in that phone's browser
  storage, so the place belongs to that phone. Clearing the browser's
  storage loses it, and joining again takes another place. A player who
  *is* signed in holds the place on their account, so it follows that
  account to another phone.
- **Where the buyer finds the code:** on the Checkout page before paying,
  on the Game tab when they come back (ready to join), and in Stripe's
  receipt email if receipts are on (it is the payment's description).
- Source of truth for these numbers: `app/src/payments/products.ts`, with
  the server's own copy in `supabase/functions/_shared/stripe.ts`. Change
  both together.

## What's free, what costs money

**Free, no room needed, ever:**

- Viewing the map — the basemap, POI layers, station dots, the Layers panel
- Viewing and exporting rounds you've already played (history list and
  backup section)
- The Results tab — a recap of a finished round's questions and answers

**Needs a place in a room with time left:**

- Starting a new round
- Reopening a round that was ended (Play → *Previous rounds*, or Results →
  *Resume this round*). Resuming one that was never ended needs nothing
- Once a round is active: asking and answering questions, the elimination
  shading, and the Measure/Plan toolbar

The dividing line is **map display vs. game mechanics**: looking at the
board is free; playing costs money.

**Developers** (the `developers` list, `grant-developer.ts`) play free on any
device they sign in on, and can create rooms with no pass for testing live
positions and chat. A developer's room lets nobody play who couldn't already.

**Per-device passes** sold before rooms ($0.99/72 h, $3.50/week) still work
for whoever holds one until they run out. Nothing sells them any more.

## Making a room by hand

For comps, friends, testing. From `app/`:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npx tsx grant-room.ts room_week
```

It makes a paid room straight away, with no Stripe involved, and prints its
code and a message to paste wherever you talk to people. Nothing is sent
automatically. With no `SUPABASE_*` variables it targets the local
`supabase start` stack.

## Setting up real Stripe (once, per project)

Full walkthrough in `PAYMENTS_TESTING.md` §5. The short version:

1. A Stripe account, and a webhook endpoint pointed at the deployed
   `stripe-webhook` function, sending `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`. No Products or Prices to
   create: the checkout function sends the name and price itself.
2. `npx supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... APP_URL=https://jetleg.pages.dev`
3. `npx supabase db push` and `npx supabase functions deploy stripe-checkout stripe-webhook`
4. Test mode first, always. Switch to live keys and a live webhook only
   once you're ready to take money.

## What this doesn't do (yet)

- **No subscriptions.** One-time purchases only.
- **No refund automation.** A Stripe refund doesn't close the room. To
  close it by hand, set its `expires_at` to the past in Supabase Studio
  (`games` table, found by `join_code`).
- **No way to find a lost code from the app** for a buyer who never
  returned from Checkout on that phone and has no receipt. Look it up in
  Studio (`games.buyer_email`) and send it to them.
- **No Apple Pay domain verification yet.** Checkout works without it; the
  Apple Pay button on the Checkout page just won't appear until that file
  is served from the production domain.
