import { get as idbGet, set as idbSet } from 'idb-keyval';
import { supabase } from '../sync/client';
import { getOrCreateDeviceId } from '../sync/identity';
import type { Product } from './products';

export type { Product } from './products';

const CACHE_KEY = 'payments/entitlement';

export type CachedEntitlement = {
  eligible: boolean;
  product: Product | null;
  expiresAt: string | null; // ISO, device's own clock compares it
  /** Which game this token belongs to, if the admin who granted it (or,
   * later, the purchase flow) scoped it to one. Not surfaced in any UI
   * yet — plumbed through so it's there when shared-game features exist. */
  gameId: string | null;
};

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

/** Pure so it's testable with no IndexedDB involved. */
export function isStillValid(cached: CachedEntitlement | null | undefined, nowMs: number): boolean {
  if (!cached?.eligible || !cached.expiresAt) return false;
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

export async function getCachedEntitlement(): Promise<CachedEntitlement | null> {
  return (await idbGet<CachedEntitlement>(CACHE_KEY)) ?? null;
}

/**
 * The real check: activates the device's oldest pending purchase on first
 * use and reports eligibility, via the security-definer RPC in
 * 0002_entitlements.sql. Never trust this function's return value as the
 * security boundary from the client's own side — the RPC is what actually
 * enforces it, this just reflects the answer back into the UI and the
 * offline cache.
 */
export async function checkEntitlement(): Promise<CachedEntitlement> {
  if (!supabase) return INELIGIBLE;

  const deviceId = await getOrCreateDeviceId();
  if (!deviceId) return INELIGIBLE;

  const { data, error } = await supabase
    .rpc('check_and_activate_entitlement')
    .single<{ eligible: boolean; product: string | null; expires_at: string | null; game_id: string | null }>();
  if (error || !data) return INELIGIBLE;

  const result: CachedEntitlement = {
    eligible: data.eligible,
    product: (data.product as Product | null) ?? null,
    expiresAt: data.expires_at ?? null,
    gameId: data.game_id ?? null,
  };
  await idbSet(CACHE_KEY, result);
  return result;
}

/** Redirects to a Stripe Checkout session for the given product. */
export async function startCheckout(product: Product): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Payments are not configured.' };

  const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>(
    'stripe-checkout',
    { body: { product } },
  );
  if (error || !data?.url) return { error: error ? await functionErrorMessage(error) : (data?.error ?? 'Checkout failed.') };

  window.location.href = data.url;
  return {};
}

/** Re-binds the most recent still-usable purchase under `email` to this device. */
export async function restorePurchase(email: string): Promise<{ restored: boolean; error?: string }> {
  if (!supabase) return { restored: false, error: 'Payments are not configured.' };

  const { data, error } = await supabase.functions.invoke<{
    restored: boolean;
    product?: Product;
    expiresAt?: string;
    gameId?: string | null;
    error?: string;
  }>('restore-entitlement', { body: { email } });

  if (error) return { restored: false, error: await functionErrorMessage(error) };
  if (!data?.restored) return { restored: false };

  await idbSet(CACHE_KEY, {
    eligible: true,
    product: data.product ?? null,
    expiresAt: data.expiresAt ?? null,
    gameId: data.gameId ?? null,
  } satisfies CachedEntitlement);
  return { restored: true };
}
