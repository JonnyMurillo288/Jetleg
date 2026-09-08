# JetLeg roadmap

Preliminary. Nothing here is committed to — it is a shape for the work and the
decisions each phase forces, so the expensive ones get made early rather than
discovered late.

Today the app is local-first: no server, no accounts, static hosting on
Cloudflare Pages. Everything below is a departure from that, and the first
section explains why the departure is riskier than it looks.

---

## The constraint everything else has to respect

**The current design cannot leak the hider's position, because it never leaves
their phone.** That is not a happy accident — it is the reason there is no
backend.

The moment a server holds game state, it holds the hider's location, and a bug
in a query, a permission rule, or a websocket subscription becomes *cheating*
rather than a glitch. A seeker who sees the hider's coordinates has not found a
bug; they have won a game they should have lost, and nobody may ever realise.

So the rule for every phase below:

> The server may never return a hider's position, or anything derived from it,
> to a seeker in the same active round. Enforce it in the database, not in
> application code, and write a test that tries to violate it.

Practically that means row-level security with the hider's location in a table
seekers have no read policy on at all — not a filtered view, not a redacted API
response. Belt and braces: store only what is needed (a station id and answers,
not a GPS trail), and drop precise location on round end.

A second, softer risk: the app currently works with no network, all day,
underground. Accounts must not become a *requirement* to play — sign-in should
be optional and the local path must keep working, or the app gets worse at the
one thing it is for.

---

## Phase 1 — Backend

**Goal:** durable storage and cross-device sync, without breaking either of the
above.

### Recommendation: Supabase

Postgres, auth, realtime and row-level security in one service. RLS is the exact
mechanism the fairness constraint needs, and it is enforced by the database
rather than by remembering to filter.

| Option | For | Against |
|---|---|---|
| **Supabase** | RLS, auth, realtime, Postgres + PostGIS. Most of phase 1–2 is configuration. | Another vendor alongside Cloudflare. |
| Cloudflare D1 + Workers | Already deploying to Cloudflare; one bill, one dashboard. | No RLS — fairness lives in hand-written code. Auth is yours to build. Realtime means Durable Objects. |
| Firebase | Fast to start, good mobile SDKs. | Security rules are their own language and easy to get subtly wrong; less pleasant for relational stats. |

The deciding factor is RLS. On D1 the fairness guarantee would rest on every
query being written correctly forever.

### Schema sketch

```
users        id, email, display_name, created_at
games        id, owner_id, city, size, settings, started_at, ended_at
players      game_id, user_id, display_name, role_order
rounds       id, game_id, hider_id, started_at, found_at, duration_s
asks         id, round_id, question_id, origin, destination, answer, asked_at
hider_state  round_id, station_id, seeker_pin        -- no seeker read policy
```

`asks` is already the app's data model — the store keeps an append-only log and
recomputes from it. That ports directly.

### Work

- [ ] Supabase project, schema, RLS policies
- [ ] **A test that signs in as a seeker and asserts `hider_state` is unreadable**
- [ ] Sync layer: local-first stays the source of truth, server is a replica
- [ ] Conflict handling — the log is append-only, so last-write-wins per entry
- [ ] Offline queue: play with no signal, reconcile on reconnect
- [ ] Migrate existing IndexedDB rounds on first sign-in, without data loss

### Open questions

- Does a game need live multiplayer, or is per-device logging with a shared game
  id enough? Live sync is most of the cost here. The current game works fine
  over a group chat, and shared state buys less than it appears to.
- Is the server authoritative for answers, or still the honour system? Making it
  authoritative means the server computes them, which means it needs the hider's
  position continuously — a much larger surface for the fairness risk.

---

## Phase 2 — Accounts, saved games and stats

**Goal:** a history worth coming back for.

- [ ] Auth: email magic link + Sign in with Apple + Google
  - Apple sign-in is **required** by App Store review if any other social
    sign-in is offered, so build it before the native app, not after
- [ ] Profile: display name, avatar, home city
- [ ] Game history: rounds, durations, roles, final zone counts
- [ ] Optional sign-in — the local path must keep working untouched

### Stats worth having

The interesting ones are about *play quality*, not just outcomes:

- Longest single hide (the rulebook's own win condition)
- Average zones eliminated per question — how efficiently you seek
- Best and worst questions asked, by actual information gained
- Question spend: cards given away vs zones removed
- Hider: exposure curve over the round; how long before you were down to 10 zones
- Head-to-head across a group

The engine already computes everything needed — `evaluate()` returns per-zone
verdicts with `killedBy`, so "zones removed by this question" is available now
and just is not stored.

- [ ] Shareable round summary — a map image plus the ask log

---

## Phase 3 — Payments

**Goal:** cover hosting, and gate whatever is worth gating.

### Read this before building anything

**Apple requires In-App Purchase for digital content sold inside a native iOS
app, at 15–30%.** Stripe cannot be used for that inside the app. If phases 3 and
5 both happen, you end up needing:

- **Web (PWA):** Stripe Checkout — Link, Apple Pay and Google Pay in one
  integration
- **Native iOS:** StoreKit / IAP for anything bought in the app
- Entitlements reconciled server-side so a purchase on either path unlocks both

The cheap way out is to sell **only on the web** and have the native app read
the entitlement. That is allowed, and it is why so many apps have no purchase
button on iOS. Decide this before writing payment code, not after.

### Recommendation

- **Stripe Checkout** hosted page — one integration covers Link, Apple Pay and
  Google Pay; no card data touches the app; PCI scope stays with Stripe
- Apple Pay on the web needs a **domain verification file** served from the
  deployed origin
- **Webhooks are the source of truth** for entitlement, never the client's word
- **RevenueCat** is worth considering the moment IAP is in play — it normalises
  StoreKit and Stripe into one entitlement, and that reconciliation is otherwise
  a genuinely annoying piece of work

### What is actually being sold

Needs deciding, and it shapes the schema:

- Free: solo/local play, one city, local history
- Paid: accounts + sync, full stats, extra cities, multi-device
- One-off unlock vs subscription — a game played a few times a year suits a
  one-off purchase or per-city unlock far better than a monthly subscription

The "keys for accounts" idea is worth splitting in two: **entitlements** (what
an account can do) are not the same as **invite codes** (how someone joins a
friend's game). Invite codes are a game feature and should be free; entitlements
are billing.

### Work

- [ ] Decide the model and the iOS strategy
- [ ] Stripe products, Checkout, customer portal
- [ ] Webhook handler → entitlement table
- [ ] Entitlement checks server-side; the client only ever *reflects* state
- [ ] Apple Pay domain verification
- [ ] Restore purchases, refunds, subscription lapse

---

## Phase 4 — Smaller features

Roughly in value order.

### Completing the rulebook

- [ ] **Sea Level** — needs a USGS 3DEP terrain grid. SF spans 0–282 m, so this
      is one of the strongest questions available and it is currently dead.
      ~640 KB as a 30 m `Float32Array`; pipeline step already designed.
- [ ] **Street or Path** — needs the named-street network from OSM
- [ ] **Hider deck** — time bonuses, powerups, curses; hand size, draw counts,
      the cost-doubling rule. A second system of real size.
- [ ] Round timer and scoring, so the app can declare a winner
- [ ] Photo questions handled in-app rather than over group chat

### Data quality

- [ ] **192 stations, but 122 have no route list and 136 are typed `bus` by
      default.** A GTFS feed with `routes.txt`/`trips.txt` fixes this exactly
      rather than by inference — needs a free 511 key.
- [ ] Reconcile the OSM and GTFS station sets into one reproducible rule

### Map and UX

- [ ] **Offline basemap** — bundled Protomaps `.pmtiles`. Tiles are only
      runtime-cached today, so a cold start with no signal has no basemap.
- [ ] Undo/redo for the ask log (delete exists; undo does not)
- [ ] Zoom-dependent label density
- [ ] Distance/bearing readout from the current position
- [ ] Multiple cities — the engine is already city-agnostic; it is a data swap

### Reliability

- [ ] Background location (only possible in the native app — see phase 5)
- [ ] Crash/error reporting
- [ ] Automated visual regression on the map

---

## Phase 5 — Native app

**Goal:** the things a browser cannot do, and a presence in the stores.

### Recommendation: Capacitor

The app is already a PWA. Capacitor wraps the existing build with native APIs
and keeps **one codebase**. React Native would mean rewriting the entire UI for
no gain the game actually needs.

### What it actually buys

- **Background location.** The real prize. A browser suspends `watchPosition`
  the moment it is backgrounded — hit repeatedly during this build — which for
  a game played while walking around all day is the single biggest limitation.
- **Durable storage.** No 7-day iOS eviction, no losing a round.
- **Push notifications** — "you have been asked a question", with a 5-minute
  answer clock that matters.
- Store presence, and an icon that behaves like an app.

### Costs

- Apple Developer Program, $99/year; Google Play, $25 once
- Review cycles on every release, versus instant web deploys
- IAP obligations (phase 3)
- Two more build pipelines to keep green

### Work

- [ ] Capacitor shell, iOS + Android targets
- [ ] Swap the geolocation layer for `@capacitor/geolocation` with background mode
- [ ] Native storage adapter behind the existing Zustand persistence
- [ ] Push notifications
- [ ] Store listings, screenshots, privacy nutrition labels
  - The privacy label must disclose location collection; if a backend stores it,
    that is "Location — linked to you", which is a materially different
    disclosure from the current "collected but not stored"
- [ ] Keep the PWA shipping in parallel — it is the zero-friction path for a
      guest who is not installing anything to play one game

---

## Suggested order

1. **Phase 4 data quality + Sea Level.** Cheapest, improves the game now,
   no architecture risk.
2. **Phase 1 backend, read-only first.** Sync history up; do not make the server
   authoritative for anything.
3. **Phase 2 accounts and stats.** The actual reason to have a backend.
4. **Phase 5 native shell.** Background location is worth more than payments.
5. **Phase 3 payments.** Last, once there is something worth paying for — and
   only after the iOS strategy is settled.

The one ordering constraint that is not preference: **decide the Apple IAP
question before writing payment code**, because it determines whether Stripe is
the whole solution or half of it.
