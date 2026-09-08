---
name: jetleg
description: Build, verify, regenerate map data for, or deploy the JetLeg SF Hide+Seek app. Use whenever changing anything in app/ or pipeline/, or when the user reports the app misbehaving on a phone (blank map, frozen UI, denied location, stale deploy). Encodes the verification ladder that catches this project's failure modes, which are all silent.
---

# JetLeg SF — build, verify, ship

A local-first PWA for playing Jet Lag: Hide+Seek in San Francisco. `pipeline/`
generates static map data at build time; `app/` is the React + MapLibre PWA.
No server, no accounts — each player's state is local to their phone.

- **Deep architecture, engine internals, file-by-file:** `references/architecture.md`
- **Planned work — backend, accounts, payments, native app:** `ROADMAP.md` at the repo root

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
  agree or the map lies about the count.
- **The rulebook PDF is image-only.** `pdftotext` yields 38 bytes. Render pages
  with `LD_LIBRARY_PATH=/home/jonnym/lib pdftoppm -png -r 110` and read them.
- **`pkill -f <pattern>` kills the calling shell** when the pattern matches its
  own command line. Kill by PID, or start servers with `setsid nohup … & disown`.

## Running it on a phone

Geolocation is blocked on insecure origins, so plain LAN HTTP is useless — the
app loads and never gets a fix.

- `npm run phone` — dev server over self-signed HTTPS on the LAN. Fine for the
  couch, but iOS Safari may refuse service workers behind an untrusted cert.
- `npm run deploy` — real certificate. The right answer for game day.

The `?` tab self-checks secure origin, workers, WebGL, location, service worker
and storage, and has a "clear cache and reload" that drops a stale service
worker without touching saved rounds.
