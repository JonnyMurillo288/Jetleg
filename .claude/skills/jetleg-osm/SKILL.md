---
name: jetleg-osm
description: How JetLeg's map studio fills a new city from OpenStreetMap — Nominatim for the boundary, one combined Overpass request for stations, places, coastline and transit lines, the mirror failover, the per-session cache, and the parsers that apply the rulebook. Use when changing app/src/community/osm.ts, the studio's Boundary/Stations/Places fetch buttons, or anything that calls Overpass or Nominatim from the app; when a user says building a city map is slow, hangs, comes back empty or partial; or when adding a new category that has to be fetched. Measured timings and the traps that made the old fetch take 30+ minutes are in here.
---

# Filling a city from OpenStreetMap

The map studio (`#/maps`, "New city") builds a playable board for any place
on earth. Everything it knows about that place comes from two free, shared
public services. This skill is how that works, what it costs, and what
breaks it. The general JetLeg rules (verification ladder, deploys) are in the
`jetleg` skill; read that too for anything beyond the fetch.

| File | Role |
|---|---|
| `app/src/community/osm.ts` | All network calls and all parsing. The only file that knows Overpass exists. |
| `app/src/community/pack.ts` | `largestLandmass`, `simplifyBoundary`, `boundaryFeature`, `auditPack` — what happens to the data after. |
| `app/src/studio/Editor.tsx` | The buttons: `BoundaryTab.use` (prefetch), `StationsTab`, `LayersTab` (`fetchOne`, `apply`, `commit`), `runTool` (status line). |
| `app/src/community/osm.test.ts` | Mirror failover, hedging, remarks, one-request sharing — against a stubbed `fetch`. |
| `app/src/community/pack.test.ts` | The parsers: rulebook exclusions, stop folding, line clipping, the section split. |
| `app/verify-community-ui.cjs` | The studio in two browsers, OSM mocked by the `answer()` fixture. |
| `app/scripts/time-osm.ts` | `npm run time:osm -- "<city>"` — the real thing, live, timed per request. |

## The flow, end to end

```
Boundary tab: search ──► Nominatim ──► Place[] ──► "Use"
                                                    │ largestLandmass(geometry)
                                                    │ patch({ boundary })
                                                    └─► prefetchBoard(boundary) ──► fetchBoard ──► overpass(boardQuery(bbox))
                                                                                         │              (one request)
Stations tab ─ fetchStations(boundary, withBuses) ──┐                                     ▼
Places tab ─── fetchAllPois / fetchPois(key) ───────┼──► fetchBoard (cache hit) ──► splitBoard ──► parse* ──► layers
             └ fetchTransitLines / fetchCoastline ──┘
```

1. **Boundary.** `searchPlaces(query)` asks Nominatim for
   `polygon_geojson=1&addressdetails=1&limit=6`, keeps only results whose
   geometry is a Polygon/MultiPolygon, and carries the country code. "Use"
   runs `largestLandmass` (drops islands and exclaves — SF's Farallones) and,
   since this change, **starts the Overpass fetch immediately** with
   `prefetchBoard`. By the time a person has looked at the outline and
   clicked over to Stations, the data is usually there.
2. **One request for the board.** `boardQuery(bbox)` is a single Overpass
   query that returns all four things the studio fetches, separated by
   `make section` markers (see below). `fetchBoard` sends it, `splitBoard`
   cuts the answer into `{ pois, stations, coastline, lines }`.
3. **Every tool reads the same answer.** The stations buttons, "Fetch every
   category", each category's own button, transit lines and coastline all
   call `fetchBoard(boundary)`; only the first one costs a request.
4. **Parsers apply the rulebook**, cut to the boundary polygon itself (the
   query only knows the bounding box), and return features plus a `Dropped`
   count that the studio prints so the author can see what was filtered.
5. **The editor commits.** `LayersTab` collects into `fetched` and writes all
   layers in **one** `patch` — two `patch` calls in one handler undo each
   other (see the `jetleg` skill). The author then reviews each list; the
   published file is the ruling, not OSM.

## The query

```
[out:json][timeout:180];
(nwr["leisure"="park"](bbox); …all twelve POI_DEFS selectors…);out center tags;
make section name="stations";out;
(node["railway"~"^(station|halt|tram_stop)$"](bbox); node["public_transport"="station"](bbox);
 node["amenity"="ferry_terminal"](bbox); node["highway"="bus_stop"](bbox););out;
make section name="coastline";out;
way["natural"="coastline"](bbox);out geom;
make section name="lines";out;
relation["type"="route"]["route"~"^(subway|light_rail|tram|train|ferry)$"](bbox);out geom(bbox);
```

Why each part is the way it is:

- **One request, not four (or twelve).** The time is the *queue*, not the
  query. On 2026-10-31 every studio request took 30–40 s regardless of size
  — a 0.37 MB answer and a 15 MB answer took about the same. Four requests
  were four turns in the queue and four chances at a 429. The pipeline's
  one-per-category approach (`pipeline/04-pois.ts`) works only because it
  runs from a laptop with a disk cache and all night to retry.
- **`make section name="…";out;`** emits a synthetic element
  `{ type: 'section', tags: { name } }` between output sets. That is how one
  JSON `elements` array is split back into parts. `splitBoard` throws on an
  unknown section name rather than misfiling elements.
- **`out center tags`** for places: every place is a POINT, because the
  rulebook measures to the map icon. Ways and relations get Overpass's
  computed `center`.
- **Bus stops are always fetched**, and the "rail, metro, tram and ferry"
  button filters them out client-side with `isStation(tags)`. One request
  serves both buttons. The filter must match `STATION_SELECTORS` exactly.
- **`out geom(bbox)` on transit lines clips them to the box.** A route
  relation is the *whole* route; a national rail line through a city
  brought 15 MB of track from elsewhere into every San Francisco fetch, and
  all of it went into the published layer. Clipped: 2 MB over the wire,
  0.28 MB as a layer, same 51 lines. Clipped geometry has **`null` for every
  point outside the box** — `parseTransitLines` splits each way into runs at
  the nulls. Code that maps `geometry` without that check crashes on it.
- **The bbox is padded by `PAD` (0.01°, about 1 km).** A boundary nudged,
  simplified or re-drawn inside the original still fits inside what was
  fetched, so it is a cache hit. Points in the pad are dropped by the
  parsers' point-in-polygon test anyway.
- **No `qt` and no server-side `["name"]` filter**, deliberately. `qt`
  changes element order, and order decides which duplicate wins and which
  station gets the `-2` id suffix. A name filter would lose places that only
  carry `name:en`, and the studio's "dropped N unnamed" report.

## Talking to Overpass: `overpass(query, signal, onWait)`

Public mirrors, in order (`OVERPASS`):

| Mirror | Browser CORS | Behaviour seen under load |
|---|---|---|
| `overpass-api.de` | `*` | Answers **502 "at capacity" in under a second**, or a real answer in 30–100 s. |
| `maps.mail.ru/osm/tools/overpass` | `*` | Fast 504s, or a real answer in 15–25 s. Often the one that wins. |
| `overpass.kumi.systems` | — | **Hangs**: accepted connections, no reply for 90–125 s, then 502. |
| `overpass.private.coffee` | — | Hung past 240 s every time. Not used. |

The old loop alternated de/kumi with no fetch timeout and waited 5, 12, 25,
40 s between attempts — per tool. A hanging kumi held each attempt for
minutes; four tools did it four times. That is where 30+ minutes came from.

Now, per request:

- **Fast failure → next mirror at once.** A 502/504 in half a second
  starts the next mirror immediately, no wait.
- **Hedging.** A mirror silent for `HEDGE_S` (45 s) gets the next mirror
  asked *alongside* it; the first answer wins and the rest are aborted.
  45 s is chosen to sit above a normal busy-day answer (~40 s), so a healthy
  request does not double the load on a shared service.
- **Per-attempt cap `ATTEMPT_S`** (200 s, just over the query's own
  `[timeout:180]`) and an overall **`GIVE_UP_S`** (6 min), after which the
  studio shows an error instead of "Fetching…" forever.
- **Rounds.** When every mirror has failed, wait 5, 15, 30 s and go round
  again, inside the deadline. `onWait` reports each wait to the status line.
- **`remark: "runtime error: …"` is a failure.** Overpass that runs out of
  time or memory still answers **200 OK with partial `elements`** and a
  `remark`. Accepting that is a silently incomplete board. It is treated as
  a failed mirror; if that is the last word, the error says the area is too
  large for one request.
- **400 stops everything.** A query Overpass cannot parse fails the same
  way on every mirror; retrying it is just load.

## The cache: `fetchBoard(boundary, onWait)`

- Module-level, per page session; up to 3 fetches kept, newest last.
- **Containment, not equality:** any cached fetch whose padded bbox contains
  the boundary's bbox answers for it.
- The in-flight promise is shared, so a click during the prefetch waits for
  the same request. `onWait` callbacks are fanned out to every waiter, so
  the status line still says "OpenStreetMap is busy, retrying in Ns".
- **A failed fetch is removed**, so the next click asks again. A success is
  kept until the page reloads; there is no persistent cache (a big city's
  answer is several MB, past what `localStorage` should hold).

## Parsers — the rulebook's tests

These are the pipeline's steps 02/04/05 as pure functions. Keep them pure:
`pack.test.ts` and the pipeline-parity tests depend on it.

- `parsePois(key, elements, boundary)` — takes only elements carrying this
  category's tag (the combined answer holds every category), applies
  `POI_DEFS[key].reject` (honorary consulates, mini-golf and driving
  ranges, pools), requires `name` or `name:en`, requires the point inside
  the boundary, and dedups `name|lon.toFixed(3)|lat.toFixed(3)` (OSM often
  has both a node and its enclosing way). Ids are `${key}-${osmId}`.
- `parseStations(elements, boundary)` — named, inside; same-named stops
  within 150 m (measured in the board's own UTM zone via `projectionAt`) fold
  into one at their mean position with every mode any of them had.
  `modesOf` infers modes from tags; it knows nothing of city quirks (SF's
  cable cars are tagged as trams) and recovers no route lists.
- `parseTransitLines(elements, boundary)` — one feature per `ref ?? name`
  (one per line, not per direction), kept only if at least two of its
  points are inside the boundary; null gaps split parts.
- `parseCoastline(elements)` — every coastline way with 2+ points; the
  boundary's own edge (`coastlineFromBoundary`) is the alternative for an
  island or peninsula.
- `spaceOut(stations, MAX_STATIONS)` — **the 600-station cap.** A map may
  hold at most `MAX_STATIONS` (600, `format.ts`); San Francisco with bus
  stops is 2,436, Los Angeles 4,820. The Stations tab's `replace` no longer
  refuses: it keeps 600 by farthest-point sampling in the board's UTM plane
  — repeatedly keep whichever station is farthest from everything kept —
  so coverage stays even instead of the list's first 600 clumping in one
  corner. Every station that is not bus-only is kept first (all 257 of
  San Francisco's); bus stops fill the gaps between. Kept stations stay in
  their original order. Cost is O(n × 600) with the gap update and the
  next pick fused into one pass: 18 ms for SF, 25 ms for 4,820 stops, 136 ms
  for 30,000. The note says how many there were and that they were spaced
  out. If a city has more than 600 *rail* stops, the same sampling spreads
  those. A map file imported with more than 600 is still refused by
  `parseMapFile` — an author's own list is theirs to cut.

**Adding a category:** add it to `POI_DEFS` (tag + optional `reject`) and to
`LAYER_DEFS` in `app/src/data/layers.ts`. It joins the union automatically. Then
check `pack.test.ts` and the harness's `audit` assertions, which count
categories ("Fetched 12 categories").

## Measured (2026-10-31, public Overpass under heavy load)

| | Before | After |
|---|---|---|
| San Francisco, four tools, no retries needed | ~140 s, 4 requests, 18.4 MB | **21–27 s**, 1 request, 7.5 MB |
| San Francisco, in a real browser, Use → stations → all places | — | **35–41 s** to stations (prefetch), **+0.8 s** for all 12 categories |
| Los Angeles (1,362 km²), one mirror hanging | old loop: minutes per attempt, ×4 tools | **236 s**, of which 125 s was kumi hanging before a 502 |
| Parsing in the browser, any of the above | — | under 0.5 s — never the bottleneck |

The floor is the public queue. A trivial one-node query took 17 s on
mail.ru that day. No client-side change gets under that.

## Making it faster still (not built)

In order of payoff per effort:

1. **A shared cache behind our own backend.** A Supabase edge function that
   takes the board query, keys it on the rounded padded bbox, stores the
   answer in Storage, and serves repeats instantly. The first person to
   build a city pays the Overpass wait; everyone after (and every re-open of
   a draft) gets it in about a second. The edge function also gets a proper
   User-Agent and one place to change mirrors.
2. **Prebuilt boards for popular cities.** Run the pipeline overnight for
   the cities people search for, publish them as maps. No wait at all.
3. **A private Overpass instance** for a region (a few hundred GB of disk for
   North America, a small VPS). Queries drop to a few seconds and nobody
   else's load matters. Only worth it once usage justifies a server.

## Verifying a change here

1. `npx vitest run src/community/osm.test.ts src/community/pack.test.ts`
2. `npm run verify:community:ui` (needs `supabase start` and a preview on
   :4310). OSM is mocked by `answer()`; if you change the query's shape,
   change the fixture to answer the same way Overpass would — sections and
   all — and keep its assertions about how many requests were made.
3. **Mocks do not prove the public API.** After changing the query or the
   mirror list, run `npm run time:osm -- "San Francisco"` and once more for
   a large city, and drive the studio once in a real browser: CORS, User-
   Agent and response shape only fail live. Counts for San Francisco to
   expect: 255 rail/metro/tram/ferry stops, 2436 with buses, 51 transit
   lines, parks 292, libraries 48, water 32. With bus stops, SF is
   spaced out to 600 (257 of 257 not bus-only kept); `time:osm` prints that line
   whenever a city is over the cap.
4. When asking the studio's map what it drew, wait a frame after the source
   updates: `queryRenderedFeatures` read in the same tick returns 0.

## Traps

- **Overpass refuses Node's default User-Agent (406).** Browsers are fine;
  Node scripts must set one (`time-osm.ts` does).
- **Nominatim refuses Node's default User-Agent (403)** and asks for at most
  one request a second. Never search on every keystroke.
- **200 is not success** on Overpass: check `remark`.
- **Clipped geometry contains nulls.**
- **The bounding box is not the boundary.** Everything the query returns
  must still pass point-in-polygon; an L-shaped city's bbox is mostly
  someone else.
- **Order is meaning.** Dedup keeps the first; station ids are assigned in
  order. Don't reorder the query output.
- **Don't fan out.** A browser firing a dozen Overpass requests gets 429s by
  the fifth. If a new feature needs more data, add it to `boardQuery` as
  another section.
