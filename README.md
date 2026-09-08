# JetLeg — Hide+Seek, San Francisco

A mobile web app for playing **Jet Lag: The Game — Hide+Seek** in San Francisco.
Seekers log each question and answer and watch the possible hiding zones
eliminate; hiders use it to answer truthfully and fast inside the five-minute
limit.

No accounts, no server, no sync. Each player's state is local to their own
phone, so a hider and a seeker running the app never see each other's data.

```
pipeline/   build-time data: fetches OSM + DataSF, emits static GeoJSON
app/        the PWA itself (Vite + React + MapLibre + turf)
```

## Running it

```bash
cd app
npm install
npm run dev          # http://localhost:5173
npm run build        # static output in app/dist
npm test             # 23 engine tests, ~2 min (the property test is thorough)
```

## Opening it on your phone

**Geolocation only works on a secure origin.** `http://192.168.x.x` will load
the app and then never produce a GPS fix, which disables the thermometer, radar
and measuring questions — most of the game. So plain HTTP over the LAN is not
an option. Three that do work:

### 1. Same wifi, self-signed HTTPS — quickest

```bash
cd app
npm run phone
```

Prints a `https://192.168.x.x:5173/` address. Open it on the phone and accept
the certificate warning (Safari: *Show Details → visit this website*). Once
accepted the page is a secure context and location works.

Good for testing on the couch. Note that iOS Safari can refuse to register a
service worker behind a self-signed certificate, so **offline caching may not
kick in** on this route — use option 3 for game day.

### 2. Cloudflare quick tunnel — real certificate, works on cellular

```bash
cd app
npm run tunnel
```

Builds, serves `dist/`, opens a tunnel and prints a public
`https://….trycloudflare.com` URL. Real certificate, so no warning and no
per-device trust. The URL is unguessable and dies with the process.

Requires `cloudflared` on PATH. *Not verified end-to-end from this machine* —
`cloudflared` registered its connection fine but Cloudflare's edge returned 404
without ever reaching the origin, which is a network-side problem rather than a
script one. It may work on your connection; if it 404s, use option 1 or 3.

### 3. Deploy it — the right answer for game day

```bash
cd app && npm run deploy
```

Real certificate, service worker registers properly, offline caching works, and
it keeps running when your laptop is shut and in a bag. See
**[QUICKSTART.md](QUICKSTART.md)** for the full walkthrough, including a
drag-and-drop option and a pre-game checklist.

Whichever route: once it loads, use **Share → Add to Home Screen**. That earns
persistent storage (so an all-day round survives iOS reclaiming memory) and
stops Safari discarding the tab.

The layer data is committed, so the app builds without network access. To
regenerate it:

```bash
cd pipeline
npm install
npm run all          # ~5 min; Overpass rate-limits, the script retries
```

## Deploying

The build output is static. **Cloudflare Pages** is the recommendation —
free tier is ample, and the app is ~1.7 MB JS plus ~3.5 MB of layer data.

**HTTPS is required, not optional**: browsers block geolocation on insecure
origins, and the thermometer, radar and measuring questions all anchor on the
player's position. `localhost` is exempt for development.

## How it works

### The elimination engine

The game is modelled as a **discrete candidate set** — the 276 hiding zones —
rather than as accumulating shaded polygons. Every answered question becomes a
region, and each zone is tested against it:

```
question + answer ──> "yes region"  ──> zone survives YES if it intersects
                                    ──> zone survives NO  if it is not contained
```

The shaded overlay on the map is a *rendering* of that result, not the source of
truth. Two things fall out for free: an exact remaining-zone count, and correct
handling of the fact that the hider roams inside a 500 m circle.

The ask log is append-only and the candidate set is recomputed from it on every
change, so undo, disable and delete can never leave the map out of sync. Answers
are constraints, not steps — reordering the log provably cannot change the
result, and there is a test for that.

### Conservative vs strict

The rulebook is explicit that answers describe the hider's *current location*,
not their hiding zone. A hider at the north edge of their circle can truthfully
answer differently from one at the south edge.

- **Conservative** (default) eliminates a zone only when its entire 500 m circle
  contradicts the answer. It can never eliminate the true zone.
- **Strict** tests the station centre alone. Narrows faster, and is wrong
  whenever the hider is near their circle's edge.

A consequence worth knowing: standing 320 m from a library, a "further" answer
eliminates nothing conservatively, because no 500 m circle fits inside a 320 m
disk. That is correct, not a bug — and the question-quality indicator warns you
before you spend the turn.

### Geometry

All maths runs in **UTM zone 10N**, never lon/lat. At SF's latitude a degree of
longitude is 0.79 of a degree of latitude, so a perpendicular bisector drawn in
degree space is off by ~14° — hundreds of metres across the city, enough to
eliminate the correct zone.

| Category | Yes region |
|---|---|
| Radar | disk of radius D at the seeker |
| Thermometer | half-plane past the perpendicular bisector of the travel |
| Matching | Voronoi cell of the seeker's nearest POI |
| Measuring | union of disks of radius r (= seeker's distance to nearest) around every POI |
| Tentacle | the named POI's Voronoi cell ∩ the reach disk |

## The game board

Derived from OpenStreetMap and DataSF, not hand-drawn.

- **Boundary**: SF mainland only, 119.87 km². Built by unioning the 11 trimmed
  supervisor districts and keeping the largest ring — which drops Treasure
  Island / Yerba Buena (2.33 km²) automatically.
- **276 stations**, each with a 500 m hiding zone: all rail, metro, cable car
  and ferry stops, plus bus stops served by 5+ distinct routes. Tune with
  `BUS_MIN_ROUTES=4 npm run stations` — the threshold is what sets board density.

Every point layer also ships a precomputed **Voronoi diagram**, clipped to the
board. A matching question is literally a question about which cell you are
standing in, so the cells can be switched on beside the points. They are built
at pipeline time in UTM 10N — a Voronoi diagram is a metric construct, and cells
computed in degree space would be visibly wrong at SF's latitude.

| Layer | Count | Layer | Count |
|---|---|---|---|
| Parks | 278 | Movie theaters | 16 |
| Museums | 50 | Hospitals | 16 |
| Libraries | 48 | Golf courses | 8 |
| Mountains | 41 | Aquariums | 2 |
| Water bodies | 31 | Zoos | 1 |
| Consulates | 24 | Amusement parks | 0 |
| Rail stations | 220 | Transit lines | 25 |
| Supervisor districts | 11 | Coastline | shoreline |

### Categorization overrides

OSM tags a goat-petting pen as a zoo and a trampoline park as an amusement park.
The rulebook resolves this with the "5+ Google Reviews" test or by agreement,
neither of which works offline mid-game — so `pipeline/overrides.json` records
those rulings up front. **Review it before game day** and agree on it with the
other players.

### Questions that are dead in San Francisco

The app greys these out with the reason rather than letting you waste a turn:

- **Null** — Commercial Airport (SFO/OAK/SJC are outside city limits),
  High-Speed Train Line, International Border, 1st Admin Division Border,
  4th Administrative Division, Amusement Park.
- **Always yes** — 1st/2nd/3rd Administrative Division (everyone is in
  California, in SF County, in SF City), Zoo (only the SF Zoo), Landmass
  (one landmass once the islands are excluded).

Strongest questions here: **libraries** (48, evenly sited), **parks** (278, very
fine-grained), **consulates** (razor-sharp downtown, useless in the Sunset), and
**coastline** (SF is a peninsula on three sides).

### House rule: supervisor districts

SF has no formal 4th administrative division, which kills that question. Turning
on the house rule in Layers uses the 11 supervisor districts instead — compact,
evenly distributed, and comparable to libraries in cutting power. Off by
default, since it deviates from the printed rules and both sides must agree.

## Not built

- **Sea Level** — needs a terrain grid (USGS 3DEP). The question is in the
  catalog and correctly reports as unavailable.
- **Street or Path** — needs the full named-street network; reports as null.
- **Hider deck** — time bonuses, powerups and curses stay on physical cards.
- **Offline basemap** — tiles come from OpenFreeMap and are runtime-cached by
  the service worker, so panned-over areas keep working offline. A bundled
  Protomaps `.pmtiles` extract would make it fully offline from a cold start.
