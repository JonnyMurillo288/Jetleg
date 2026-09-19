# Payments

How JetLeg SF charges for play, what's free, how to hand someone a pass by
hand, and how the money side actually works. For how to *test* any of this,
see `PAYMENTS_TESTING.md`. For the implementation detail (schema, RLS, edge
function code), see `.claude/skills/jetleg/references/payments.md`.

---

## What's free, what costs money

**Free, no entitlement needed, ever:**

- Viewing the map — the basemap, POI layers, station dots, the Layers panel
- Viewing and exporting rounds you've already played (`RoundGate`'s history
  list and backup section) — stays available even if your pass has lapsed
  since
- The Results tab — a recap of a finished round's questions and answers

**Requires an active pass:**

- Starting a new round at all (`RoundGate`'s "Start a new round")
- Once a round is active: asking/answering questions, the elimination
  shading, and the Measure/Plan toolbar

The dividing line is **map display vs. game mechanics**: looking at the
board is free forever; actually playing — asking questions, seeing zones get
ruled out, planning your next move — costs money. Reviewing a game you
already played (Results, history, export) is treated as free review, not a
live mechanic, even though it's built from the same questions-and-answers
data.

## Pricing

One-time Stripe Checkout payments — not subscriptions:

| Pass | Price | Window |
|---|---|---|
| `single_game` | $0.99 | 72 hours |
| `week_pass` | $3.50 | 7 days |

**The clock starts the first time you actually play**, not at purchase — so
buying ahead of game day doesn't burn the window before anyone opens the
app. **Every device needs its own pass** — there's no "one person on the
team pays for everyone." Source of truth for these numbers:
`app/src/payments/products.ts`.

## How someone gets a pass

Two ways in:

1. **They buy it themselves** — the paywall in the app, Stripe Checkout,
   card/Link/Apple Pay/Google Pay.
2. **You grant it** — see below. No email is ever sent automatically; you
   get a ready-to-paste message and send it yourself from whatever you
   already use.

Either way, the pass lives on a **device**, not an account — there's no
login. If someone loses their phone or clears browser storage, or you
granted a pass to someone who hasn't opened the app yet, the same
**Restore a purchase** button (in the paywall) re-binds it to whichever
device enters the matching email. Restoring **moves** the pass, it doesn't
copy it — only one device is ever active on a given pass at a time.

## Granting a pass yourself

For comps, refunds-as-a-new-pass, friends, testing, whatever. Run from
`app/`:

```bash
npx tsx grant-entitlement.ts someone@example.com week_pass
```

(`single_game` is the other option.) This creates the pass against
Supabase directly — no Stripe involved at all — and prints a **game id**
plus a ready-to-send email to your terminal:

```
Granted 1 week (normally $3.50) to someone@example.com.
Game id: 45012d3e-... (new — pass this to grant-entitlement.ts to add more players to this game)

----- copy everything below this line -----

Subject: Your JetLeg SF pass is ready

Hey — you're set for a 1 week JetLeg SF pass, on the house.

Open the app, tap "Start a new round", then "Restore a purchase",
and enter this email address exactly: someone@example.com

The clock starts the moment you actually play, not now — so there's
no rush to use it today.

----- copy everything above this line -----
```

Copy the email part into an actual email (or text, or however you talk to
this person) and send it yourself. There's no automated delivery on purpose
— this repo doesn't have a transactional email account, and adding one
wasn't worth it for a tool one person runs by hand.

**Grouping multiple people into one game**: pass that printed game id as a
fourth argument to add another player to the same game instead of starting
a new one:

```bash
npx tsx grant-entitlement.ts someone-else@example.com week_pass 45012d3e-...
```

This doesn't do anything visible in the app yet — there's no "your
opponents" screen — it's the data foundation for that and for shared
results/map state later. See
`.claude/skills/jetleg/references/payments.md` for the schema.

Needs `SUPABASE_SERVICE_ROLE_KEY` for whichever project you're granting
against — defaults to the fixed local-dev key, which only works against
`supabase start`, never a real project. Get the real one from the Supabase
dashboard (Project Settings → API) for a cloud grant.

**The grant is invisible until redeemed.** It's stored with no device
attached at all, keyed only by the email you gave it — nobody, including
the person you granted it to, can see or use it until they run "Restore a
purchase" with that exact email. There's no list of "pending grants" to
check right now beyond looking at the `entitlements` table directly in
Supabase Studio (rows with `device_id` still null).

## Setting up real Stripe (once, per project)

Full walkthrough in `PAYMENTS_TESTING.md` §5. The short version:

1. A Stripe account, two one-time Prices ($0.99, $3.50), and a webhook
   endpoint pointed at the deployed `stripe-webhook` function
2. `npx supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_SINGLE_GAME=... STRIPE_PRICE_WEEK_PASS=...`
3. `npx supabase db push` and `npx supabase functions deploy stripe-checkout stripe-webhook restore-entitlement`
4. Test mode first, always — switch to live keys and a live webhook only
   once you're ready to actually take money

## What this doesn't do (yet)

- **No customer portal, no subscriptions.** These are one-time purchases;
  there's no recurring billing relationship to manage.
- **No refund automation.** A Stripe refund today doesn't revoke the pass it
  already granted — not built, since there's no volume yet to make it worth
  the work. Handle a refund request by asking Stripe to refund the charge
  and, if you want the pass revoked too, deleting the row in Studio by hand.
- **Restore isn't identity-verified.** Anyone who knows the email a pass was
  bought under can restore it — no OTP, no magic link. An accepted tradeoff
  for a sub-$4 hobby app, not an oversight; see
  `.claude/skills/jetleg/references/payments.md` for the reasoning.
- **No Apple Pay domain verification yet.** Checkout works fine without it
  — the Apple Pay button on the Checkout page just won't appear until that
  file is served from the production domain.
