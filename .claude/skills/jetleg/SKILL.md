---
name: jetleg
description: Build, verify, regenerate map data for, or deploy the JetLeg SF Hide+Seek app. Use whenever changing anything in app/ or pipeline/, or when the user reports the app misbehaving on a phone (blank map, frozen UI, denied location, stale deploy). Encodes the verification ladder that catches this project's failure modes, which are all silent.
---

# JetLeg SF — build, verify, ship

A local-first PWA for playing Jet Lag: Hide+Seek in San Francisco. `pipeline/`
generates static map data at build time; `app/` is the React + MapLibre PWA.
No server, no accounts — each player's state is local to their phone.

## The one rule

**Every failure this project has produced was silent.** The build succeeded,
every HTTP status was 200, the console was clean, and the app was broken. Do not
conclude something works because a narrower check passed. Verify at the layer
that actually fails: for rendering, ask the map what it drew; for a deploy, check
content types; for responsiveness, measure with the CPU throttled.

Real examples, all shipped as "verified" before being caught by a user:

| Bug | What looked fine | What actually caught it |
|---|---|---|
| MapLibre worker emitted with `?url`, so its own import 404'd | build passed, worker file returned 200 | `map.isStyleLoaded()` was `false`, 0 rendered features |
| `allowedHosts: ['.trycloudflare.com']` 404'd the whole dev server | preview on `127.0.0.1` was fine | actually loading `npm run phone` |
| Deployed build was stale | every URL returned 200 | `content-type: text/html` on a `.js` path |
| Question list froze the UI for 74 s | tests passed, app "worked" | timing the category switch |
| Label glyphs 404'd against the basemap | labels partly rendered | watching the network for 404s |

## Verification ladder

Run top-down. Each rung catches what the one above cannot.

```bash
cd app
npm run build      # tsc + vite + check-build.mjs (unresolved imports in output)
npm test           # 23 engine tests, ~2 min
npm run verify     # e2e-verify.cjs — drives a real browser, asserts zone counts
```

Then, if anything touched the map, rendering, or layers — **ask MapLibre what it
drew**, because a blank map throws nothing:

```js
window.__map.isStyleLoaded()                                    // must be true
window.__map.queryRenderedFeatures({layers:['zones-alive']})    // must be > 0
window.__map.queryRenderedFeatures({layers:['stations-dot']})   // must be > 0
```

Healthy numbers at default zoom: `styleLoaded: true`, ~297 zones, 276 stations,
~1363 total features. Zero of anything means the worker is dead.

If anything touched the question list or a layer, **time it with the CPU
throttled 4×** (`Emulation.setCPUThrottlingRate`). Category switches must be
single-digit milliseconds. Anything over ~300 ms is a freeze on a real phone.

## Deploying

```bash
cd app && npm run deploy    # builds, uploads, then verifies the live site
npm run verify:live <url>   # check any deployment on its own
```

**Cloudflare Pages answers requests for missing files with `200 OK` and the
contents of `index.html`.** A half-uploaded site therefore passes every status
check while being completely broken. `scripts/check-deploy.mjs` checks content
*types* — that is the only way to see it. Never judge a deploy by status codes.

When a user reports a problem on a deployed URL, **fetch the live site and
compare its asset hashes to the local build before theorising.** A stale deploy
has been the answer more than once.

## Regenerating map data

```bash
cd pipeline && npm run all    # ~5 min; Overpass rate-limits, the script retries
```

Steps are ordered and each depends on the last: boundary → districts → stations
→ pois → linear → voronoi. Outputs land in `app/public/data/` and are committed,
so the app builds offline. `pipeline/.cache/` holds raw fetches — delete it to
force a refresh.

Assertions in each step are load-bearing. If station count leaves the 200–350
band or a POI layer comes back empty, that is a real signal, not noise to
silence.

## Things that will bite

- **All geometry runs in UTM 10N**, never lon/lat. A degree of longitude is 0.79
  of a degree of latitude here; bisectors and Voronoi cells computed in degree
  space are wrong by hundreds of metres.
- **Conservative elimination is the default and must stay correct.** A zone is
  ruled out only when its *entire* 500 m circle contradicts the answer, because
  the hider roams inside that circle. The property test replays every station's
  own truthful answers and asserts none eliminates itself — if that test fails,
  the geometry is wrong, not the test.
- **Symbol layers need `text-font: ['Noto Sans Regular']`.** MapLibre's default
  stack 404s against the basemap's glyph server and labels vanish silently.
- **Never gate map layer installation on `load`.** It never fires when basemap
  tiles are unreachable, which is exactly when the game layers matter most. Use
  `style.load`.
- **The rulebook PDF is image-only.** `pdftotext` yields 38 bytes. Render pages
  with `LD_LIBRARY_PATH=/home/jonnym/lib pdftoppm -png -r 110` and read the
  images.

## Running it on a phone

Geolocation is blocked on insecure origins, so plain LAN HTTP is useless —
the app loads and never gets a fix.

- `npm run phone` — dev server over self-signed HTTPS on the LAN. Fine for the
  couch, but iOS Safari may refuse service workers behind an untrusted cert.
- `npm run deploy` — real certificate. The right answer for game day.

The `?` tab in the app self-checks secure origin, workers, WebGL, location,
service worker and storage, and has a "clear cache and reload" that drops a
stale service worker without touching saved rounds.
