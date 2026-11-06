# JetLeg architecture

Deep reference. `SKILL.md` is the operational entry point — read that first for
how to verify and ship. This file is what to read before changing how something
works.

## Shape of the thing

```
pipeline/   build time. Fetches OSM + DataSF + GTFS, emits static GeoJSON.
            Runs on a laptop, occasionally. Output is committed.
app/        runtime. A local-first PWA. No server, no accounts, no sync.
```

~4,100 lines of app source, ~1,350 lines of pipeline, 33 data files (4.5 MB),
a 1.7 MB JS bundle plus a 0.5 MB MapLibre worker.

There is deliberately **no backend**. Each player's state lives in their own
phone's IndexedDB. A hider and a seeker running the app never exchange anything,
which is what makes the hider's position impossible to leak. Any future server
has to preserve that property — see ROADMAP.md, where it is the central risk.

## The engine (`app/src/engine`, ~1,270 lines)

### The core model

The game is a **discrete candidate set**: the 192 hiding zones. Every answered
question is a predicate over that set.

```
question + answer  ──>  "yes region" R (a polygon)
                        │
                        ├─> for each surviving zone Z:
                        │     answer YES → keep if Z ∩ R ≠ ∅
                        │     answer NO  → keep if Z ⊄ R
                        │
                        └─> render: R clipped to the boundary
```

Two things fall out for free: an exact remaining-zone count, and correct
handling of the fact that the hider roams inside a 500 m circle. The shaded
overlay on the map is a *rendering* of the result, never the source of truth.

Answers are **constraints, not steps**. Reordering the ask log provably cannot
change the result, and `engine.test.ts` asserts it. That is what makes undo,
delete and disable safe: the candidate set is recomputed from the log every
time rather than mutated.

### Files

| File | Role |
|---|---|
| `types.ts` | `Station`, `Question`, `Answer`, `AskEntry`. `Answer` is a discriminated union — `null` is its own answer kind, because the rulebook says a question with no subject on the map still counts as answered and still earns the hider a card. |
| `project.ts` | UTM 10N round-tripping. Every calculation happens here, never in lon/lat. |
| `regions.ts` | Turns one answer into a polygon: `radarRegion`, `thermometerRegion`, `matchingRegion`, `measuringRegion`, `tentacleRegion`, plus `playArea` which collapses the whole log into one in-play polygon. |
| `candidates.ts` | `evaluate()` — applies the log to the station set. Also `previewSplit()` for the question-quality indicator, and the caching that keeps both fast. |
| `spatial.ts` | Pre-projected layer index. Flat `Float64Array`s, built once per layer. |
| `questions.ts` | All 80 questions as **data**, not code. Swapping cities means swapping `public/data/`, not touching the engine. |
| `plan.ts` | `planCandidate()` — what a question *would* do if asked now. Builds its region by resolving a synthetic ask through `resolveAsk`, never by a parallel implementation, so a preview cannot disagree with the answer it previews. |

### Why UTM 10N, always

At San Francisco's latitude a degree of longitude is 0.79 of a degree of
latitude. A perpendicular bisector drawn in degree space is off by ~14°, which
across the city is hundreds of metres — enough to eliminate the correct zone.
Voronoi cells are worse, because a Voronoi diagram is a purely metric construct.

`toUTM` / `toLngLat` wrap proj4. `toUTMCached` memoizes, and `spatial.ts` goes
further by projecting whole layers once into typed arrays.

### Conservative vs strict

The rulebook says every answer describes the hider's *current location*, not
their hiding zone, and they may be anywhere in a 500 m circle.

- **Conservative** (default): a zone is ruled out only when its *entire* circle
  contradicts the answer. Can never eliminate the true zone.
- **Strict**: tests the station centre alone. Narrows faster, sometimes wrong.

A consequence that reads as a bug but is not: standing 320 m from a library, a
"further" answer eliminates nothing conservatively, because no 500 m circle fits
inside a 320 m disk. There is a test pinning this.

The property test is the strongest guarantee in the codebase: for every station,
generate the answers a hider there would truthfully give, feed them in, and
assert that station still stands. **If it fails, the geometry is wrong, not the
test.**

### Performance, and why the caches exist

Three layers of caching, each added in response to a measured freeze:

1. **`spatial.ts` layer index.** Nearest-feature used to re-project every
   segment per station through a string-keyed memo. `transitLines` has 19,542
   vertices, so opening Matching meant ~5.4M lookups and **froze the UI for 74
   seconds**. Projecting each layer once into `Float64Array`s made it 215 ms.
2. **`previewSplit` is centre-point, not conservative.** It answers a simpler
   question deliberately — how would this split the stations by their centres —
   which makes it pure arithmetic. It is advisory; the authoritative path stays
   exact.
3. **Region and verdict caches in `candidates.ts`.** Regions are pure functions
   of (question, origin, destination, answer); verdicts are pure functions of
   (region, station set, strictness). Re-evaluating after an undo is then set
   intersection, not thousands of polygon predicates.

Layer indexes are warmed during `requestIdleCallback` after load, so the first
tap on a category is instant. Target: category switches in single-digit ms with
CPU throttled 4x.

## Frontend (`app/src/`)

Vite + React + TypeScript. MapLibre GL JS for the map, turf for geometry,
Zustand over IndexedDB for state, vite-plugin-pwa for offline.

### State (`store/game.ts`, ~290 lines)

One Zustand store, persisted to IndexedDB via `idb-keyval`. Not localStorage —
no 5 MB cap, and it survives properly.

```
role                  seeker | hider
rounds[]              { id, role, asks[], hiderStationId, seekerPin }
activeRoundId
settings              gameSize, strictness, units, supervisorDistrictsAsAdmin4
visibleLayers[]       POI layers and "<key>:voronoi" cell layers
mapLayers             outOfPlay, zoneBuffers, stationDots
manualLocation        { enabled, coords }
hiderPlaceTarget      me | seekers      (hider, manual mode)
armSeekerPin          next tap places the seekers' pin
sheetCollapsed
```

Rounds are namespaced by role, so hiding in round 1 and seeking in round 2 stay
separate. `requestPersistence()` asks for a durable bucket on load — without it
iOS evicts IndexedDB under pressure, which for an all-day game means losing the
round.

### Map (`map/MapView.tsx`, ~690 lines)

One component owning ~20 MapLibre layers, drawn bottom-up: out-of-play mask →
zone circles → answer overlays → Voronoi cells → POIs → stations → hider zone →
GPS/manual point → pins.

Three things here are load-bearing and easy to break:

- **Layers install on `style.load`, never `load`.** `load` waits for basemap
  tiles, sprites and glyphs; when those are unreachable it never fires, and the
  player gets no game layers at exactly the moment they matter most.
- **`setWorkerUrl` with `?worker&url`.** Not `?url` — that copies the worker
  verbatim without resolving *its* imports, and the map renders nothing.
- **`text-font: ['Noto Sans Regular']` on every symbol layer.** MapLibre's
  default stack 404s against the basemap's glyph server and labels vanish
  silently.

The redraw effect has an explicit dependency list. Every new prop that affects
drawing must be added to it — omitting `pins.seekers` once meant the seeker pin
never repainted, and only appeared later when some unrelated prop changed.

### UI (`ui/`, ~1,620 lines)

`TopBar` (role, zone counter, tabs, GPS/manual toggle) · `SeekerPanel` (question
browser, plan, ask log) · `HiderPanel` (answer assistant, exposure view) ·
`MapToolbar` → `MapLayers` + `MeasurePanel` (the on-map controls) · `PlanPanel` ·
`LayerPanel` · `Diagnostics` · `RoundGate`.

The sheet collapses to give the map ~88% of the screen.

**Question quality indicator**: every question shows how the answer would split
the surviving zones, and null / always-yes questions are greyed with the reason.
On an SF-only board a real fraction of the 80 carry zero information, and
spending a turn on one hands the hider free cards for nothing.

**Measuring toolbar** (`MeasurePanel`, `map/overlays.ts`): circles of a stated
radius and free lines with a length label on every leg. Planning scratch, not
game state — nothing it draws eliminates anything — but a circle reports how many
surviving zones it contains, which is a radar preview from any point on the map
rather than only from where the seeker happens to be standing. Shapes persist,
because a circle drawn to reason about the next question is worth the same an
hour later. Arming a tool closes the panel: it is 14.5 rem wide on a 414 px
screen, over the part of the board being measured.

**Plan layer** (`engine/plan.ts`, `PlanPanel`): up to three shortlisted
questions, each with its split, its worst case, whether it can split at all, and
its candidate region drawn on the map in its own colour — dashed outlines in a
palette deliberately outside the answer-overlay one, because a hypothesis must
never render like a fact. The cap is the feature: comparing everything is what
the question list already does.

Candidate regions anchor on a **coarse position** that only moves when the player
has moved 50 m, and are computed in an effect rather than a memo. A measuring
region is a union of disks over every park on the board; rebuilding three of them
per GPS tick is the 74-second freeze in a new costume.

**Hider exposure view**: the hider logs the answers they gave, and the same
engine shows what the seekers can deduce. This works because the rulebook has
seekers running trackers the hider can follow — so the hider genuinely knows
where the seekers are. If the hider's own zone gets ruled out by their own
answers, the app says so: an answer was recorded wrong.

### Location (`location/useLocation.ts`)

`watchPosition`, not `getCurrentPosition` — questions anchor on where the seeker
is *now*. Denial is a first-class state, not an error; every flow also accepts a
hand-placed point. A backgrounded mobile browser suspends the watch, so the hook
re-acquires on foreground and exposes fix age rather than pretending.

Manual mode calls `clearWatch` outright. A bad urban-canyon fix is worse than no
fix, because it silently anchors answers to the wrong place.

`useFixAge` is a separate hook on purpose: a clock inside the shared location
state re-rendered the whole app every second, which re-ran the full map redraw
and replaced DOM nodes mid-tap.

## Backend (`supabase/`, `app/src/sync/`)

Phase 1 of `ROADMAP.md`, narrowed to one slice: **end-of-game history only.**
No live sync between a hider's and a seeker's phone, no login, no accounts.
The local-first design above is unchanged — IndexedDB stays the only source
of truth while a round is in progress; Supabase only ever receives a
completed round, once, after it ends.

**And only if the player has asked for that.** `settings.shareHistory` is off
by default and `endRound` checks it before calling the sync at all. Joining a
game room gives a device the profile and team the sync needs, which used to
be enough to start uploading every round that ended; the switch (on the stats
page, `#/stats`) is now the only thing that does. An imported game file
cannot turn it on — `importJSON` drops that one setting.

### What syncs, and what never does

`app/src/sync/payload.ts` builds the synced shape from a `Round` and is the
one place this rule is enforced in code, not just in review:

- The hider's `hiderStationId` syncs exactly — it's already just a
  `Station.id`, and once the round has ended it's historical record, not a
  live position to protect.
- `AskEntry.origin`/`destination` sync **only** for `radar` and
  `thermometer` questions, and only after `jitter.ts` offsets them up to
  1 km in UTM (`toUTM`/`toLngLat`, the same projection the engine uses
  everywhere else). Every other category syncs no position field at all.
- `Round.seekerPin` and every raw GPS point never leave the phone in any
  form, jittered or otherwise.
- Every timestamp becomes a `played_on` date; ask order survives as a plain
  `seq` integer. `Round.duration_s` is the one derived number that still
  ships, computed from the device's own local instants.
- `sessions.raw_state` carries a full sanitized snapshot of the round
  alongside the normalized `rounds`/`asks` rows, so history stays returnable
  even if the normalized schema changes shape later.

### Identity, without login

`identity.ts` uses Supabase **anonymous auth** — `signInAnonymously()`,
no email/password prompt — so RLS has a real `auth.uid()` to gate on. This
was a deliberate deviation from the plan this branch was built from, which
had sketched a bare client-generated `profiles.id`: Postgres RLS cannot
verify a value the client merely asserts in its own request, so that version
of the guard would have blocked nothing. `profiles.display_name` is the only
thing a player actually enters; a shareable `teams.join_code` groups
multiple devices' profiles onto the same game.

### RLS, and the recursion trap

`supabase/migrations/0001_game_history.sql` gates every table on team
membership. The first version of the `team_members` policy queried
`team_members` from inside its own `using` clause and Postgres rejected it
as infinite recursion — every reference to a table re-runs that table's RLS,
including from inside another policy's subquery, so a table's policy can
never safely read itself. Fixed with a `security definer` helper
(`my_team_ids()`) that runs as the function owner and so bypasses RLS on
that one internal lookup instead of re-triggering it; `sessions`, `rounds`
and `asks` policies call the same helper rather than re-deriving team
membership each with their own subquery.

### Games, teams, and the sessions rename (`0004_games_teams.sql`)

The table originally called `games` here — one team's synced history of a
completed round — was renamed to **`sessions`** to free up `games` for a
different, later concept: a container of multiple **teams** (opponents),
each holding multiple players via the existing `team_members`. Full detail,
including the entitlement-scoping this enables, lives in
`references/payments.md` — the short version: `teams.game_id` and
`entitlements.game_id` both point at the new `games` table, and because
`teams` was already broadly readable by any signed-in device, "which teams
are in my game" already works with zero new RLS policy. `rounds`/`asks`
stay exactly as gated as before — this only ever exposes that a team
exists, never its round data or hider position.

### Sync path

`endRound()` in `store/game.ts` dynamically imports `sync/index.ts` and
calls `syncFinishedRound`, fire-and-forget — a sync failure must never
surface as a game error. `queue.ts` holds anything that failed to send
(offline, no backend configured, a paused free-tier project) in IndexedDB
and retries on the browser's `online` event. With no `VITE_SUPABASE_URL`
configured, every function in this path no-ops immediately; the local game
is fully playable with no backend at all, same as it always was.

### Environments

One Supabase project, not a dev/prod split: local Docker Postgres
(`supabase start`) for iteration, the same cloud project for predeploy
testing and production. `app/verify-sync.ts` (run via `tsx`, not
Playwright — this path never touches the map) exercises the real
identity → payload → insert path against a running Postgres and is the
test that actually matters: it signs in a second, unrelated device and
asserts it reads back zero rows for another team's session, rather than
trusting the schema to imply that on its own.

## Game rooms and live location (`app/src/live/`, `0005_game_rooms.sql`)

The first thing in the app that is live between phones, and scoped to exactly
one thing: **seekers' positions, shown on the map of everyone in the same
game.** No asks, no answers, no round state.

### The room

A game has a six-character `join_code` — the game token. Rooms are bought
(`0015_room_passes.sql`, see `payments.md`): the buyer comes back from Checkout
to the **Game** tab with their room's code pre-filled (`entitled_game_code()`);
everyone enters the code, then joins a listed team or adds one. Joining takes
one of the room's eight places, for good. Only developers can create a room
for nothing (`create_game`).

Membership lives in `game_members`, and is written **only** by
security-definer functions (`create_game`, `join_game`, `set_game_role`,
`leave_game`) — there is no insert policy. `team_members` could not be
reused: its policy lets any signed-in device join any team id, and `teams`
is world-readable to signed-in devices, which is tolerable for finished
history and not for a live position. `team_members` is still kept in step,
so a finished round syncs to the same team with no second code.

### The positions — relayed, never stored

Positions travel as Supabase Realtime **Broadcast** on a private channel
`game:<game id>`. Realtime relays a client broadcast to whoever is subscribed
and keeps nothing; there is no table for positions, and `realtime.messages`
stays empty (checked). On the receiving phone, peers live in React state
only — nothing under `live/` writes a position to IndexedDB, and a reload
forgets them. A seeker sends on movement (at most every 3 s) and re-sends
every 10 s so a late joiner sees them; a dot fades after 30 s of silence and
is removed after 2 min.

### The fairness rule, in two independent layers

1. **The app builds no message for a hider.** `share.ts`'s
   `outgoingLocation` is the only place a position becomes sendable, and it
   returns null unless the role is `seeker`. The sending half of
   `useLiveLocations` exists only inside a seeker's run of the effect, and
   `App.tsx` does not even pass a hider's position into the hook.
2. **Realtime refuses a hider's broadcast.** `game_members.role` defaults to
   `hider`; the insert policy on `realtime.messages` passes only for
   `my_seeking_game_ids()`. Realtime evaluates that **when the channel is
   joined**, so the hook declares the role (`set_game_role`) and rebuilds
   the channel on every role change — keep those two together. Role
   declarations are queued so a fast seeker→hider flip cannot land out of
   order.

`verify:room` forges a hider broadcast over both the socket and Realtime's
HTTP endpoint and asserts no seeker receives it. `verify:room:ui` watches
every frame and request the hider's browser sends for its own coordinates.

### The hider's seekers point

The hider's answer assistant measures from "where the seekers are", which
was a pin dropped by hand (`Round.seekerPin`). In a game it is now a live
seeker: `pickFollowed(peers, choice)` in `share.ts`, where the choice
(`seekerFollow` in the store) is `'auto'`, a seeker's id, or `'manual'`.
Auto is stable — first by name — never "whoever spoke last", or with two
seekers the point would hop between them every few seconds. With two apart,
the hider picks, because a question is asked from where its asker stands.

`App.tsx` derives the point on every update (`followed?.coords ??
round.seekerPin`) and hands it to `HiderPanel`; it is **not** copied into the
round, so a live position is never written to storage and the pin cannot lag
the dot it stands for. On the map the followed seeker's own dot is drawn in
the pin's purple and the hand pin is not drawn. Placing a pin by hand
switches to `'manual'`; while following, a plain map tap places nothing. A
logged answer still records its origin in the ask log, as it always did. The
thermometer's start and end can each be set to the followed seeker's
position at the moment they call it.

### Map

`peers-dot` / `peers-label`, from the `peers` source. They repaint in their
own small effect in `MapView`, not through `redraw` — a peer moves every few
seconds, and `redraw` rebuilds every zone polygon.

## In-game chat (`app/src/chat/`, `0013_game_chat.sql`)

Two threads per game room. **Questions**: a seeker asks a catalog question,
every phone counts down from its time limit, and a hider answers by hand
(hit/miss, closer/further, hotter/colder, a tentacle place, null, or a
photo). Nothing is ever answered for them. **Chat**: free text.

**None of it is stored on a server.** Items are Realtime broadcasts on the
private channel `chat:<game id>` (0013 only says who may use it), relayed
and kept by no one. Each phone keeps its own copy in IndexedDB beside its
rounds (`chat/local.ts`); rounds name the games they had chat in
(`Round.chatGames`), the game file carries those chats with their photos,
and a game's chat is deleted once no round names it and the phone has left
the game. A phone that slept catches up from the other phones (`hello` /
`sync`), not from a server.

No position goes in a chat item. The seeker's origin waits in
`Round.chatAsks` on their phone; when the answer arrives it becomes an
`AskEntry` with `chatId` (idempotent), and the zone count moves. The hider's
copy is measured from the asker's live dot. Photos are re-encoded and
stripped of metadata before they leave the phone, because a camera's EXIF
is the hider's GPS position. Full detail, invariants and traps: the
`jetleg-chat` skill.

## Community maps and the map studio (`app/src/community/`, `app/src/studio/`)

People publish their own boards, play each other's, and discuss them. All of
it happens on a second page, the **map studio** at `#/maps` — `main.tsx`
mounts either the game (`App`) or the studio (`StudioApp`), never both. The
game keeps one link to it (Map tab) and otherwise only loads whichever map
was chosen there. A hash route, not a path, so it works unchanged on static
hosting, the LAN dev server and an installed PWA.

The studio's map always shows a real board built by `applyMap` — the draft
being edited, the map whose page is open, or the board in play — so a map
looks there exactly as it will when played.

### What a map is

A `*.jetleg-map.json` document, in one of two kinds. `format.ts` is the single
validator: a file off disk, a row from the server and a draft about to be
published all go through `parseMapFile`.

- **`kind: 'stations'`** — a station list plus house rules, for the shipped
  San Francisco board.
- **`kind: 'pack'`** — a whole board for any city: one boundary polygon,
  stations, every layer in `data/layers.ts` it has features for, and the
  Voronoi cells of each point layer. `customVoronoi` lists the layers whose
  cells the author supplied by hand; every other layer's cells are rebuilt
  from its points whenever the pack is finalized, so they cannot drift.

`board.ts`'s `applyMap(base, map)` turns either into `GameData`. A station
map is the base board with stations swapped; a pack keeps **nothing** of the
base — a layer it does not carry is a category not in play. Zones always come
from the engine's own `zoneOf`. The chosen map is stored whole in IndexedDB
(`active.ts`) with its exact version id, so it plays offline and an author's
later version never changes a board mid-game.

### The engine had assumed one board, in one place

Three assumptions broke, and each would have been silent:

- **The projection was a constant, UTM 10N.** UTM is only accurate near its
  own central meridian; San Francisco's zone applied to New York is off by
  more than 5%. `project.ts` now takes its zone from the board
  (`setProjectionCenter`), and San Francisco's centre still gives 10N.
- **Caches were keyed for one board**: zones by station id, verdicts by
  station *count*, layer indexes by layer *name*, answer regions by the
  question alone. `engine/reset.ts`'s `enterBoard(bbox)` re-centres the
  projection and drops all of them. Both pages call it inside the memo that
  builds their board, so nothing can be evaluated against a board the engine
  has not entered. **Any new cache in the engine must be cleared there.**
- **The map view and its boundary were set once.** `MapView` now refits to
  `data.bbox` when it changes and redraws the boundary source — otherwise a
  new city loads correctly under a camera still looking at San Francisco.

`pack.test.ts` pins the claim that matters: San Francisco assembled as a pack
eliminates exactly the zones the shipped board does, for matching, measuring,
radar and thermometer; and a Sydney board plays correctly with nothing of San
Francisco in it.

### The pipeline, in the browser

The studio's tabs are the pipeline's steps, as functions that run on any
boundary. `pack.ts` decides, `osm.ts` fetches, `studio/Editor.tsx` draws.

| Pipeline | Studio | Where |
|---|---|---|
| 01 boundary | find a place (Nominatim), draw, or import; keep the largest landmass; simplify | `largestLandmass`, `simplifyBoundary` |
| 02 stations | fetch transit stops (same Overpass query), fold same-named stops within 150 m; tap to add/remove; import | `parseStations` — the short form, no routes |
| 04 pois | the same twelve selectors and exclusions, in the board's **one** combined request | `POI_DEFS`, `fetchAllPois` |
| 05 linear | transit lines; coastline from OSM or from the boundary's own edge | `parseTransitLines`, `coastlineFromBoundary` |
| 06 voronoi | cells built in the board's UTM zone, cut to the boundary; or hand-made cells imported | `engine/voronoi.ts`, `finalizePack` |
| overrides.json | tap a place and remove it | Places tab |
| closing audit | "none — null", "only one — always yes", per layer | `auditPack` |

Two things learned the usual way. Twelve Overpass requests in a row from a
browser get rate-limited by the fifth, and even four cost four turns in a
public queue that is the whole of the wait: stations, places, coastline and
lines are now one request (`boardQuery`, split by `make section` markers),
started when the boundary is set and shared by every tool. The fetch, its
mirror failover and its measured timings are in the `jetleg-osm` skill. And cutting every cell against a detailed boundary took
22 s for San Francisco: `voronoiCells` now tests, exactly and in the plane,
whether the boundary's outline touches a cell at all, and skips the polygon
intersection for the majority that it does not. The cells are checked against
nearest-feature truth on a sampled grid (`voronoi.test.ts`), in two
hemispheres.

Districts (03) and the county line are city-specific sources and have no
studio tool; a pack has no administrative divisions.

A round is stamped with its board (`Round.board`). The Results tab refuses to
show zone counts for a round played on a different board than the one loaded,
rather than scoring it against the wrong stations.

### The git-like part

| Git | Here |
|---|---|
| repository | `community_maps` — one author, one line of history |
| commit | `community_map_versions` — immutable, each names its parent |
| fork / branch | a new map with `parent_map_id` + `parent_version_id` (and `parent_map_name`, which survives the original's deletion) |
| diff | `diffStations` — added / removed / moved / renamed |

There is no merge and no pull request. Versions have no insert/update/delete
policy at all; only `publish_map()` and `publish_map_version()` write them,
after `validate_map_content_()`. A new version cannot change a map's kind or
city. The three references a map holds to other maps and versions are
`deferrable initially deferred` (0009): deleting an account cascades through
its maps, likes and comments in one statement, and a mid-statement check saw
a branch still pointing at a version that had just gone.

### Who may write

Reading is open to everyone, signed in or not. Writing needs a **verified
email** — `is_signed_in()` checks the JWT's `is_anonymous` and `email` claims,
because anonymous auth gives every device an `auth.uid()` and so that alone
proves nothing. `account.ts` signs in with a typed six-digit code (a link
would open in the browser, not the installed PWA): a new address is attached
to the device's existing anonymous identity, keeping its id, pass and game;
an address that already has an account replaces the device's identity, and
its cached profile/team/game/pass are dropped. `supabase/templates/` puts the
code in the email — a cloud project needs those pasted into the dashboard.

Author names are copied from `profiles` by the server at write time, never
taken from the request. Reactions are readable only by their owner; totals
live on the map row and are recounted under a per-map **advisory** lock — a
plain recount loses concurrent likes, and a row lock deadlocks against the
foreign key's own key-share lock.

## The site around the game (`app/src/route.ts`, `app/src/pages/`)

The game used to *be* the site. It is now one page of several, chosen by
hash in `route.ts` and switched in `main.tsx`:

| Hash | Page | |
|---|---|---|
| `#/` | `pages/Landing.tsx` | a still picture of the built-in board, and the way in |
| `#/start` | `pages/StartGame.tsx` | pick a city, pick one of its maps, play |
| `#/play` | `App.tsx` | the game, unchanged |
| `#/maps`, `#/maps/new`, `#/maps/map/<id>` | `studio/StudioApp.tsx` | browse, create, one map's page |
| `#/stats` | `pages/StatsPage.tsx` | any round or game file, question by question |
| `#/about`, `#/privacy` | `pages/InfoPages.tsx` | |

Only one page is mounted at a time, and the three that evaluate anything
(game, studio, stats) each `enterBoard` their own board when they do.

- **The landing map is a JPEG**, `public/landing-sf.jpg`, taken by
  `npm run shot:landing` from the studio's own map. It does not follow the
  board: retake it after `npm run promote`. The script refuses to save a
  picture in which the zones or the basemap did not draw.
- **Stripe returns to the root** with `?checkout=…`. `main.tsx` moves that
  to `#/play` before the first render, and `App.tsx` keeps the hash when it
  strips the parameter; lose either and a buyer lands on the landing page.
- **Which map's page is open is in the address**, not in the studio's
  state. Closing an editor therefore returns to wherever the address
  points, so publishing has to say `go('/maps')` itself.
- **Choosing a board is one function**, `community/choose.ts` `playOn`, used
  by the studio and by Start a game: refuse mid-round, run `checkMap`, store
  the map, apply its house rules, go to `#/play`.

### The city directory (`community/cities.ts`, `0011_city_directory.sql`)

Start a game searches the cities that have maps. A city is the short label
its maps are filed under, not a gazetteer entry; the shipped board's city is
always present and counts as one map, server or no server.

- `community_maps.country` — ISO alpha-2, lowercase, copied from the map
  file at publish time like `city`. The studio fills it from the Nominatim
  result when a boundary is taken from one, and it can be typed by hand.
  Optional: no country means a globe, not a refusal.
- `community_cities` — a `security_invoker` view, one row per city: the
  country most of its maps name, and its number of **main** maps. A branch
  is `parent_map_name is not null`, not `parent_map_id` — the id goes null
  when the original is deleted, the name is kept for exactly that.
- The count is capped at 11 in the view and shown as "10+". It caps the
  number shown, not how many maps a city may have.

### Round stats (`stats/wrapped.ts`, `ui/RoundWrapped.tsx`)

`roundStats(round, board, strictness)` is a pure function of a round's log
and the board it was played on. It calls `evaluate()` once and derives every
zone count from the verdicts' `killedBy` lists — a zone falls to the first
answer that contradicts it — so a number on the stats page cannot disagree
with what the round showed while it was played. The test replays the log one
question longer at a time and checks the two agree.

- **"Best" is the largest share of what was left**, not the most zones: a
  late question that cuts 4 zones to 1 did more than an early one that cut
  190 to 150. The biggest raw cut is reported separately when it differs.
- **Not everything is scored.** A photo, a disabled entry and a question
  about a layer the board does not carry are outside what the map can
  judge, and are left out of best/worst rather than counted as worthless. A
  null answer *is* scored: it is an answered question that ruled out nothing.
- **Distances are great-circle**, not the engine's `metres()`, which
  projects through whichever board is loaded. They are display only.
- **The board is optional.** A round stamped with a map this device does
  not have gets timings and movement, and nothing about zones.
- **Where the hider was** can be told to a finished seeking round
  afterwards (`setRoundHiderStation`); that is what unlocks distance to the
  hider, and "the answer that ruled out the real zone".

`stats/gamefile.ts` is the one reader of the export format, used by the
stats page and by `importJSON`. It validates every round and question and
counts what it leaves out, because a file is something a person can edit.
Opening a file on the stats page uploads nothing and imports nothing;
`verify:flow` asserts the browser makes no non-GET request while doing it.

## The editor's tools (`studio/Editor.tsx`, `community/simplify.ts`)

- **Zone size per map.** `rules.zoneRadiusM`, 100–2000 m, left out of the
  file when it is the default 500. It is the board's, like the projection:
  `applyMap` returns it on `GameData`, `enterBoard` hands it to the engine,
  and `zoneOf` takes it explicitly when building a board's zones, because
  `applyMap` runs before `enterBoard`. Verdicts are cached per radius.
- **Selecting.** `picking` turns map taps into toggles on `picked`, which is
  station ids on the Stations tab or the open category's place ids on
  Places. `pickedFc` rings them on the map (`picked-ring`, its own layer and
  its own entry in the redraw dependencies). Bulk actions go through `patch`
  like every edit, so all of them can be undone (`undo`, the last 40 drafts).
- **Layers on the studio map** (`studio/StudioLayers.tsx`): station points,
  hiding zones, each places category and its Voronoi cells. It keeps its own
  state, so looking at a map in the studio changes nothing in the game. The
  category being edited stays drawn whatever the switch says, because its
  points are what the taps land on. The game's on-map panel (`ui/MapLayers.tsx`)
  has a Places section bound to the same `visibleLayers` as the Map tab.
  Both panels cap their height at the screen and scroll as one list.
- **Selection shapes.** Tap, rectangle, lasso or polygon, each adding to or
  removing from the selection; on Stations a shape can match points or any
  part of a hiding zone (`studio/select.ts`). Rectangle and lasso are drags:
  while one is on, MapView disables `dragPan`, sets `touch-action: none`
  and reads pointer events, so a mouse and a finger work the same way; a
  second finger cancels the shape so a pinch still zooms. A drag under 8 px
  is still a tap. Polygon is tapped out through `editorTap` and drawn with the
  boundary tool's draft style.
- **Simplify** is maximum independent set on the "closer than the spacing"
  graph: greedy by fewest undecided conflicts, then (1,2)-swaps until none
  gains, then same-count swaps toward rail and metro. Against an exact solver
  on 300 random layouts it is optimal 295 times and one short 5 (the test
  prints this). Its answer becomes the selection: nothing is deleted until
  the author deletes it. On the shipped board at 500 m it keeps 70 of 192 with
  no overlap, or 157 allowing half-overlap.

## Resuming rounds (`App.tsx` `resumeRound`, `store/game.ts` `resumeRound`)

Any round can be played again, finished or not. A finished one is reopened:
`endedAt` is cleared, and ending it again ends it anew.

- **The round's board comes first.** A log names stations by id, so a round
  resumed on another board would be scored against the wrong stations.
  `resumeRound` in App compares the round's stamp with the board in play and
  puts the round's back: the built-in board, or a published version fetched
  by id (`getVersion`). A map opened from a file cannot be fetched, so that
  round is refused, with the reason. The store's own `resumeRound` changes
  nothing but the round and the role.
- **Ended rounds need a pass to reopen**, as starting one does. Unfinished
  rounds resume free, as they always did.
- **A seeker's map never draws `hiderStationId`.** A seeker can record where
  the hider was once a round is over (stats), and that round can now be
  resumed.
- **History sync replaces, never duplicates** (`sync/write.ts`). The session id
  is the round's id, and every write upserts the session and round and deletes
  questions the log no longer has. Before this, a round synced twice failed on
  its own id, and because `flushQueue` stops at its first failure, every round
  queued after it stopped syncing too.

## Google sign-in (`community/account.ts`, `0012_google_sign_in.sql`)

The one sign-in that leaves the page, and the reason the Supabase client is
built with `flowType: 'pkce'`. The default implicit flow returns tokens in the
URL fragment and then clears it, and the fragment is this app's page
(`route.ts`). PKCE returns `?code=` and removes only that.

- **Where to come back to** is kept in `sessionStorage` before leaving
  (`auth/google-pending`), because the redirect goes to the bare origin: a
  fragment in `redirectTo` would collide with the `?code=` Supabase appends.
  `restorePageAfterGoogle()` puts the page back synchronously in `main.tsx`,
  before the router reads it. `finishGoogleSignIn()` settles the rest.
- **Same two cases as email.** An anonymous device *links* Google
  (`linkIdentity`, needs manual linking on the project), so its pass and game
  carry over. If that Google account is already someone's, the callback says
  `identity_already_exists` and the app signs into it instead, forgetting the
  device's old identity. Failures come back in the query *or* the fragment and
  are handled from both.
- **Only an email and a name are kept.** Triggers on `auth.identities` and
  `auth.users` cut Google's claims to an allow-list on every write. That is an
  allow-list, so a claim Google adds later is dropped by default. Supabase
  cloud accepts these triggers (pushed 31 Oct 2026).
- **The button asks first.** `googleEnabled()` reads `/auth/v1/settings`, so
  it never shows where Google is off. `verify:google` stands in for Google
  and Supabase's settings. It proves the round trip, not a real Google
  sign-in.

## Developer access (`0007_developers.sql`, `app/grant-developer.ts`)

A `developers` table of email addresses, invisible to every client. A signed
in user whose verified email is on it gets `eligible: true, product:
'developer'` from `check_and_activate_entitlement()` with a rolling 30-day
expiry, so the existing offline cache carries them through a day with no
signal and lapses within a month of being removed. The list is data, not
migration: `npx tsx grant-developer.ts <email>` per environment.

## The testing code (`0010_test_logins.sql`, `supabase/functions/test-login/`)

A fixed sign-in code, so testing does not need an inbox — or a mail provider.
Off unless the function's `TEST_LOGIN_CODE` secret is set, and then only for
addresses in the service-role-only `test_logins` table (`app/test-login.ts`).
Every refusal reads the same, so it cannot be used to discover testers; ten
wrong codes lock an address. On a match the function returns a one-time Auth
token, not a session — the app redeems it through the ordinary verify call
(`account.ts`, tried only after the emailed-code check fails), so Auth mints
the session as it would for anyone. `verify:developer` covers it, including
that it is inert with no secret set.

## Payments (`supabase/functions/`, `app/src/payments/`)

Phase 3 of `ROADMAP.md`: starting a round (including fully local, solo
play) requires a paid, per-device entitlement — a deliberate departure from
this project's own "sign-in and network should never be required to play"
invariant. Map display (the map itself, layers, round history/export, the
Results tab) stays free; game mechanics (starting a round, asking/answering
questions, the elimination shading, Measure/Plan) require an active,
entitled round. **Full detail — schema, RLS, edge functions, the admin
grant tool, the gotchas — lives in `references/payments.md`.**

## Pipeline (`pipeline/`, 8 steps)

Ordered; each depends on the last. Output lands in `app/public/data/` and is
committed, so the app builds with no network.

| Step | Output | Notes |
|---|---|---|
| `01-boundary` | `boundary.geojson`, `bbox.json` | Unions the 11 trimmed DataSF supervisor districts, keeps the largest ring — which drops Treasure Island automatically. 119.87 km². |
| `02-stations` | `stations.*`, `zones.geojson` | The OSM-derived board. Superseded in production by step 08, kept as the reproducible path and for mode/route recovery. |
| `03-districts` | `districts.geojson` | 11 supervisor districts, island fragments stripped. |
| `04-pois` | `poi-*.geojson`, `rail-stations.geojson` | One Overpass query per category. Everything reduced to a point, because the rulebook measures to the map icon. |
| `05-linear` | `coastline`, `county-line`, `transit-lines` | The city boundary doubles as the shoreline. |
| `06-voronoi` | `voronoi-*.geojson` | d3-delaunay in UTM, clipped to the boundary. 11 layers. |
| `07-stations-gtfs` | `stations_v2.geojson` | GTFS-derived stops. `route_type` states the mode outright — 5 really means cable car — where OSM has to be inferred. |
| `08-promote-stations` | `stations.json`, `zones.geojson`, `stations.geojson` | Promotes a hand-built set from `stations_versions/` to production. |

`lib.ts` handles caching, a User-Agent (Overpass rejects Node's default with
406), retry with backoff, and rounds coordinates to 7 decimals on write — raw
float output roughly doubled every layer for no gain.

Assertions in each step are load-bearing. A station count outside 200–350 or an
empty POI layer is a real signal, not noise to silence.

### The overrides file

`pipeline/overrides.json` records categorization rulings. OSM tags a goat-petting
pen as a zoo and a trampoline park as an amusement park; the rulebook resolves
this with a "5+ Google Reviews" test or by agreement, neither of which works
offline mid-game. The shipped layer file *is* the ruling. Review before game day.

## Build and deploy

```
npm run build   tsc -b && vite build && scripts/check-build.mjs
npm test        23 engine tests
npm run verify  e2e-verify.cjs — drives a real browser
npm run deploy  build + wrangler + scripts/check-deploy.mjs
```

Two guards exist because both failure modes are silent:

- **`check-build.mjs`** walks every emitted chunk and fails if a relative import
  did not get emitted. Catches the worker class of bug.
- **`check-deploy.mjs`** checks content *types*, not status codes. Cloudflare
  Pages answers a request for a missing file with `200 OK` and the contents of
  `index.html`, so a half-uploaded site passes every ordinary check while being
  completely broken.

Hosting: Cloudflare Pages, `jetleg.pages.dev`. `public/_headers` makes
`sw.js` and `index.html` always revalidate so a new deploy reaches an installed
PWA, while hashed assets are immutable.
