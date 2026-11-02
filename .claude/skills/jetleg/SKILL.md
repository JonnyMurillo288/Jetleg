---
name: jetleg
description: Build, verify, regenerate map data for, or deploy the JetLeg SF Hide+Seek app. Use whenever changing anything in app/ or pipeline/, or when the user reports the app misbehaving on a phone (blank map, frozen UI, denied location, stale deploy). Encodes the verification ladder that catches this project's failure modes, which are all silent.
---

# JetLeg SF — build, verify, ship

A local-first PWA for playing Jet Lag: Hide+Seek in San Francisco. `pipeline/`
generates static map data at build time; `app/` is the React + MapLibre PWA.
No server, no accounts — each player's state is local to their phone.

- **Deep architecture, engine internals, file-by-file:** `references/architecture.md`
- **Payments — schema, edge functions, admin grants, gating:** `references/payments.md`; product-facing doc at `PAYMENTS.md`, testing at `PAYMENTS_TESTING.md`, both at the repo root
- **Planned work — backend, accounts, payments, native app:** `ROADMAP.md` at the repo root
- **The map studio's OpenStreetMap fetch — query, mirrors, cache, parsers, timings:** the `jetleg-osm` skill (`.claude/skills/jetleg-osm/SKILL.md`)

## The one rule

**Every failure this project has produced was silent.** The build succeeded,
every HTTP status was 200, the console was clean, and the app was broken. Do not
conclude something works because a narrower check passed. Verify at the layer
that actually fails: for rendering, ask the map what it drew; for a deploy,
check content types; for responsiveness, measure with the CPU throttled.

Real examples, all shipped as "verified" before a user caught them:

| Bug | What looked fine | What actually caught it |
|---|---|---|
| MapLibre worker emitted with `?url`, so its own import 404'd | build passed, worker file returned 200 | `map.isStyleLoaded()` false, 0 rendered features |
| `allowedHosts: [...]` 404'd the whole dev server | preview on `127.0.0.1` was fine | actually loading `npm run phone` |
| Deployed build was stale | every URL returned 200 | `content-type: text/html` on a `.js` path |
| Question list froze the UI for 74 s | tests passed, app "worked" | timing a category switch |
| Label glyphs 404'd against the basemap | labels partly rendered | watching the network for 404s |
| Seeker pin never repainted | state correct, panel text updated | `queryRenderedFeatures` on the pins layer |
| Plan's split bar collapsed to 0 px wide | DOM correct, numbers present in the text | screenshotting the element and reading computed width |
| Matching cells bent by the projection, 9.2% of ground on the wrong side | tests green, cells named the right POI, map looked plausible | scoring the polygon against nearest-POI truth on a sampled grid |
| Deploys went to a *preview*, so the apex never moved | wrangler said "Success", the deploy guard said "looks good" | comparing the live bundle hash to `dist/index.html` |

Two of these were mine to begin with *and* I misdiagnosed them twice before
finding the cause. When a symptom is reported, reproduce it before theorising.

## Verification ladder

Run top-down. Each rung catches what the one above cannot.

```bash
cd app
npm run build      # tsc + vite + check-build.mjs (unresolved imports in output)
npm test           # 23 engine tests, ~90 s
npm run verify     # e2e-verify.cjs — drives a real browser, asserts zone counts
npm run verify:tools  # verify-tools.cjs — measuring toolbar + plan layer, at 4x CPU throttle
npm run verify:rules  # verify-rules.cjs — elimination rule, voronoi parity, hider radar + thermometer
npm run verify:units  # verify-units.cjs — one unit everywhere; sweeps every surface in metric
npm run verify:sync   # verify-sync.ts — game-history sync against a live Supabase (needs `supabase start`)
npm run verify:results # verify-results.cjs — plays a real round, ends it, checks the Results tab against it
npm run verify:payments # verify-payments.ts — entitlement RPC + RLS against a live Supabase (needs `supabase start` + `supabase functions serve`)
npm run verify:room    # verify-room.ts — game rooms + live sharing: who gets on the channel, and that a hider's broadcast is refused (needs `supabase start`)
npm run verify:room:ui # verify-room-ui.cjs — a hider and two seekers through the Game tab; asks the hider's map what it drew, watches what the hider's browser sends, and checks the hider's answers follow the chosen live seeker (that part needs TEST_LOGIN_CODE set, to start a round)
npm run verify:chat         # verify-chat.ts — game chat's relay: no table or bucket exists, members only, a paced photo arrives whole, nothing kept (needs `supabase start`)
npm run verify:chat:ui      # verify-chat-ui.cjs — ask, clock, answer by hand, zone count moves, catch-up after the app was closed, a GPS-tagged photo leaves with no EXIF, game file carries the chat, deleting rounds deletes it (needs TEST_LOGIN_CODE). See the `jetleg-chat` skill
npm run verify:update       # verify-update.cjs — an installed copy picks up a new deploy: on its own when just opened, by banner when in use (needs `npm run build`, no backend)
npm run verify:community    # verify-community.ts — community maps: who may publish/like/comment, versions, branches, concurrent counts, the real emailed-code sign-in
npm run verify:community:ui # verify-community-ui.cjs — two browsers in the map studio (#/maps): a station map, then a whole city (boundary, OSM stations + places, Voronoi built and hand-made), play it in the game, like, comment, branch. OSM is mocked.
npm run verify:developer    # verify-developer.ts — developer list, the fixed testing code (listed addresses only, lockout), then paywall -> sign in -> round starts, in a browser
npm run verify:layers       # verify-map-layers.cjs — the layers controls on the map, studio and game: station points, hiding zones, each places category, each category's Voronoi cells, the edited category staying on; every switch checked by what MapLibre drew
npm run verify:shapes       # verify-select-shapes.cjs — selection shapes with a mouse and with a finger (CDP touch events): rectangle, lasso, polygon, add/remove, points/zones, places; checked against an independent point-in-polygon count, and that the map does not pan while drawing
npm run verify:studio       # verify-studio-tools.cjs — the editor's tools: zone size (asks the map the radius it drew), select/deselect, bulk type change, delete, Undo, Simplify, moving places, an 800 m map played in the game
npm run verify:resume       # verify-resume.cjs — resuming rounds, ended ones included: the paywall, answers still applied, the round's own board put back (or refused, with why), Results' button, no hider pin on a seeker's map
npm run verify:google       # verify-google.cjs — Google sign-in's round trip with Google stood in for: button only when on, link vs sign-in, return page, refusals
npm run verify:flow         # verify-flow.cjs — the site around the game: landing picture, Start a game (city dropdown, flag, capped count, play), the stats page against a fixture file, a map page's address. Community steps SKIP without `supabase start`
TARGET=https://jetleg-sf.pages.dev/ npm run verify:tools   # any suite, against a deployment
```

Both browser harnesses need a server first: `npx vite preview --port 4310`.

If anything touched the map, rendering or layers — **ask MapLibre what it drew**,
because a blank map throws nothing:

```js
window.__map.isStyleLoaded()                                    // must be true
window.__map.queryRenderedFeatures({layers:['zones-alive']})    // must be > 0
window.__map.queryRenderedFeatures({layers:['stations-dot']})   // must be > 0
```

**Poll for the thing that changed, not a thing that is true either way.** Waiting
for `measure-seg-label` to appear after committing a line passed instantly — the
draft's own segments already matched that layer, so the assertion never observed
the commit. Wait for the draft layer to *empty* instead. A poll that is already
satisfied is indistinguishable from a passing test.

Healthy at default zoom: `styleLoaded: true`, ~206 zones, 192 stations, ~1000
total features. Zero of anything means the worker is dead.

Map layers the tools add: `measure-line` / `measure-draft` / `measure-vertex` /
`measure-seg-label` / `measure-label`, and `plan-line` / `plan-label`.

Reading a GeoJSON source's contents in a harness: `map.getSource(id).serialize().data`.
`_data` exists but is not updated by `setData`, so it lies.

If anything touched the question list or a layer, **time it with the CPU
throttled 4x** (`Emulation.setCPUThrottlingRate`). Category switches must be
single-digit milliseconds; anything over ~300 ms is a freeze on a real phone.

**The game is at `#/play`; the root is the landing page.** Every harness
appends `#/play` to `TARGET` itself, so `TARGET` stays an origin.

**`verify`, `verify:tools`, `verify:rules`, `verify:results` and `verify:units` currently stop
at the paywall** — they predate payments and start a round in a fresh browser
with no pass. They are not passing, they are not running. Until they sign in
as a developer first (see `verify-developer.ts` for how), do not read their
failure as a regression or their absence as a pass.

## Deploying

```bash
cd app && npm run deploy    # builds, uploads, then verifies the live site
npm run verify:live <url>   # check any deployment on its own
```

**Cloudflare Pages answers requests for missing files with `200 OK` and the
contents of `index.html`.** A half-uploaded site therefore passes every status
check while being completely broken. `check-deploy.mjs` checks content *types* —
the only way to see it. Never judge a deploy by status codes.

**The production branch is `production`, not `main`.** Once this became a git
repo, `wrangler pages deploy` began inferring the branch from git and publishing
**previews**: wrangler reported success, `main.jetleg-sf.pages.dev` updated, and
the apex `jetleg-sf.pages.dev` — the URL people actually open — kept serving the
old build for two features and a whole session. The `deploy` script now pins
`--branch production`. If the apex ever looks stale again:

```bash
npx wrangler pages deployment list --project-name jetleg-sf   # Environment column
```

`check-deploy.mjs` now also compares the live bundle hash against
`dist/index.html`, because every other check in it reads the live `index.html`
and so validates a stale deploy against itself.

When a user reports a problem on a deployed URL, **fetch the live site and
compare its asset hashes to the local build before theorising.** A stale deploy
has been the answer more than once.

## Regenerating map data

```bash
cd pipeline && npm run all          # ~5 min; Overpass rate-limits, it retries
npm run promote                     # promote stations_versions/stations_v2.geojson to prod
VERSION=v3 npm run promote
```

Steps are ordered and each depends on the last. Outputs land in
`app/public/data/` and are committed, so the app builds offline.
`pipeline/.cache/` holds raw fetches — delete it to force a refresh.

Assertions in each step are load-bearing. A station count outside its expected
band or an empty POI layer is a real signal, not noise to silence.

**After changing the station set**, re-run `pois` and `voronoi` — both
`rail-stations.geojson` and `voronoi-railStations.geojson` derive from
`stations.json`.

## Things that will bite

- **The landing page's map is a picture, and it does not follow the board.**
  After changing the station set, `npm run shot:landing` (needs a preview
  server and a connection) and commit `public/landing-sf.jpg`.
- **So are its product screenshots.** `public/marketing/*.jpg` (studio,
  seeker's phone, round stats) come from `npm run shot:marketing`, which
  also writes full-size PNGs to the git-ignored `Marketing/` folder. Retake
  them after a visible change to the studio, the seeker panel or the stats
  page. The site's copies stay tracked: ignored, a clean-checkout deploy
  would serve the app's HTML in their place with a 200. The landing copy may
  only claim what ships; `Marketing/website-copy.md` maps each claim to code.
- **MapLibre's canvas container is zero pixels tall** — the canvas overflows
  it. Its top-left is right for turning a pointer into a map point, but a
  harness that sizes anything by `getCanvasContainer()` draws a flat line.
  Measure `getCanvas()` instead.
- **A page that scrolls inside its own container defeats `fullPage`
  screenshots.** `.page` is the scroller, not the document, so Playwright
  captures one viewport and the rest of a long page goes unlooked-at. Grow
  the container first (`.page{height:auto;overflow:visible}`).
- **An installed copy of the app can run an old build for days.** The
  service worker serves what it has, and a browser only looks for a newer
  one when a page is freshly *opened* — a phone's home-screen app mostly
  resumes. A phone ran a day-old build that called `post_chat`, a server
  function a later deploy had removed. `src/update.ts` now looks on every
  return to the foreground and every 30 min, applies an update found in the
  first 10 s of opening, and otherwise shows a banner (registerType
  `prompt`, `clientsClaim` for the first install only). When a player
  reports something you have already fixed, ask whether they see the
  "new version" banner, and check the deploy history
  (`wrangler pages deployment list`) for what their phone could be running.
- **The game chat is never stored on a server.** It goes phone to phone
  over a broadcast relay and each phone keeps its copy with its rounds, in
  the game file, deleted with them. Do not add a table or bucket for it.
- **A photo's EXIF is the hider's exact position.** Anything that sends a
  picture goes through `chat/photo.ts` `preparePhoto`, never the raw
  `File`. The `jetleg-chat` skill has the rest.
- **Two `patch()` calls in one handler in the studio editor undo each
  other.** Each builds on the draft as rendered. Put both changes in one.
- **There is more than one board now, and the engine has to be told.** A
  community map can replace the stations or be a different city. Anything
  cached in the engine belongs to a board: clear it in `engine/reset.ts`'s
  `enterBoard`, and never key a cache on something that was only unique
  while there was one board (a layer name, a station id, a station count).
- **The projection follows the board**, not a constant. "All geometry runs in
  UTM 10N" below is true for San Francisco; elsewhere it is the board's own
  zone, set by `enterBoard`. Code that needs a projection for a board that is
  not loaded (the studio, building cells) takes one from `projectionAt`.
- **Mocks do not prove a public API's shape.** The studio's OSM tools passed
  against fixtures and then failed live: Nominatim refuses Node's default
  User-Agent (403), and Overpass rate-limits a dozen quick requests (429).
  After changing `osm.ts`, run `npm run time:osm -- "San Francisco"` and
  drive the studio once unmocked. Details in the `jetleg-osm` skill.
- **`npm run deploy:dev` leaves the dev build in `dist/`.** A local preview
  then talks to the cloud project. `npm run build` puts it back.
- **The local functions container can stop on its own**
  (`supabase_edge_runtime_JetLeg`, exit 15). The testing code then silently
  fails to sign anyone in. `docker start supabase_edge_runtime_JetLeg`.
- **Switching git branches breaks the running functions container.** `main`
  has no `supabase/`; after returning, edge functions fail with "failed to
  determine entrypoint" until `docker restart supabase_edge_runtime_JetLeg`.

- **All geometry runs in UTM 10N**, never lon/lat. A degree of longitude is 0.79
  of a degree of latitude here; bisectors and Voronoi cells built in degree
  space are wrong by hundreds of metres.
- **A straight line in UTM is a curve in lon/lat, and turf does not know that.**
  Computing in UTM is not enough: a polygon whose corners are unprojected has
  edges turf reads as straight *in degree space*. The 120 km half-planes used
  for Voronoi cells and the thermometer bowed far enough to misclassify 9.2% of
  the ground around the de Young. Build them with `utmPolygon`, which
  interpolates along every edge before unprojecting. Four points per edge was
  enough to fix it; it uses sixteen.
- **Two kinds of distance, and only one of them converts.** Rule constants are
  the rulebook's own words — "within 2 km", the radar and tentacle radii — and
  both players say them out loud, so they stay metric always. Distances the app
  *computes* follow `settings.units` and must go through `formatDistance`. A
  literal `m` or `km` in JSX is almost always a bug; `verify:units` sweeps the
  whole screen in metric mode and fails on any surviving `mi`/`ft`.
- **Formatting belongs at the edge, never in the engine.** `candidates.ts` used
  to build the string `seeker is 0.42 km from their nearest`, which printed in
  the ask log next to a panel reading miles. Resolved asks now carry `radiusM`
  as a number.
- **The engine must reuse the cells the map draws**, via `layer.cells`, not
  compute its own. A matching question *is* a question about those polygons, and
  two implementations of one shape is how they came to disagree in front of a
  player.
- **Conservative elimination must stay correct.** A zone is ruled out only when
  its *entire* 500 m circle contradicts the answer, because the hider roams
  inside it. The property test replays every station's own truthful answers and
  asserts none eliminates itself — if that fails, the geometry is wrong, not the
  test.
- **Symbol layers need `text-font: ['Noto Sans Regular']`.** MapLibre's default
  stack 404s against the basemap's glyph server and labels vanish silently.
- **Never gate map layer installation on `load`.** It never fires when basemap
  tiles are unreachable, which is exactly when the game layers matter most. Use
  `style.load`.
- **The map redraw effect has an explicit dependency array.** Any new prop that
  affects drawing must be added, or it silently never repaints.
- **`.list li` sets `align-items: center` and outranks a bare class on the same
  `li`.** That collapsed the plan's split bar to zero width while every number
  was correct in the DOM. Match the specificity (`.list.plan li.plancard`), and
  screenshot new UI rather than trusting the text content.
- **A flex container drops the whitespace text nodes between its children**, so
  `<b>{n}</b> yes` renders as `8yes`. Centre text with `text-align`, not flex.
- **Anything that costs real geometry must not be keyed on the live GPS fix.**
  The plan's candidate regions anchor on a position that only moves when the
  player has moved 50 m; a measuring region is a union of disks over every park
  on the board, and rebuilding three per GPS tick is the old 74-second freeze
  wearing a new hat.
- **`ZONE_RADIUS_M` is duplicated** in `app/src/engine/candidates.ts` and
  `pipeline/08-promote-stations.ts`. Rendered zones and the engine's zones must
  agree or the map lies about the count. It is now only the *default*: a map
  can choose its own (`rules.zoneRadiusM`), `enterBoard(bbox, radius)` sets it,
  and code that needs it reads `data.zoneRadiusM` or `zoneRadius()`. A new
  literal 500 anywhere is a bug on every map that chose otherwise.
- **The rulebook PDF is image-only.** `pdftotext` yields 38 bytes. Render pages
  with `LD_LIBRARY_PATH=/home/jonnym/lib pdftoppm -png -r 110` and read them.
- **`pkill -f <pattern>` kills the calling shell** when the pattern matches its
  own command line. Kill by PID, or start servers with `setsid nohup … & disown`.
- **A Postgres RLS policy that queries its own table is infinite recursion**,
  not a slow query — every reference to a table re-runs that table's RLS,
  including from inside another policy's subquery on the same table. Route
  through a `security definer` helper function instead (`my_team_ids()` in
  `supabase/migrations/0001_game_history.sql`). Caught by actually running
  the migration and inserting a row, not by reading the SQL.
- **A plpgsql OUT parameter named the same as a table column is ambiguous**
  inside that function's own embedded SQL — `check_and_activate_entitlement()`
  in `supabase/migrations/0002_entitlements.sql` named its OUT params
  `product`/`expires_at` to match `entitlements`' own columns, and an
  unqualified reference inside the function body errored
  `column reference "expires_at" is ambiguous` at call time, not at
  migration time. Qualify every reference with the table name. Caught by
  actually calling the RPC from `verify-payments.ts`.

## Running it on a phone

Geolocation is blocked on insecure origins, so plain LAN HTTP is useless — the
app loads and never gets a fix.

- `npm run phone` — dev server over self-signed HTTPS on the LAN. Fine for the
  couch, but iOS Safari may refuse service workers behind an untrusted cert.
- `npm run deploy` — real certificate. The right answer for game day.

The `?` tab self-checks secure origin, workers, WebGL, location, service worker
and storage, and has a "clear cache and reload" that drops a stale service
worker without touching saved rounds.
