/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Unset in a build with no backend configured — sync then no-ops entirely. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
