/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Unset in a build with no backend configured — sync then no-ops entirely. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Where "Report a bug" addresses its email. Unset: the report can only be copied. */
  readonly VITE_REPORT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
