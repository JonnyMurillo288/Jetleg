// Verification for developer access (0007_developers.sql, grant-developer.ts):
// first what the database decides, then the whole path in a real browser —
// a fresh device hits the paywall, signs in with a listed email, and plays.
//
// Needs `supabase start` and a built app on :4310
// (`npm run build && npx vite preview --port 4310`).
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const mailUrl = process.env.MAILPIT_URL || 'http://127.0.0.1:54324';
const target = process.env.TARGET || 'http://127.0.0.1:4310/';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};

const admin = createClient(url, serviceKey);
const run = Date.now();
type Eligibility = { eligible: boolean; product: string | null; expires_at: string | null };

async function member(email: string) {
  const password = `pw-${run}`;
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw new Error(made.error.message);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(error?.message);
  return { client, id: data.user.id };
}
const eligibility = async (client: ReturnType<typeof createClient>) =>
  (await client.rpc('check_and_activate_entitlement').single<Eligibility>()).data;

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent('to:' + email)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${mailUrl}/api/v1/message/${list.messages[0].ID}`)).json();
      const code = (msg.Text as string).match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no code arrived for ${email}`);
}

(async () => {
  // ---- what the database decides
  const devEmail = `dev-${run}@example.com`;
  const dev = await member(devEmail);
  const other = await member(`other-${run}@example.com`);
  const guest = createClient(url, anonKey, { auth: { persistSession: false } });
  await guest.auth.signInAnonymously();

  check('a signed-in user not on the list is not entitled', (await eligibility(dev.client))?.eligible === false);
  await admin.from('developers').upsert({ email: devEmail, note: 'verify:developer' });

  const granted = await eligibility(dev.client);
  check('once listed, the same user is entitled, as a developer', granted?.eligible === true && granted.product === 'developer', granted);
  const days = (new Date(granted!.expires_at!).getTime() - Date.now()) / 86_400_000;
  check('...for a rolling thirty days', days > 29 && days < 31, days.toFixed(1));
  check('another signed-in user is unaffected', (await eligibility(other.client))?.eligible === false);
  check('an anonymous device is unaffected', (await eligibility(guest))?.eligible === false);

  const peek = await dev.client.from('developers').select('email');
  check('the list is unreadable, even to a developer', (peek.data?.length ?? 0) === 0);
  const selfServe = await other.client.from('developers').insert({ email: `other-${run}@example.com` });
  check('nobody can add themselves to it', !!selfServe.error);

  // An anonymous device that attaches the listed address but never verifies it gets nothing.
  const squat = await guest.auth.updateUser({ email: `squat-${run}@example.com` });
  await admin.from('developers').upsert({ email: `squat-${run}@example.com` });
  check('an unverified claim to a listed address is not developer access', !squat.error && (await eligibility(guest))?.eligible === false);

  await admin.from('developers').delete().eq('email', devEmail);
  check('taken off the list, access ends at once', (await eligibility(dev.client))?.eligible === false);

  // ---- the path a developer actually takes, in a browser
  const uiEmail = `uidev-${run}@example.com`;
  await admin.from('developers').upsert({ email: uiEmail, note: 'verify:developer (ui)' });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  // tsx compiles with esbuild's keepNames, which wraps functions in a
  // `__name` helper that does not exist inside the page. Define it there.
  await p.addInitScript({ content: 'globalThis.__name = (f) => f;' });
  await p.addInitScript(() => {
    const fix = { coords: { latitude: 37.7793, longitude: -122.4194, accuracy: 18 }, timestamp: Date.now() };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (cb: any) => setTimeout(() => cb(fix), 50), watchPosition: (cb: any) => { setTimeout(() => cb(fix), 50); return 1; }, clearWatch: () => {} },
    });
  });
  const click = (text: string, sel = 'button') => p.evaluate(([t, s]) => {
    const el = [...document.querySelectorAll<HTMLButtonElement>(s)].find((e) => new RegExp(t, 'i').test(e.textContent || '') && !e.disabled);
    if (!el) throw new Error(`no enabled element matching ${t} in ${s}`);
    el.click();
  }, [text, sel]);

  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => (window as any).__mapReady === true, null, { timeout: 45000 });
  await p.waitForTimeout(2500);
  await click('Start a new round');
  await p.waitForSelector('.accountbox', { timeout: 10000 });
  check('a fresh device meets the paywall, with a way in for developers', /Unlock JetLeg SF/.test((await p.textContent('.sheet')) ?? '') && /Developer or tester/.test((await p.textContent('.sheet')) ?? ''));

  await p.fill('.accountbox input[type="email"]', uiEmail);
  await click('Email me a code');
  await p.waitForSelector('.accountbox input.code', { timeout: 15000 });
  await p.fill('.accountbox input.code', await codeFor(uiEmail));
  await click('^Sign in$');
  // The paywall goes away on its own once the sign-in is seen to be entitled.
  const unlocked = await p.waitForFunction(() => !/Unlock JetLeg SF/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 20000 }).then(() => true, () => false);
  check('signing in with a listed email dismisses the paywall', unlocked);
  await click('Start a new round');
  const playing = await p.waitForSelector('.qrow', { timeout: 15000 }).then(() => true, () => false);
  check('...and a round actually starts', playing);
  await p.waitForFunction(() => /Developer access/.test(document.querySelector('.topbar')?.textContent || ''), null, { timeout: 70000 }).catch(() => {});
  check('the top bar says “Developer access”', /Developer access/.test((await p.textContent('.topbar')) ?? ''));

  // Offline: the cached answer must carry a developer through a day with no signal.
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => (window as any).__mapReady === true, null, { timeout: 45000 });
  check('a reload goes straight back into the round, no paywall', await p.waitForSelector('.qrow', { timeout: 15000 }).then(() => true, () => false));

  // A round in progress pins the board: the studio will not swap it out from under the round.
  await p.evaluate(() => { location.hash = '#/maps'; });
  await p.waitForSelector('.boardnow', { timeout: 20000 });
  check('the studio says the board cannot be changed mid-round', /End your round to change boards/.test((await p.textContent('.boardnow')) ?? ''));

  check('no page errors', errors.length === 0, errors);
  await browser.close();

  for (const email of [uiEmail, `squat-${run}@example.com`]) await admin.from('developers').delete().eq('email', email);
  for (const id of [dev.id, other.id]) await admin.auth.admin.deleteUser(id);

  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:developer crashed:', e);
  process.exit(1);
});
