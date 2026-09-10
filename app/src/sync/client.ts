import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * `null` when the app is built with no Supabase env vars — history sync is
 * additive, not required, and the local-first game must keep working with
 * no backend configured at all, exactly as it does with no network.
 */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
