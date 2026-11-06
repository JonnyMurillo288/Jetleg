import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { supabase } from '../sync/client';
import { getOrCreateDeviceId } from '../sync/identity';
import { isProduct, type LegacyProduct, type Product } from './products';

export type { Product } from './products';

const CACHE_KEY = 'payments/entitlement';

export type CachedEntitlement = {
  eligible: boolean;
  /** 'developer' is not for sale: it is what a listed developer's sign-in reports (0007_developers.sql). */
  product: Product | LegacyProduct | 'developer' | null;
  /** ISO, device's own clock compares it. Null for a room whose clock has not started yet. */
  expiresAt: string | null;
  /** The game room this pass is a place in (0015_room_passes.sql), or the game a granted per-device pass named. */
  gameId: string | null;
};

/** Fired on `window` whenever the cached pass changes, so what shows it need not wait for its next poll. */
export const ENTITLEMENT_EVENT = 'jetleg:entitlement';

const INELIGIBLE: CachedEntitlement = { eligible: false, product: null, expiresAt: null, gameId: null };

/**
 * A non-2xx edge function response reaches supabase-js as a generic
 * "Edge Function returned a non-2xx status code" — `data` is discarded, so
 * the function's own `{ error: "..." }` body has to be re-read off the raw
 * Response on `error.context`. Falls back to the generic message when that
 * fails (e.g. a network-level FunctionsFetchError with no response at all).
 */
async function functionErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === 'function') {
    const body = await context.json().catch(() => null);
    // Our own functions return `{ error }`; a crash before that (e.g. a
    // missing secret throwing at module load) reaches the client as the
    // edge runtime's own `{ code, message }` wrapper instead.
    const reason = body?.error ?? body?.message;
    if (typeof reason === 'string') return reason;
  }
  return (error as { message?: string })?.message ?? 'Request failed.';
}

/**
 * Pure so it's testable with no IndexedDB involved. A room with no expiry
 * yet is one whose clock starts at its first round; starting that round
 * goes through `startRoomClock`, which needs the server.
 */
export function isStillValid(cached: CachedEntitlement | null | undefined, nowMs: number): boolean {
  if (!cached?.eligible) return false;
  if (!cached.expiresAt) return isProduct(cached.product);
  return new Date(cached.expiresAt).getTime() > nowMs;
}

/**
 * Reads the last successful server check. This is the offline path: an
 * already-activated window keeps working with no signal for its remaining
 * hours, the one part of "works underground all day" this feature can still
 * honour. A device's very first activation still needs one round-trip —
 * there's no way to verify a payment without asking the server at least once.
 */
export async function hasCachedValidEntitlement(): Promise<boolean> {
  const cached = await idbGet<CachedEntitlement>(CACHE_KEY);
  return isStillValid(cached, Date.now());
}

/** Signing out leaves a device with no claim to the account's pass; see community/account.ts. */
export async function forgetCachedEntitlement(): Promise<void> {
  await idbDel(CACHE_KEY);
  window.dispatchEvent(new Event(ENTITLEMENT_EVENT));
}

export async function getCachedEntitlement(): Promise<CachedEntitlement | null> {
  return (await idbGet<CachedEntitlement>(CACHE_KEY)) ?? null;
}

/**
 * The real check: reports eligibility via the security-definer RPC
 * (0002_entitlements.sql, now 0015_room_passes.sql). With `startClock`, a
 * room this device has a place in whose clock has not started starts it
 * now. Never trust this function's return value as the
 * security boundary from the client's own side — the RPC is what actually
 * enforces it, this just reflects the answer back into the UI and the
 * offline cache.
 */
export async function checkEntitlement(startClock = false): Promise<CachedEntitlement> {
  if (!supabase) return INELIGIBLE;

  const deviceId = await getOrCreateDeviceId();
  if (!deviceId) return INELIGIBLE;

  const { data, error } = await supabase
    .rpc('check_and_activate_entitlement', { start_clock: startClock })
    .single<{ eligible: boolean; product: string | null; expires_at: string | null; game_id: string | null }>();
  if (error || !data) return INELIGIBLE;

  const result: CachedEntitlement = {
    eligible: data.eligible,
    product: (data.product as CachedEntitlement['product']) ?? null,
    expiresAt: data.expires_at ?? null,
    gameId: data.game_id ?? null,
  };
  await idbSet(CACHE_KEY, result);
  window.dispatchEvent(new Event(ENTITLEMENT_EVENT));
  return result;
}

/**
 * Called just before a round starts, or an ended one is reopened. A room's
 * clock starts at its first round, not when it was bought, so this is where
 * it starts. Returns why play cannot begin, or null.
 */
export async function startRoomClock(): Promise<string | null> {
  const cached = await getCachedEntitlement();
  if (!cached?.eligible || cached.expiresAt) return null;
  const started = await checkEntitlement(true);
  if (started.eligible && started.expiresAt) return null;
  return started.eligible || !navigator.onLine
    ? 'Starting the game room’s clock needs a connection. Try again with signal.'
    : 'This phone has no place in a game room with time left.';
}

/** Redirects to a Stripe Checkout session that buys a game room. */
export async function startCheckout(product: Product): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Payments are not configured.' };
  // Checkout is tied to this phone's account; make sure it has one.
  if (!(await getOrCreateDeviceId())) return { error: 'Could not reach the game server. Check your connection.' };

  const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>(
    'stripe-checkout',
    { body: { product } },
  );
  if (error || !data?.url) return { error: error ? await functionErrorMessage(error) : (data?.error ?? 'Checkout failed.') };

  window.location.href = data.url;
  return {};
}
