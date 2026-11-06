import { useEffect, useState } from 'react';
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { supabase } from '../sync/client';

/**
 * Signing in — the first visible login the app has.
 *
 * Every device already has an anonymous identity (sync/identity.ts), which is
 * enough to play, pay and join a game. Publishing a map, liking one or
 * commenting needs more: a verified email, checked by `is_signed_in()` in the
 * database. Nothing else in the app requires this, and none of it is needed
 * to browse or play a community map.
 *
 * The sign-in is a six-digit code typed into the app, not a link — a link
 * from an email opens in the phone's browser, which is a different place
 * from an installed PWA and would sign in the wrong one.
 *
 * Two cases, one form:
 *  - an address nobody has used: it is attached to *this* device's existing
 *    identity, which keeps its id — so its pass and its game come with it;
 *  - an address that already has an account: this device signs into that
 *    account, and its own anonymous identity is left behind.
 *
 * Google sign-in follows the same two cases (`signInWithGoogle`), by linking
 * the Google account to this device's identity, or, when that Google account
 * is already someone's, signing into it. It is the one sign-in that leaves
 * the page, so it finishes on the way back in (`finishGoogleSignIn`).
 */

export type Account =
  | { state: 'unavailable' }
  | { state: 'loading' }
  | { state: 'guest' }
  | {
      state: 'signedIn';
      userId: string;
      email: string;
      displayName: string | null;
      /** The name the account came with — Google's — to offer as a display name. Never used unasked. */
      suggestedName: string | null;
    };

/** Which kind of code was sent, and so how it must be verified. */
export type CodeKind = 'email_change' | 'email';

const PROFILE_KEY = 'sync/profile';
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

async function readAccount(): Promise<Account> {
  if (!supabase) return { state: 'unavailable' };
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user || user.is_anonymous || !user.email) return { state: 'guest' };
  const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
  const meta = user.user_metadata ?? {};
  const suggested = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : '';
  return {
    state: 'signedIn',
    userId: user.id,
    email: user.email,
    displayName: profile?.display_name ?? null,
    suggestedName: suggested.trim().slice(0, 40) || null,
  };
}

export function useAccount(): Account {
  const [account, setAccount] = useState<Account>(supabase ? { state: 'loading' } : { state: 'unavailable' });
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    const load = () => readAccount().then((a) => { if (!cancelled) setAccount(a); });
    load();
    listeners.add(load);
    const { data } = supabase.auth.onAuthStateChange(() => { load(); });
    return () => { cancelled = true; listeners.delete(load); data.subscription.unsubscribe(); };
  }, []);
  return account;
}

const explain = (message: string | undefined) =>
  !message || /fetch|network/i.test(message) ? 'Could not reach the server. Check your connection.' : message;

export async function requestCode(email: string): Promise<{ ok: true; kind: CodeKind } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'This build has no server configured.' };
  const address = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) return { ok: false, error: 'Enter a valid email address.' };

  const { data } = await supabase.auth.getSession();
  if (data.session?.user?.is_anonymous) {
    const { error } = await supabase.auth.updateUser({ email: address });
    if (!error) return { ok: true, kind: 'email_change' };
    if (error.code !== 'email_exists') return { ok: false, error: explain(error.message) };
    // Already someone's account — fall through and sign into it.
  }
  const { error } = await supabase.auth.signInWithOtp({ email: address });
  return error ? { ok: false, error: explain(error.message) } : { ok: true, kind: 'email' };
}

export async function verifyCode(email: string, code: string, kind: CodeKind): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'This build has no server configured.' };
  const before = (await supabase.auth.getSession()).data.session?.user?.id;
  const address = email.trim().toLowerCase();
  let { data, error } = await supabase.auth.verifyOtp({ email: address, token: code.trim(), type: kind });
  if (error || !data.user) {
    // Not the emailed code — it may be the fixed testing code, which only
    // the server can judge (supabase/functions/test-login).
    const viaTest = await redeemTestCode(address, code.trim());
    if (viaTest) ({ data, error } = viaTest);
  }
  if (error || !data.user) {
    return { ok: false, error: /expired|invalid/i.test(error?.message ?? '') ? 'That code is wrong or has expired.' : explain(error?.message) };
  }
  if (before && before !== data.user.id) await forgetDeviceIdentity();
  changed();
  return { ok: true };
}

// ------------------------------------------------------------------ Google

const GOOGLE_PENDING = 'auth/google-pending';
const GOOGLE_ERROR = 'auth/google-error';

type GooglePending = {
  /** The page to come back to — `#/maps`, `#/play` — since Google returns to the bare origin. */
  hash: string;
  /** Linking Google to this device's identity, or signing into an existing account. */
  mode: 'link' | 'signin';
  /** The device's identity when it left, to tell afterwards whether it changed. */
  before: string | null;
};

const session = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private mode: lose only the return page */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* as above */ } },
};

let googleOn: Promise<boolean> | null = null;
/**
 * Is Google sign-in switched on for this project? Asked of the server rather
 * than assumed, so the button never appears where pressing it would fail.
 */
export function googleEnabled(): Promise<boolean> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!supabase || !url || !key) return Promise.resolve(false);
  googleOn ??= fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => s?.external?.google === true)
    .catch(() => false);
  return googleOn;
}

/**
 * Leave for Google. Only Supabase's default scopes are asked for — `openid
 * email profile`, the least Google offers that includes a name — and the
 * database keeps nothing from them but the email and the name
 * (0012_google_sign_in.sql).
 */
export async function signInWithGoogle(mode?: GooglePending['mode']): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'This build has no server configured.' };
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user ?? null;
  const how: GooglePending['mode'] = mode ?? (user?.is_anonymous ? 'link' : 'signin');
  const pending: GooglePending = { hash: window.location.hash || '#/', mode: how, before: user?.id ?? null };
  session.set(GOOGLE_PENDING, JSON.stringify(pending));
  session.del(GOOGLE_ERROR);
  // No fragment and no query: Supabase appends `?code=` to this.
  const options = { redirectTo: `${window.location.origin}${window.location.pathname}` };
  const { error } = how === 'link'
    ? await supabase.auth.linkIdentity({ provider: 'google', options })
    : await supabase.auth.signInWithOAuth({ provider: 'google', options });
  // On its way to Google: the note above is what brings it back here.
  if (!error) return { ok: true };
  // Linking can be refused before leaving at all (manual linking switched
  // off on the project); signing in is the other way to the same account.
  if (how === 'link') return signInWithGoogle('signin');
  session.del(GOOGLE_PENDING);
  return { ok: false, error: explain(error.message) };
}

/**
 * Put the page back before anything renders: Google returns to the bare
 * origin, and the page lives in the fragment. Synchronous on purpose —
 * main.tsx calls it before the router reads the address.
 */
let returned: { errorCode: string | null; errorText: string | null } | null = null;

export function restorePageAfterGoogle(): void {
  const raw = session.get(GOOGLE_PENDING);
  if (!raw) return;
  const query = new URLSearchParams(window.location.search);
  // A failure can come back after the `#` instead — where this app keeps its page.
  const hash = window.location.hash.startsWith('#/') ? new URLSearchParams() : new URLSearchParams(window.location.hash.slice(1));
  const pick = (k: string) => query.get(k) ?? hash.get(k);
  if (!query.has('code') && !pick('error') && !pick('error_code')) return;
  returned = { errorCode: pick('error_code'), errorText: pick('error_description') ?? pick('error') };
  let page = '#/';
  try { page = (JSON.parse(raw) as GooglePending).hash || '#/'; } catch { /* a malformed note: the landing page */ }
  const onPage = window.location.hash.startsWith('#/') && window.location.hash.length > 2;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${onPage ? window.location.hash : page}`);
}

/**
 * Back from Google: see what happened, tidy the address, and act on it.
 * Resolves once the device's identity is settled.
 */
export async function finishGoogleSignIn(): Promise<void> {
  if (!supabase) return;
  const raw = session.get(GOOGLE_PENDING);
  if (!raw || !returned) return;
  session.del(GOOGLE_PENDING);
  let pending: GooglePending;
  try { pending = JSON.parse(raw); } catch { return; }

  // The client exchanges the code itself on load; wait for that.
  await supabase.auth.initialize();
  const { errorCode, errorText } = returned;
  const params = new URLSearchParams(window.location.search);
  for (const k of ['code', 'error', 'error_code', 'error_description', 'sb']) params.delete(k);
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);

  // That Google account is already someone's: sign into it instead.
  if (errorCode === 'identity_already_exists' && pending.mode === 'link') {
    await signInWithGoogle('signin');
    return;
  }
  if (errorCode || errorText) {
    session.set(GOOGLE_ERROR, errorText?.replace(/\+/g, ' ') || 'Google sign-in did not finish.');
    changed();
    return;
  }
  const now = (await supabase.auth.getSession()).data.session?.user;
  if (!now || now.is_anonymous) {
    // A code with nothing to exchange it against: the sign-in was started in another browser.
    session.set(GOOGLE_ERROR, 'Google sign-in finished somewhere else — in another browser or app. Try again from here.');
  } else if (pending.before && pending.before !== now.id) {
    await forgetDeviceIdentity();
  }
  changed();
}

/** Why the last Google sign-in failed, once; then forgotten. */
export function takeGoogleError(): string | null {
  const e = session.get(GOOGLE_ERROR);
  if (e) session.del(GOOGLE_ERROR);
  return e;
}

/**
 * The fixed testing code, for addresses listed as testers. The function
 * answers with a one-time token only if the feature is on, the address is
 * listed and the code matches; that token is then redeemed like any other,
 * so Auth mints the session. Null means "not a testing code" — for any
 * reason, which is all the server will say.
 */
async function redeemTestCode(email: string, code: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.functions.invoke<{ tokenHash?: string }>('test-login', { body: { email, code } });
  if (error || !data?.tokenHash) return null;
  return supabase.auth.verifyOtp({ token_hash: data.tokenHash, type: 'email' });
}

/**
 * This device just became a different user. What it cached about the old one
 * — its profile, its team, the game it was in — belongs to an identity it no
 * longer holds, and acting on it would fail in confusing ways.
 */
async function forgetDeviceIdentity(): Promise<void> {
  // The cached pass too: it was the old identity's, and a cached "eligible"
  // would otherwise keep a signed-out developer playing for weeks.
  await Promise.all([idbDel(PROFILE_KEY), idbDel('sync/team'), idbDel('live/game'), idbDel('payments/entitlement')]);
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
  await forgetDeviceIdentity();
  changed();
}

/**
 * Delete this account from the server (0017): profile, published maps,
 * comments, likes and reports go with it. Then this device carries on as a
 * fresh anonymous one, exactly as after signing out. Rounds on the phone
 * were never on the server and are not touched.
 */
export async function deleteMyAccount(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'This build has no server configured.' };
  const { error } = await supabase.rpc('delete_my_account');
  if (error) return { ok: false, error: explain(error.message) };
  await signOut();
  return { ok: true };
}

/** The name maps and comments are published under. */
export async function setDisplayName(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'This build has no server configured.' };
  const displayName = name.trim().slice(0, 40);
  if (!displayName) return { ok: false, error: 'Enter a name.' };
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) return { ok: false, error: 'Sign in first.' };
  const { error } = await supabase.from('profiles').upsert({ id, display_name: displayName });
  if (error) return { ok: false, error: explain(error.message) };
  const cached = await idbGet<{ id: string; displayName: string }>(PROFILE_KEY);
  await idbSet(PROFILE_KEY, { ...(cached ?? {}), id, displayName });
  changed();
  return { ok: true };
}
