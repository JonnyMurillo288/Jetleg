# Next steps — `backend/game-history`

Where this branch stands as of 10 Oct 2026, how to try what is in it, and
what has to happen before any of it is in front of real players. Everything
below was built and tested against the **local** Supabase stack only.

## What this branch adds

| | What | Where to find it in the app |
|---|---|---|
| Game rooms | Create a game, share its six-character code, join a team | **Game** button, GPS row |
| Live seeker locations | Seekers' positions on everyone's map in the game; the hider sends nothing; nothing is stored | The map, once in a game |
| Map studio | Its own page, apart from the game: browse, look at, make and edit maps | **Map** tab → **Map studio**, or `/#/maps` |
| Station maps | A different set of hiding stations on the San Francisco board | Studio → **New stations for San Francisco** |
| Full city maps | A whole board for any city: boundary, stations, places, Voronoi cells — built with the pipeline's tools, in the browser | Studio → **New city** |
| Publishing | Publish, version history, branch from any version, play on anyone's | Studio |
| Likes and discussion | Like / dislike, comments with replies | Any map's page in the studio |
| Email sign-in | A six-digit code, no password; only needed to publish, like or comment | Asked for where it is needed |
| Developer access | Listed emails play free on any device | Paywall → **Developer or tester?** |

How each one works, and why it is built the way it is:
`.claude/skills/jetleg/references/architecture.md`.

## Try it now (about five minutes)

```bash
npx supabase start                 # from the repo root; needs Docker and a few GB free
npx supabase migration up          # applies 0005–0007 without wiping local data

cd app
npm run seed:community                              # dummy players, maps, likes, comments
npx tsx grant-developer.ts you@example.com            # your own email: free play once signed in
npm run build && npx vite preview --port 4310
```

Open http://127.0.0.1:4310 and:

1. **Play for free.** Tap *Start a new round* → the paywall → *Developer or
   tester?* → enter your email → read the code at http://127.0.0.1:54324 (the
   local mail catcher; nothing is really sent) → the paywall closes.
2. **Open the studio.** *Map* → *Map studio* (or go to `/#/maps`). On a
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
   `dummy-maya@jetleg.test` (code from the mail catcher again), like and
   comment on your map, *Branch it*.
6. **Share locations.** In the two windows, tap *Game* in the game itself;
   create in one, join with the code in the other, set one to *Hider*. The
   seeker's teal dot appears on the hider's map.

`npx tsx seed-community.ts --reset` removes the dummy content again.
More detail, and the automated checks: `BACKEND_TESTING.md` §3b and §3c.

After switching git branches while the local stack is running, restart the
functions container (`docker restart supabase_edge_runtime_JetLeg`): `main`
has no `supabase/` folder, so the container's view of it goes stale and
every edge function fails with "failed to determine entrypoint".

## Before this reaches real players

In order. Each is a decision or a piece of setup, not just code.

1. **Bring the branch up to date with `main`.** It is two commits behind
   (admin-4 house rule, custom radar distance) plus the import-and-resume
   change. Expect conflicts in `app/src/store/game.ts` and
   `app/src/ui/RoundGate.tsx`.
2. **Create the cloud Supabase project** and `npx supabase db push`
   (migrations 0001–0009). In its dashboard, under Authentication:
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
6. **Moderation, before the community is public.** There is no way to report
   a map or comment, no admin delete, and no limit on how fast someone can
   post. Anyone with a verified email can publish under any display name.
7. **OpenStreetMap, before many people use the studio.** It calls two free
   public services straight from the browser: Nominatim (place search) and
   Overpass (stations and places). Both have usage policies and rate limits
   meant for light use, and Overpass answers 429 when busy. For real traffic,
   put a small caching proxy in front of them or run your own. Separately,
   OpenStreetMap data is ODbL-licensed: a published city map built from it
   needs to say so. The basemap already credits OSM; the map pages do not.
8. **A privacy note.** The app now collects email addresses and relays live
   locations. It needs a short statement of what is kept (emails, published
   maps, comments) and what is not (positions), and a way to delete an account.

## Known gaps

- **Four older test suites are not running.** `verify`, `verify:tools`,
  `verify:results` and `verify:units` stop at the paywall in a fresh browser.
  They need to sign in as a developer first, the way `verify-developer.ts`
  does. Until then the measuring tools, the plan layer and the unit sweep
  have no automated check on this branch.
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
