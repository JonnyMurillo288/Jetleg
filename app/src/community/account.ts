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
 */

export type Account =
  | { state: 'unavailable' }
  | { state: 'loading' }
  | { state: 'guest' }
  | { state: 'signedIn'; userId: string; email: string; displayName: string | null };

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
  return { state: 'signedIn', userId: user.id, email: user.email, displayName: profile?.display_name ?? null };
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
