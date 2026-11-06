# Next steps — `backend/game-history`

Where this branch stands as of 13 Oct 2026, how to try what is in it, and
what has to happen before any of it is in front of real players. Everything
below was built and tested against the **local** Supabase stack only.

## What this branch adds

| | What | Where to find it in the app |
|---|---|---|
| Game rooms | Create a game, share its six-character code, join a team | **Game** button, GPS row |
| Live seeker locations | Seekers' positions on everyone's map in the game; the hider sends nothing; nothing is stored | The map, once in a game |
| Hider's seekers point | The hider's answers are measured from a live seeker's position, not a hand-dropped pin | Hider's Play tab, once in a game |
| Map studio | Its own page, apart from the game: browse, look at, make and edit maps | **Map** tab → **Map studio**, or `/#/maps` |
| Station maps | A different set of hiding stations on the San Francisco board | Studio → **New stations for San Francisco** |
| Full city maps | A whole board for any city: boundary, stations, places, Voronoi cells — built with the pipeline's tools, in the browser | Studio → **New city** |
| Publishing | Publish, version history, branch from any version, play on anyone's | Studio |
| Likes and discussion | Like / dislike, comments with replies | Any map's page in the studio |
| Email sign-in | A six-digit code, no password; only needed to publish, like or comment | Asked for where it is needed |
| Developer access | Listed emails play free on any device | Paywall → **Developer or tester?** |
| Landing page | A picture of the San Francisco board, and the way in to everything else | The site's root |
| Start a game | Type a city — its flag and number of maps appear — pick a map, play | Landing → **Start a game**, or `/#/start` |
| Game stats | Any round, or any game file, question by question: best and weakest question, time between questions, distance to the hider | Landing → **Game stats**, `/#/stats`, and the game's **Results** tab |
| About and privacy | What the app is; what is kept where | Landing, or `/#/about`, `/#/privacy` |
| Google sign-in | "Continue with Google" wherever sign-in is asked for; keeps only the account's email and name | Any sign-in box, once Google is switched on for the project |
| Map editor tools | Choose a map's hiding-zone size; select several stations or places — by tap, rectangle, lasso or polygon, on desktop or phone — to delete, retype or move; Undo; Simplify away overlapping zones; a Layers control on the map to show or hide stations, zones, each category of places and its Voronoi cells | Map studio → any draft → Stations / Places |
| Resume any round | Finished rounds can be reopened and carried on, on the board they were played on | Play → *Previous rounds*, or Results → *Resume this round* |
| Sharing is opt-in | Finished rounds go to the team's history only if the player turns that on | **Game stats** → **Sharing** |
| Game chat | **Questions**: a seeker asks a catalog question, a countdown runs, the hider answers by hand (hit/miss, closer/further, a photo…), and the answer lands in the seeker's log. **Chat**: free text. Photos are pinned to their question and drop down under Photo. Kept on each phone with its rounds and in the game file — never on a server | **Chat** button, GPS row, once in a game; or **Ask in game chat** on any question |

How each one works, and why it is built the way it is:
`.claude/skills/jetleg/references/architecture.md`.

## Try it now (about five minutes)

```bash
npx supabase start                 # from the repo root; needs Docker and a few GB free
npx supabase migration up          # applies anything new (through 0013) without wiping local data

cd app
npm run seed:community                              # dummy players, maps, likes, comments
npx tsx grant-developer.ts you@example.com            # your own email: free play once signed in
npm run build && npx vite preview --port 4310
```

Open http://127.0.0.1:4310 — the landing page — and:

1. **Play for free.** *Start a game* → type "san" → *San Francisco* → *Play*
   on the built-in board. In the game, tap *Start a new round* → the paywall → *Developer or
   tester?* → enter your email → *I have a testing code* → type the testing
   code → the paywall closes. (See "The testing code" below. Without one,
   tap *Email me a code* and read it at http://127.0.0.1:54324, the local
   mail catcher; nothing is really sent.)
2. **Open the studio.** *Explore maps* on the landing page (or go to `/#/maps`). On a
   laptop the tools sit beside the map. Open "Downtown sprint" — it appears
   on the map; it has two versions, a branch and a thread. Open "East of
   Divisadero", a full city map, and the map moves to it.
3. **Build a city.** *New city* → **Boundary**: search for a place (say
   "Alameda, California"), *Use*, then *~20 m* to simplify. **Stations**:
   *Rail, metro, tram and ferry stops*. **Places**: *Fetch every category
   from OpenStreetMap*, then open a category to add or remove points by
   tapping. **Voronoi**: *Build all cells*, *Show*. **Details**: name it.
   **Publish**. These call the real OpenStreetMap services, so they need a
   connection and can take a minute.
4. **Play on it.** On the map's page, *Play on this map* (end your round
   first — a round pins its board). You land back in the game, with the map
   centred on the new city.
5. **Be someone else.** Open a private window, go to `/#/maps`, sign in as
   `dummy-maya@jetleg.test` with the same testing code, like and comment on
   your map, *Branch it*.
6. **Share locations.** In the two windows, tap *Game* in the game itself;
   create in one, join with the code in the other, set one to *Hider*. The
   seeker's dot appears on the hider's map. Start a round as the hider:
   the answer assistant now measures from that seeker's live position (their
   dot turns purple) instead of a pin you drop. With two seekers, pick which
   one, or *My pin* to place it by hand as before.

7. **Look back on a round.** End a round, then *Results* → the round; or
   *Game stats* on the landing page, where *Open a game file* reads any
   exported round without uploading or importing it. On a seeking round,
   *Where was the hider?* adds how close each question was.

`npx tsx seed-community.ts --reset` removes the dummy content again.
More detail, and the automated checks: `BACKEND_TESTING.md` §3b and §3c.

### The testing code

A fixed six-digit code that signs in listed addresses without any email.
It has two halves, and does nothing unless both are in place:

```bash
# 1. the code, per environment (unset = the feature is off)
echo 'TEST_LOGIN_CODE=123456' > supabase/functions/.env     # local; gitignored
npx supabase stop && npx supabase start
#    cloud: npx supabase secrets set TEST_LOGIN_CODE=123456 && npx supabase functions deploy test-login

# 2. who may use it
cd app
npx tsx test-login.ts you@example.com
npx tsx test-login.ts --list
```

Only listed addresses can be signed into with it; everyone else still needs
their emailed code. Ten wrong codes lock an address until
`npx tsx test-login.ts <email> --unlock`. The seed's dummy accounts are
listed automatically. Developer access (`grant-developer.ts`) is separate:
the testing code gets you signed in, developer access is what makes play free.

**On a real project, treat the code as a shared password for those
accounts.** Six digits is guessable in principle; the lockout is what stands
in the way. Keep the list to test accounts, and unset the secret once real
email is working if you no longer need it.

After switching git branches while the local stack is running, restart the
functions container (`docker restart supabase_edge_runtime_JetLeg`): `main`
has no `supabase/` folder, so the container's view of it goes stale and
every edge function fails with "failed to determine entrypoint".

## Before this reaches real players

In order. Each is a decision or a piece of setup, not just code.

1. **Bring the branch up to date with `main`.** It is two commits behind
   (admin-4 house rule, custom radar distance) plus the import-and-resume
   change. Expect conflicts in `app/src/store/game.ts` and
   `app/src/ui/RoundGate.tsx`. On `main`, "resume" only selects a round, and
   an ended one still bounces back to the start screen. Keep its list of
   imported rounds, but route its `resume()` through this branch's
   `onResume`, which reopens ended rounds and puts their board back.
2. **Create the cloud Supabase project.** A dev copy first is a good
   rehearsal: [QUICKSTART_DEV.md](QUICKSTART_DEV.md) walks through every step
   for `dev.jetleg.pages.dev`. For production, the same steps, and `npx supabase db push`
   (migrations 0001–0011) and `npx supabase functions deploy`. In its dashboard, under Authentication:
   - anonymous sign-ins **on**; "Confirm email" **on** — without it anyone can
     claim any address unverified, which would defeat both the publishing
     gate and developer access;
   - paste the three bodies from `supabase/templates/` into Email Templates
     (the stock ones contain only a link, and the app asks for a code);
   - set the Site URL and redirect URLs to the deployed origin;
   - **connect a real SMTP provider.** Supabase's built-in sender is for
     testing and is limited to a handful of emails an hour.
3. **Build with the cloud keys** (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`), deploy, and re-run the `verify:*` scripts with
   `SUPABASE_URL` / keys / `TARGET` pointed at it.
4. **Give yourself developer access there:**
   `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx grant-developer.ts <email>`.
5. **Decide what the paywall covers.** Game rooms, location sharing and
   community maps are all free right now; only starting a round costs.
6. **Moderation: built (0016, 0018); needs moderators.** Signed-in players
   report a map or comment; three different reporters hide it until a
   moderator looks; moderators work the queue at `/#/moderation` and can
   hide or restore from any map page. Posting is rate-limited (20 comments,
   10 new maps, 30 reports an hour). What's left: make someone a moderator
   on each project — `npx tsx grant-moderator.ts <email>` with that
   project's URL and service key, or in its SQL editor
   `insert into moderators (email) values ('you@example.com');` — and
   decide who else reads reports. Anyone can still publish under any
   display name; names are not unique.
7. **OpenStreetMap, before many people use the studio.** It calls two free
   public services straight from the browser: Nominatim (place search) and
   Overpass (stations and places). Both have usage policies and rate limits
   meant for light use, and Overpass answers 429 when busy. The studio now
   makes one Overpass request per boundary and moves between mirrors when
   one is stuck, which brought a San Francisco fill from 30+ minutes to
   under a minute. The floor is still the public queue, 20–100 s on a busy
   day. For real traffic, put a small caching proxy in front of it (a
   Supabase function storing each city's answer, so only the first author
   waits) or run your own; see the `jetleg-osm` skill. City map pages now
   credit OpenStreetMap (ODbL), as the basemap already did.
8. **Privacy, rules and contact: written; need a reader and an address.**
   `/#/privacy` says what is kept and what is not, written from what the
   code does, including reports and self-serve **Delete account** (0017,
   beside your name in the studio). `/#/rules` is new: playing safely,
   what may be published, how reports work. Both still need reading by
   whoever is answerable for them, as does About's "unofficial, not
   affiliated" line. The contact address is `VITE_CONTACT_EMAIL` (falls
   back to `VITE_REPORT_EMAIL`) in each build's env file; unset, the pages
   say "the person who runs this site".
9. **Finish Google sign-in.** The code and the database side are done and
   on the dev project; it needs a Google OAuth client, and the dev copy has
   not yet done a real Google sign-in. `QUICKSTART_DEV.md` §9. Then the same
   for production, with that project's own callback URL.
10. **Game chat on the cloud.** Push 0013 (`npx supabase db push`; it is
   two Realtime policies, no tables), then send one photo between two phones
   on the dev site and time it: the relay's per-second limit there is the
   cloud's, not the local stack's. Run `verify:chat` and `verify:chat:ui`
   against dev. Then two rulings: one open question at a time or not (not
   enforced now), and whether a late answer costs anything (accepted and
   marked late now).
11. **Give maps a country.** Maps published before 0011 have none unless
   they are for `sf`, so their city shows a globe instead of a flag. New
   city maps pick it up from the place search; an author can republish to
   add one.

## Known gaps

- **Five older test suites are not running.** `verify`, `verify:tools`,
  `verify:rules`, `verify:results` and `verify:units` stop at the paywall in a fresh browser.
  They need to sign in as a developer first, the way `verify-developer.ts`
  does. Until then the measuring tools, the plan layer and the unit sweep
  have no automated check on this branch.
- **Stats need the round's board.** A round played on a community map shows
  zone counts only while that map is the one loaded; otherwise it gets
  timings and movement, and a note saying why. A game file does not carry
  its board.
- **A city is a label an author typed.** "oakland" and "oakland-ca" are two
  cities to the directory, and nothing merges them.
- **Flags are emoji.** Windows has no flag glyphs and shows the two letters
  of the country code instead.
- **The landing page loads the whole app bundle** (about 580 kB gzipped,
  map engine included) before it shows anything; the pages are not split.
- **A game room does not pin a map.** Two players in the same game can be on
  different boards and nothing tells them. The fix is to attach a map version
  to the game and have joining it load that map. This matters more now that
  a board can be a different city.
- **City maps have no administrative divisions.** San Francisco's supervisor
  districts and county line come from city-specific sources; a city map has
  neither unless the county line is imported by hand, so those questions are
  simply not in play on one.
- **The station fetch is the short version of the pipeline's.** It folds
  same-named stops together and reads modes from tags, but recovers no route
  lists and knows nothing of a city's quirks (San Francisco's cable cars are
  tagged as trams). Expect to correct stations by hand. There is no GTFS
  import.
- **Building cells is slow against a detailed boundary.** About eight seconds
  for San Francisco's unsimplified 2,600-point outline, on the main thread.
  A whole county with a thousand cells took about one second once its outline
  was simplified to a few hundred points. The studio says to simplify, and does
  not stop you if you don't.
- **Editing is tap-only.** Stations and places cannot be dragged, and line
  layers (coastline, transit lines) can be fetched or imported but not drawn.
- **The basemap is still online-only**, for any city. The board draws without
  it, but street names need a connection.
- **Finished rounds on another board show no zone counts** (deliberately —
  they would be wrong), but the app does not yet offer to load that board.
  Rounds synced as history do not record their board at all.
- **No merge.** A branch can never be folded back into the map it came from;
  the author has to redo the change as a new version by hand.
- **A map is stored whole** — in one database row (capped at 4.5 MB) and in
  the phone's IndexedDB. A very large city, unsimplified, will not fit.
- **Signing into an existing account on a second device** replaces that
  device's anonymous identity. A pass bought on the device beforehand stays
  with the old identity and has to be restored by email.
- **`teams` is still writable by any signed-in device** (migration 0001).
  Game membership no longer depends on it, but a team row can be deleted by
  someone who should not be able to.
- **Location sharing is untested on real phones.** A locked or backgrounded
  phone stops sending; the others see the dot fade after 30 seconds and
  vanish after two minutes. Whether that is acceptable on a real outing is
  worth finding out before relying on it.
