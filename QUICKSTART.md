# Quickstart — getting JetLeg online

Goal: a public HTTPS URL you and the other players open on your phones.

**HTTPS is not optional.** Browsers block geolocation on insecure origins, and
without a GPS fix the thermometer, radar and measuring questions stop working —
most of the game. Every option below gives you a real certificate.

---

## The short version

```bash
cd app
npm install
npm run deploy
```

First run opens a browser to log into Cloudflare (free account), then prints
your URL. Every later `npm run deploy` pushes an update to the same URL.

---

## Option A — Cloudflare Pages via CLI (recommended)

No git repo needed, ~2 minutes.

```bash
cd app
npm install
npx wrangler login          # opens a browser; authorise, then come back
npm run deploy
```

You get:

```
✨ Deployment complete! https://jetleg-sf.pages.dev
```

That URL is live, world-readable and permanent. Send it to the other players —
each person's game state is stored on their own phone, so everyone just opens
the same link.

To use a different project name, edit the `deploy` script in
`app/package.json`, or run it directly:

```bash
npm run build
npx wrangler pages deploy dist --project-name whatever-you-like
```

## Option B — drag and drop

No CLI at all.

```bash
cd app
npm run build
```

Then drag the `app/dist` folder onto:

- **Netlify**: <https://app.netlify.com/drop>
- **Cloudflare Pages**: dashboard → Workers & Pages → Create → Pages → *Upload assets*

Both hand back an HTTPS URL. Fine for a one-off, but you re-drag the folder for
every update, so Option A is better if you expect to tweak anything.

## Option C — connect a git repo (auto-deploy on push)

Best if you're going to keep changing it.

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → *Connect to Git*.
3. Set:
   - **Root directory**: `app`
   - **Build command**: `npm run build`
   - **Output directory**: `dist`

Every push to your default branch deploys automatically.

---

## Right after it's live

1. **Open the URL on your phone.**
2. **Share → Add to Home Screen.** This is worth doing properly:
   - it earns persistent storage, so an all-day round survives iOS reclaiming
     memory in the background;
   - it stops Safari discarding the tab;
   - the service worker caches the app and all layer data, so it keeps working
     underground.
3. **Pan around the SF map once while on wifi.** Basemap tiles are cached as
   they're seen, so a quick pan over the city means the map still draws in a
   BART tunnel.
4. **Grant location** when asked. Explain to your players that denying it still
   leaves the app usable — every flow accepts a hand-dropped pin — but the
   automatic thermometer and radar anchoring goes away.

Each player opens the same URL and picks Seeker or Hider in the app. There is
no server and no sync: a hider's state is never visible to a seeker, and vice
versa.

---

## Updating a live deployment

```bash
cd app
npm run deploy
```

`deploy` now verifies the live site afterwards and fails loudly if the upload
was incomplete. You can run that check on its own at any time:

```bash
npm run verify:live https://jetleg-sf.pages.dev
```

This matters more than it sounds. **Cloudflare Pages answers a request for a
missing file with `200 OK` and the contents of `index.html`.** So a half-deployed
site passes every ordinary check — every status is 200, every body is non-empty,
the console is clean — while a JavaScript worker that silently received HTML
instead of code just dies, and the map renders blank. `verify:live` checks
content *types*, not status codes, which is the only way to see it.

Phones already running the app pick it up on next launch — `sw.js` and
`index.html` are served with `must-revalidate` (see `app/public/_headers`),
which is what makes updates actually reach an installed PWA instead of being
masked by a stale service worker.

If you regenerate the map data, rebuild before deploying:

```bash
cd pipeline && npm run all
cd ../app && npm run deploy
```

---

## Before game day

- [ ] Open the deployed URL on **every** player's phone and add to home screen.
- [ ] Confirm each phone gets a GPS fix — the top bar shows `GPS ±N m`.
- [ ] Agree the **game size** (Layers tab). Medium is the default and the right
      call for SF; it decides which of the 80 questions are in play.
- [ ] Agree on `pipeline/overrides.json`. OSM tags a goat pen as a zoo and a
      trampoline park as an amusement park; that file records the rulings, and
      it's exactly the kind of thing that starts an argument mid-round.
- [ ] Decide the **supervisor-district house rule** (Layers tab). Off by
      default. It revives the otherwise-dead 4th Administrative Division
      question — good, but it's a deviation from the printed rules.
- [ ] Decide **conservative vs strict** elimination (Layers tab). Conservative
      is the default and can never rule out the true zone.

---

## If something's wrong

**Tap the `?` tab in the app first.** It runs a self-check — secure origin, web
workers, WebGL, location permission, service worker, persistent storage — and
names what is actually failing instead of leaving you to guess.

### Blank map

Check the `?` tab. If **Web workers** is red, that is the cause — MapLibre parses
every layer in a worker, including the hiding zones, so a blocked worker renders
the map completely blank while every network request still returns 200.

Two things cause it, and they look identical from the phone:

1. **A broken build.** `npm run build` now runs `scripts/check-build.mjs`, which
   fails if the worker chunk is missing or has unresolved imports. If the build
   passes, it is not this.
2. **An untrusted certificate.** iOS Safari keeps blocking workers on a
   self-signed address even after you tap through the warning. Use the deployed
   `https://….pages.dev` URL rather than `192.168.x.x`.

Either way the game still works — questions, answers and zone elimination do not
depend on the map.

### Location denied, but the map works fine

Then it is an ordinary permission setting, not a certificate problem. On iPhone:

1. Settings → Privacy & Security → Location Services → on.
2. Same screen → Safari Websites → **While Using the App**.
3. In Safari, tap **aA** (or ⓘ) in the address bar → Website Settings →
   Location → **Allow**, then reload.

If the app is on your home screen, delete and re-add it after changing this —
an installed PWA caches the old permission decision.

You can keep playing regardless: every flow that uses your position also accepts
a hand-dropped pin.

**Map blank but the zone counter works.** Just the basemap failed. The app falls
back to a plain background and still draws the zones, so keep playing.

**Nothing renders and `?` says WebGL failed.** The device or browser can't do
WebGL. Try Chrome, or play from the question list without the map.

**A round vanished.** iOS evicts browser storage under pressure if the app was
never added to the home screen. Use the export button on the round screen to
keep a JSON backup.

**Deploy fails with a project-name conflict.** Someone already has
`jetleg-sf.pages.dev`. Pick another name in the `deploy` script.

**`npx wrangler login` won't open a browser** (headless machine). Use
`npx wrangler login --browser false` and paste the printed URL somewhere with a
browser, or fall back to Option B.
