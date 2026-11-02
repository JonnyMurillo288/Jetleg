# Quickstart — a dev copy online

How to put this branch online so you can test it on real phones: the app on a
Cloudflare Pages **preview** (`https://dev.jetleg-sf.pages.dev`), talking to a
**separate dev Supabase project**. Production (`https://jetleg-sf.pages.dev`)
is not touched at any point.

```
phones ──https──▶ dev.jetleg-sf.pages.dev   (Cloudflare Pages, branch "dev")
                         │
                         └──▶ <ref>.supabase.co   (Supabase project "jetleg-dev")
```

Allow about 30 minutes the first time, most of it clicking through the
Supabase dashboard. After that, every update is one command (§6).

You need: Node 22, Docker isn't needed for this, a Cloudflare account (you're
already logged in to wrangler), and a Supabase account.

> **Do not run `npm run deploy` from this branch.** That script publishes to
> *production*, and it builds with `.env.local` — your laptop's local
> backend, which no phone can reach. Everything here uses `npm run deploy:dev`.

> **Already done, 31 Oct 2026**, for the Supabase project **JetLeg**
> (`dwdgysnclfetwmuteefy`): §1–§6, with `jonnymurillo288@gmail.com` on both
> tester lists, and all checks in §7 passing against
> <https://dev.jetleg-sf.pages.dev>. Still to do: Google sign-in (§9), and
> the email templates (§2), which need custom SMTP first. The rest of this
> page is how to repeat it, for another project or for production.

---

## 1. Create the dev Supabase project

1. <https://supabase.com/dashboard> → **New project**. Name it `jetleg-dev`,
   pick a region near you (e.g. West US), set a database password and keep it.
2. Wait for it to finish provisioning (a minute or two).
3. **Project Settings → API Keys → Legacy API keys.** Copy:
   - `anon` (starts `eyJ…`) — public, goes into the app build
   - `service_role` (starts `eyJ…`) — **secret**, only for the admin scripts below
   - the project URL, `https://<ref>.supabase.co` (Project Settings → Data API)

   Use the legacy `eyJ…` keys, not the newer `sb_publishable_…` / `sb_secret_…`
   ones. The app, the edge functions and the scripts were built and tested
   against the legacy keys.

   Nothing goes anywhere yet; keep them handy (a password manager is ideal).
   They end up in three places:

   | Value | Goes in | Used in |
   |---|---|---|
   | Project URL | `app/.env.dev.local` as `VITE_SUPABASE_URL`, and `export SUPABASE_URL=…` in the terminal | §4, §5, §7 |
   | `anon` key | `app/.env.dev.local` as `VITE_SUPABASE_ANON_KEY`, and `export SUPABASE_ANON_KEY=…` for the checks | §5, §7 |
   | `service_role` key | **only** `export SUPABASE_SERVICE_ROLE_KEY=…` in the terminal, for the admin scripts. Never in a file, never in the app | §4, §7 |

   The edge functions need none of these: Supabase gives every deployed
   function its own project's URL and keys automatically.

## 2. Configure sign-in (dashboard)

The app signs people in with a six-digit emailed code, and gives every device
an anonymous identity first. In **Authentication**:

| Where | Set |
|---|---|
| Sign In / Providers → *Allow anonymous sign-ins* | **On** |
| Sign In / Providers → Email → *Confirm email* | **On** — without it anyone can claim any address |
| Sign In / Providers → Email → *Email OTP length* | **6** — new projects default to 8, which the app's six-digit code box cannot take |
| Sign In / Providers → Email → *Email OTP expiration* | 3600 |
| URL Configuration → *Site URL* | `https://dev.jetleg-sf.pages.dev` |
| URL Configuration → *Redirect URLs* | add `https://dev.jetleg-sf.pages.dev` and `http://127.0.0.1:4310` |
| Authentication → *Allow manual linking* | **On** — Google sign-in links to the device's own identity (§9) |
| Emails → Templates → *Magic Link* | paste the body of `supabase/templates/magic_link.html` |
| Emails → Templates → *Confirm signup* | paste `supabase/templates/confirmation.html` |
| Emails → Templates → *Change Email Address* | paste `supabase/templates/email_change.html` |

The stock templates send only a link; these put the code first, which is what
the app asks for. **On the free plan, Supabase refuses template changes until
you connect your own SMTP.** Until then, an emailed sign-in arrives as a
link with no code the app can use. Testers on the list are unaffected: they
use the testing code (§4) or Google (§9).

Most of this table can also be applied from the command line with
`npx supabase config push`, but **not from the repo's own `config.toml`**: that
file describes the local stack, and pushing it would set the site address to
`127.0.0.1` and switch Google off. Push from a copy with the dev addresses
filled in, and read the diff it prints before answering `y`.

**Email delivery on a dev project:** Supabase's built-in sender only delivers
to members of your Supabase organisation, and only a few emails an hour. That
is fine here: testers sign in with the **testing code** (§4), which sends no
email at all. Connect real SMTP (Authentication → Emails → SMTP Settings) only
when people outside the list need to sign in.

## 3. Push the database and functions

From the repo root:

```bash
cd ~/Desktop/JetLeg
npx supabase login                              # once; opens a browser
npx supabase link --project-ref <ref>           # asks for the database password from §1
npx supabase db push                            # applies migrations 0001–0011

# The testing code: six digits of your choosing. Treat it as a shared password for listed testers.
npx supabase secrets set TEST_LOGIN_CODE=<six digits> APP_URL=https://dev.jetleg-sf.pages.dev

npx supabase functions deploy test-login
npx supabase functions deploy stripe-checkout
npx supabase functions deploy restore-entitlement
npx supabase functions deploy stripe-webhook --no-verify-jwt   # Stripe calls this with no Supabase token
```

`db push` lists the migrations it is about to apply and asks first; all eleven
should be there. Run `npx supabase migration list` afterwards: every row needs
a value in both the *Local* and *Remote* columns.

Stripe is optional for testing (§8). Without it, the buy buttons fail but
developer access works, and that is how testers play.

## 4. Let your testers in

Two lists, both per project. From `app/`, with the dev project's URL and
`service_role` key:

```bash
cd ~/Desktop/JetLeg/app
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...          # service_role — never put this in a file the app builds from

# For each tester:
npx tsx test-login.ts friend@example.com         # may sign in with the testing code, no email needed
npx tsx grant-developer.ts friend@example.com    # plays free: no paywall
```

`npx tsx test-login.ts --list` shows who is on it. Ten wrong codes lock an
address until `npx tsx test-login.ts <email> --unlock`.

Optional, for a studio with something in it:

```bash
SUPABASE_ANON_KEY=eyJ... npm run seed:community   # dummy authors, maps, likes, comments
```

That adds fake accounts (`dummy-*@jetleg.test`) to the dev project.
`npx tsx seed-community.ts --reset` removes them.

## 5. Point the build at the dev project

```bash
cd ~/Desktop/JetLeg/app
cp .env.dev.local.example .env.dev.local
```

Edit `.env.dev.local`:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...      # the anon key, not service_role
```

It is gitignored. Your `.env.local` stays pointed at the local Docker stack,
and `npm run build` keeps using it.

## 6. Deploy

```bash
cd ~/Desktop/JetLeg/app
npm install            # first time only
npm run deploy:dev
```

This runs, in order:

1. `build:dev`: type-check, build with `.env.dev.local`, then
   `check-backend`, which reads the built files and refuses to continue unless
   they contain your dev project's URL and not `127.0.0.1`. A build that
   silently fell back to the local backend would load fine on a phone and
   then fail at every sign-in.
2. `wrangler pages deploy … --branch dev` to the **`dev`** preview of the
   `jetleg-sf` project.
3. `check-deploy`, which fetches the live preview and checks content types and
   that its bundle is the one just built. Cloudflare answers a missing file
   with `200 OK` and the home page, so status codes prove nothing here.

Your dev copy is at **<https://dev.jetleg-sf.pages.dev>**. Run the same
command for every update.

To confirm production didn't move, check the hash before and after a dev deploy:

```bash
curl -s https://jetleg-sf.pages.dev/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

**After a dev deploy, `dist/` holds the dev build.** Run `npm run build` before
using `npx vite preview` against your local stack again.

## 7. Test it

### Automated checks against the dev copy

```bash
cd ~/Desktop/JetLeg/app
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_ANON_KEY=eyJ...
export SUPABASE_SERVICE_ROLE_KEY=eyJ...

TARGET=https://dev.jetleg-sf.pages.dev/ npm run verify:flow   # landing, Start a game, stats, map pages
npm run verify:room       # game rooms; a hider's location broadcast must be refused
npm run verify:sync       # finished-round history
npm run verify:payments   # pass checks and their database rules
```

`verify:room` matters most: it checks, in the dev project's own database, that
a hider cannot send their position. These scripts leave test users behind in
the dev project. That's harmless, but it's one more reason not to point them
at production.

### By hand, on phones

Open <https://dev.jetleg-sf.pages.dev> on each phone (Safari: Share → **Add to
Home Screen**, then open it from there). Allow location when asked.

1. **Landing page**: the San Francisco board picture and the menu.
2. **Start a game** → type `san` → *San Francisco* → **Play** on the built-in board.
3. **Start a new round** → paywall → **Developer or tester?** → your listed
   email → **I have a testing code** → the code from §3. The paywall closes;
   start the round.
4. **Two phones in one game:** on both, tap **Game** (GPS row) → one creates,
   the other joins with the six-character code. Switch one phone to
   **Hider** in the top bar. The
   seeker's dot appears on the hider's map; the hider sends nothing. Then
   start a round as the hider: the answers are measured from the seeker's
   live position.
5. **Ask a few questions**, then **Log** → **End this round** → **Results** →
   the round. Or use **Game stats** on the landing page. On a seeking round,
   set *Where was the hider?* to see distances.
6. **Game file**: on the stats page, **Save this round as a file**, then
   **Open a game file** on another device. Nothing is uploaded.
7. **Map studio**: *Create a map* → *New city* → search a place → build it →
   sign in (testing code again) → **Publish**. Back on *Start a game* the
   city appears with its flag and map count.
8. **Sharing switch**: on the stats page, *Sharing* is off. Turn it on, end a
   round on a device that has joined a game, and the round shows up in the
   dev project's `rounds` table (Table Editor).

The **?** tab in the game checks secure origin, location, WebGL and storage,
and has *clear cache and reload* for a phone holding an old version.

## 8. Optional: payments in Stripe test mode

Only needed to test buying a pass; developer access covers everything else.

1. Stripe dashboard, **test mode** → Product catalogue: two one-time prices,
   "72 hour pass" $0.99 and "1 week pass" $3.50. Copy both `price_…` ids.
2. Developers → Webhooks → **Add endpoint**:
   `https://<ref>.supabase.co/functions/v1/stripe-webhook`, event
   `checkout.session.completed`. Copy its signing secret (`whsec_…`).
3. Set the secrets. They apply to the next function call; there's nothing to
   redeploy:

   ```bash
   npx supabase secrets set \
     STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     STRIPE_PRICE_SINGLE_GAME=price_... \
     STRIPE_PRICE_WEEK_PASS=price_...
   ```

4. On a phone that is **not** a developer, buy a pass with card
   `4242 4242 4242 4242`, any future date, any CVC. You return to the game
   with the paywall gone.

More detail: `PAYMENTS_TESTING.md` §5.

---

## When something is wrong

| Symptom | Cause, and fix |
|---|---|
| `check-backend: … does not exist` | `.env.dev.local` is missing. See §5. |
| `check-backend: the build talks to http://127.0.0.1:54321` | The build used `.env.local`. Use `npm run build:dev`, not `npm run build`. |
| The site loads, but sign-in, games and maps all fail | The build has the wrong backend, or the wrong key. Run `npm run build:dev` and read the `check-backend` line. |
| "Email me a code" never arrives | Expected on the built-in sender for anyone outside your Supabase organisation. Use the testing code (§4), or set up SMTP (§2). |
| The emailed code is eight digits, or won't fit | *Email OTP length* isn't 6 (§2). |
| The testing code is refused | The address isn't on `test-login.ts --list`, `TEST_LOGIN_CODE` isn't set (`npx supabase secrets list`), `test-login` wasn't deployed, or the address is locked after ten wrong tries. |
| Signed in, but the paywall stays up | The address isn't on the developer list: `grant-developer.ts` (§4). |
| Stripe says the webhook failed with 401 | `stripe-webhook` was deployed with JWT checks on. Redeploy with `--no-verify-jwt`. |
| Stripe says `signature verification failed` | `STRIPE_WEBHOOK_SECRET` belongs to a different endpoint. Each endpoint has its own. |
| No location on the phone | It must be the `https://` address. Check the **?** tab. On iOS: Settings → Privacy → Location Services → Safari Websites. |
| A phone still shows the old version | Close and reopen the app twice (the service worker updates on the next load), or **?** → *clear cache and reload*. Then run `npm run verify:live https://dev.jetleg-sf.pages.dev`. |
| `verify:room` fails once with `CHANNEL_ERROR` right after a migration | Realtime catches up with a schema change on the next connection. Run it again; if it fails twice, it is real. |
| No "Continue with Google" button | Google is off on the project, which is how it should be until §9 is done. The app asks Supabase and hides the button. |
| Google says `redirect_uri_mismatch` | The Google client's *Authorized redirect URI* must be exactly `https://<ref>.supabase.co/auth/v1/callback`. |
| Google says the app is in testing / access blocked | Add the address under Google Auth Platform → Audience → *Test users*, or publish the app there. |
| Everything worked last week and now nothing does | Free Supabase projects pause after about a week without use. Dashboard → *Restore project*. |

## 9. Google sign-in

The app offers **Continue with Google** wherever it asks someone to sign in,
but only once Google is switched on for the project. Until then the button
does not appear.

**What is kept:** the Google account's id, its email and its name, and nothing
else. The app asks Google only for the basic sign-in permissions, `openid
email profile`, the least Google offers that includes a name. Google's
`profile` also sends a picture and a language. Migration
`0012_google_sign_in.sql` throws those away as the account is written, on
every sign-in. The name is only ever *suggested* as a display name.

Google's consent screen will still say the app can see your *name and profile
picture*. That is how Google words the `profile` permission. There is no
Google permission for a name without the picture.

### In Google Cloud (about ten minutes)

1. <https://console.cloud.google.com> → create a project, e.g. `JetLeg`.
2. **Google Auth Platform → Branding:** app name `JetLeg`, your support
   email. Under *Authorized domains* add `supabase.co` and `pages.dev`.
3. **Audience:** *External*. While it says *Testing*, only addresses listed
   under *Test users* can sign in, so add yours and your testers'. *Publish
   app* lifts that. The basic sign-in permissions need no Google review.
4. **Data Access:** add exactly three scopes: `openid`,
   `.../auth/userinfo.email`, `.../auth/userinfo.profile`. Nothing else.
5. **Clients → Create client → Web application:**
   - *Authorized JavaScript origins*: `https://dev.jetleg-sf.pages.dev`
   - *Authorized redirect URIs*: `https://dwdgysnclfetwmuteefy.supabase.co/auth/v1/callback`
     (the Supabase project, not the site: Google hands back to Supabase,
     which hands back to the app)

   Copy the **Client ID** and **Client secret**.

### In Supabase

**Authentication → Sign In / Providers → Google:** switch it on, paste the
Client ID and Client secret, save. Leave *Skip nonce check* off.

That's all. There's no redeploy: the app asks Supabase whether Google is on.
Open <https://dev.jetleg-sf.pages.dev/#/maps> and the button appears in the
sign-in box at the bottom.

### Check it

1. On a phone that has never signed in: *Explore maps* → **Continue with
   Google** → choose your account. You come back to the same page, signed
   in, with your Google name offered as a display name. Change it if you like.
2. Supabase dashboard → Authentication → Users → your user → the raw
   metadata shows `email`, `name`, `full_name`, `sub` and nothing like
   `picture` or `avatar_url`.
3. `npm run verify:google` covers the app's half of this — button, return
   page, refusals — without Google, against any build.

**Known risk, untested:** on iPhone, an app added to the home screen may
finish Google's sign-in in Safari rather than in itself. The app then says
sign-in "finished somewhere else". Signing in once from Safari, or with the
testing code, avoids it. Worth trying on a real iPhone before relying on it.

## Who can see the dev copy

`dev.jetleg-sf.pages.dev` is public: anyone with the link can open it. To
restrict it, use the Cloudflare dashboard → Workers & Pages → `jetleg-sf` →
Settings → *Access policy* for preview deployments. Each tester then signs in
through Cloudflare Access first.

The dev Supabase project is yours alone, and its data is test data. Nothing in
it reaches production. When this branch goes live, production gets its own
project, set up the same way (`NEXT_STEPS.md`, "Before this reaches real
players").
