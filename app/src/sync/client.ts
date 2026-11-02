import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * `null` when the app is built with no Supabase env vars — history sync is
 * additive, not required, and the local-first game must keep working with
 * no backend configured at all, exactly as it does with no network.
 */
export const supabase = url && anonKey
  ? createClient(url, anonKey, {
      // PKCE, not the default implicit flow, for the one sign-in that leaves
      // the page (Google). The implicit flow hands tokens back in the URL's
      // fragment and then clears it — and the fragment is this app's page
      // (route.ts), so every Google sign-in would land on the landing page.
      // PKCE returns `?code=` instead and removes only that.
      auth: { flowType: 'pkce' },
    })
  : null;
