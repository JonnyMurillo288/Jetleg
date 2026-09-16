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

### Matching against something other than a nearest POI

`matchingRegion` assumes "same as mine" means the same single nearest point —
one Voronoi cell. Two question types don't fit that:

- **The 4th administrative division** (`districtRegion`, `districtFeatureAt`).
  Districts already partition the whole board, so this is point-in-polygon
  containment, not nearest-feature — the yes-region is just the seeker's own
  district polygon. `layers.admin4` is a `PoiLayer` with `kind: 'polygon'`,
  built in `data/load.ts` from `districts-supervisor.geojson`, clipped to the
  play boundary in the same pass so the map's "Supervisor districts" toggle
  and the matching question always agree — they read the same polygons.
- **Station Name's Length** (`groupedMatchingRegion`). "Same as mine" here
  means "any station whose derived property matches," a many-to-one grouping
  — the region is the union of every matching station's own cell, not one
  cell. `layers.stationNames` is a synthetic `PoiLayer` over the full 192-
  station set (not `rail-stations.geojson`'s 56, which excludes bus-only
  stops), also built in `data/load.ts`. It carries no precomputed diagram, so
  this always takes `matchingRegion`'s carve-fallback path.

Both need their own branch in `candidates.ts`'s `computeAsk` and
`previewSplit` *before* the generic matching/`layerIndex` path runs —
`layerIndex` assumes point/line geometry and silently produces nonsense
against a polygon layer.

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

Hosting: Cloudflare Pages, `jetleg-sf.pages.dev`. `public/_headers` makes
`sw.js` and `index.html` always revalidate so a new deploy reaches an installed
PWA, while hashed assets are immutable.
