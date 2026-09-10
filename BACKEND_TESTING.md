# Testing quickstart — `backend/game-history`

Goal: prove the game-history sync actually works — end-to-end, against a real
Postgres, without needing a phone or a live game. Everything here runs
locally against Docker; nothing touches the cloud until the last section.

This branch adds `app/src/sync/`: a finished round syncs to Supabase as
history, station-level and jittered only, never anything live. See
`.claude/skills/jetleg/references/architecture.md` → "Backend" for what it
does and why. This doc is just how to check it.

---

## The short version

```bash
# once
npx supabase start        # from the repo root; needs Docker running

cd app
npm install
npm test                  # unit tests for the sanitizer — fast, no DB needed
npm run verify:sync       # the real thing — signs in, inserts, reads back, checks RLS
```

All green means: radar/thermometer points jitter and never match the true
GPS point, every other category syncs no position, dates replace clock
times everywhere, and — the check that actually matters — a second,
unrelated device cannot read this team's data at all.

---

## Prerequisites

- Docker running (`docker ps` shouldn't error)
- This branch checked out
- `app/.env.local` present — copy `app/.env.local.example` if it's missing,
  and fill in the values `supabase start` prints (`API URL` →
  `VITE_SUPABASE_URL`, `anon key` → `VITE_SUPABASE_ANON_KEY`). Already
  populated with the fixed local-dev demo values if you're continuing from
  the branch as committed — those aren't a secret, every Supabase CLI
  project on every machine gets the same ones locally.

---

## 1. Start local Supabase and apply the schema

```bash
npx supabase start
```

First run pulls several hundred MB of Docker images — slow once, instant
after. It prints a block of URLs and keys; the ones that matter:

```
API URL: http://127.0.0.1:54321
anon key: eyJ...
Studio URL: http://127.0.0.1:54323
```

Migrations under `supabase/migrations/` apply automatically on start. To
reapply from scratch — wipes all local data, which is exactly what you want
between test runs if you've been inserting fixture rows:

```bash
npx supabase db reset
```

Watch this output for `Applying migration 0001_game_history.sql...` with no
error under it. If a migration is broken, this is where it says so — not
three steps later when a query mysteriously fails.

**Studio** (`http://127.0.0.1:54323`) is a Postgres GUI — open it and browse
the `games`/`rounds`/`asks`/`profiles`/`teams` tables directly. The fastest
way to see what a sync actually wrote.

---

## 2. Unit tests — the sanitizer, in isolation

```bash
cd app
npx vitest run src/sync
```

No Docker, no network — pure functions in, assertions on the output. Checks:
a radar/thermometer point never equals the true point; the jitter stays
within its radius; every other category carries no position at all; dates
never carry a clock time; `seekerPin` never appears anywhere in the payload,
even serialized. This is the fast rung — run it on every change to
`sync/payload.ts` or `sync/jitter.ts`.

---

## 3. Integration test — the one that matters

```bash
npm run verify:sync
```

Runs `verify-sync.ts` via `tsx` against whatever `SUPABASE_URL`/
`SUPABASE_ANON_KEY` are set to (local by default). It does the real thing,
not a mock of it:

1. Signs in anonymously as a device, creates a team, joins it
2. Builds a synthetic finished round and inserts `games`/`rounds`/`asks`
3. Reads the row back and confirms the stored point is the jittered one
4. **Signs in as a second, unrelated device and asserts it reads back zero
   rows for the first device's game, and cannot insert into a team it's not
   on** — this is the fairness-shaped check; the schema having RLS enabled
   doesn't mean the policies are actually correct, only running them does

Read every line — `PASS`/`FAIL` per check, not just the final tally. A
`FAIL` naming `infinite recursion detected in policy` means a policy queries
its own table; see the note in `0001_game_history.sql` and route through
`my_team_ids()` instead.

---

## 4. Manual pass — watch it happen in the browser

```bash
npm run dev
```

Open the printed localhost URL, pick **Seeker**, start a round, ask a
question or two (radar and matching, to see both — one jitters, one
doesn't), then end the round. Open Studio and look at `asks.origin_lon` for
each: the radar row has a number near-but-not-equal to your real position,
the matching row has `null`.

**Test the offline queue:** stop the local stack mid-round
(`npx supabase stop`) *before* ending it, then end the round anyway. The
game must not error — `endRound()` calls sync fire-and-forget. Check
IndexedDB in devtools (Application → IndexedDB → the app's DB → key
`sync/queue`) and confirm the payload is sitting there. Then
`npx supabase start` again and reload the page — the `online` event should
flush the queue. Confirm the row lands in Studio.

---

## 5. Testing against a real cloud project

Once a Supabase cloud project exists (see the "Needs Jonny" steps in the
plan this branch was built from — account creation isn't something I can do
for you):

```bash
npx supabase link                  # picks the cloud project
npx supabase db push               # applies migrations there
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_ANON_KEY=<anon key from the dashboard> \
npm run verify:sync
```

Same script, same checks, against real infrastructure — this is the
predeploy gate before anything points a real build at it. To have the app
itself talk to the cloud project instead of local Docker, swap the values in
`app/.env.local` (never commit that file — it's already gitignored via
`*.local`).

---

## 6. Phone testing — a real Cloudflare Pages preview

`npm run dev` can't honestly test radar/thermometer jitter, because
geolocation needs HTTPS and a real GPS fix. A preview deploy gives both
without touching the live site:

```bash
cd app
npm run build
npx wrangler pages deploy dist --project-name jetleg-sf --branch backend-game-history
```

**Never omit `--branch`, and never pass `production`.** This is the exact
incident `SKILL.md` already warns about: wrangler infers the branch from git
when it's not pinned, and a bare `npm run deploy` is hardcoded to
`--branch production` on purpose — don't run that script from this branch.
The command above publishes to:

```
https://backend-game-history.jetleg-sf.pages.dev   ← stable alias, use this one
https://<hash>.jetleg-sf.pages.dev                  ← this specific deployment
```

`https://jetleg-sf.pages.dev` (the apex, the URL players actually use) is
untouched by a non-`production`-branch deploy. Confirm it rather than
trusting that: fetch it before and after and diff the asset hash —

```bash
curl -s https://jetleg-sf.pages.dev/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

should print the same hash both times. Then check the preview itself at the
layer that actually fails:

```bash
npm run verify:live https://backend-game-history.jetleg-sf.pages.dev
```

Open that URL on a phone, add to home screen, grant location, play a real
round with a real GPS fix. The sync target is still whatever
`VITE_SUPABASE_URL` was baked in at build time — point `.env.local` at the
cloud project (§5) before building if you want this preview to actually
reach a shared backend rather than local Docker on your laptop, which a
phone on cellular can't reach anyway.

---

## Troubleshooting

**`supabase start` hangs or errors on a port.** Something else is bound to
`54321`/`54322`/`54323`. `docker ps` to check for a stray container from a
previous run; `npx supabase stop` first if one exists.

**`verify:sync` fails at "device A can create a team" with an auth error.**
Anonymous sign-ins are off. Check `supabase/config.toml` for
`enable_anonymous_sign_ins = true` under `[auth]`, then `npx supabase stop
&& npx supabase start` — this setting needs a restart, not just a file edit.

**Every check after the first two fails with `infinite recursion detected in
policy`.** A policy on `team_members` (or anything referencing it) queries
that same table directly instead of going through `my_team_ids()`. This bit
the first version of this migration — see the comment above the function in
`0001_game_history.sql`.

**`verify:sync` passes locally but the cloud project behaves differently.**
Confirm `npx supabase db push` actually ran against it — a migration that
only ever got applied locally means the cloud schema is stale, and Supabase
won't warn you; it just answers with whatever's actually there.

**Local data is annoyingly stale / fixture rows piling up.** `npx supabase
db reset` wipes and reapplies clean. Nothing here is meant to persist
between test runs.

**Worried a preview deploy touched the live site.** It didn't, as long as
`--branch` was passed and wasn't `production` — but don't take that on
faith. Diff `jetleg-sf.pages.dev`'s asset hash from before the deploy (see
§6); if it changed, something deployed to `production` when it shouldn't
have. `npx wrangler pages deployment list --project-name jetleg-sf` shows
every deployment and which branch/environment each landed on.

**`wrangler pages deploy` warns about uncommitted changes.** Expected and
harmless while this branch is still in progress — it deploys the built
`dist/` output regardless, which reflects whatever's on disk, not what's
committed. Worth remembering if a preview looks stale: rebuild after
committing, or after any edit, before redeploying.
