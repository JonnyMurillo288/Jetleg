// Verification for Google sign-in's round trip (community/account.ts), with
// Google itself stood in for: Supabase's settings are made to say Google is
// on, and Google's page is never reached. What it proves is the app's part —
// the button appears only when Google is on, an anonymous device links rather
// than replaces its identity, no extra scopes are asked for, the round trip
// comes back to the page it left, and a refusal or a cancel is handled.
// What it cannot prove is a real Google sign-in succeeding: that needs the
// project's own Google client, and a person at the consent screen.
//
// Needs `supabase start` and a built app on :4310.
const { chromium } = require('playwright');
const origin = (process.env.TARGET || 'http://127.0.0.1:4310/').replace(/#.*$/, '');
const fail = [];
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? '  ' + JSON.stringify(d) : ''}`); if (!ok) fail.push(n); };
(async () => {
  const b = await chromium.launch();
  for (const googleOn of [false, true]) {
    const ctx = await b.newContext({ viewport: { width: 414, height: 896 }, serviceWorkers: 'block' });
    const went = [];
    await ctx.route(/\/auth\/v1\/settings/, async (r) => {
      const res = await r.fetch(); const j = await res.json();
      j.external = { ...(j.external || {}), google: googleOn };
      r.fulfill({ response: res, json: j });
    });
    await ctx.route(/\/auth\/v1\/user\/identities\/authorize/, (r) => { went.push({ kind: 'link', url: r.request().url() }); r.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?stand-in=link' } }); });
    await ctx.route(/accounts\.google\.com/, (r) => { went.push({ kind: 'google', url: r.request().url() }); r.fulfill({ body: '<h1>Google stand-in</h1>', contentType: 'text/html' }); });
    await ctx.route(/\/auth\/v1\/authorize\?/, (r) => { went.push({ kind: 'signin', url: r.request().url() }); r.fulfill({ body: '<h1>Supabase authorize stand-in</h1>', contentType: 'text/html' }); });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    // A device with its anonymous identity, as the game gives it.
    await p.goto(origin + '#/play'); await p.waitForFunction(() => window.__mapReady === true, null, { timeout: 45000 }); await p.waitForTimeout(2500);
    await p.goto(origin + '#/maps'); await p.waitForSelector('.accountbox', { timeout: 30000 });
    // Wait for the answer to "is Google on?" rather than for a guess at how long it takes.
    const btn = googleOn
      ? await p.waitForSelector('.accountbox button.google', { timeout: 15000 }).catch(() => null)
      : await p.waitForTimeout(3000).then(() => p.$('.accountbox button.google'));
    if (!googleOn) { check('no Google button while the project has Google switched off', btn === null); await ctx.close(); continue; }
    check('a Google button when it is on', btn !== null && /Continue with Google/.test(await btn.textContent()));
    await btn.click();
    await p.waitForURL(/accounts\.google\.com|authorize/, { timeout: 15000 }).catch(() => {});
    const first = went[0];
    const firstUrl = first ? new URL(first.url) : null;
    check('an anonymous device links Google to its own identity', first?.kind === 'link', first?.kind);
    check('…asking Google to return to the bare site, not into the page fragment', firstUrl?.searchParams.get('redirect_to') === origin, firstUrl?.searchParams.get('redirect_to'));
    check('…with no extra scopes requested', !firstUrl?.searchParams.get('scopes'), firstUrl?.searchParams.get('scopes'));
    check('…using a PKCE challenge, so the answer comes back as ?code=', !!firstUrl?.searchParams.get('code_challenge'));

    // Back from Google: that Google account already belongs to someone. Expect a switch to signing in.
    went.length = 0;
    await p.goto(origin + '?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked+to+another+user');
    await p.waitForTimeout(3000);
    const second = went.find((w) => w.kind === 'signin');
    check('a Google account that is already someone’s: the device signs into it instead', !!second && new URL(second.url).searchParams.get('provider') === 'google', went.map((w) => w.kind));

    // Back again, this time cancelled at Google's consent screen.
    went.length = 0;
    await p.goto(origin + '?error=access_denied&error_code=access_denied&error_description=The+user+cancelled');
    await p.waitForSelector('.accountbox', { timeout: 30000 });
    await p.waitForFunction(() => /cancelled/.test(document.querySelector('.accountbox')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const after = await p.evaluate(() => ({ href: location.href, box: document.querySelector('.accountbox')?.textContent || '' }));
    check('cancelled: back on the page it started from, with the error params gone', after.href === origin + '#/maps', after.href);
    check('…and the reason is shown in the sign-in box', /cancelled/.test(after.box), after.box.slice(0, 120));
    check('no page errors', errors.length === 0, errors);
    await ctx.close();
  }
  await b.close();
  console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nALL PASS');
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('verify:google crashed:', e); process.exit(1); });
