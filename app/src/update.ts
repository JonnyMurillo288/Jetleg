import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * Keeping an installed copy of the app current.
 *
 * The app works offline because a service worker keeps a copy of it. A
 * browser only looks for a newer copy when a page is freshly opened, and an
 * app on a phone's home screen mostly *resumes* instead — so a phone could
 * run a build days old against a backend that had moved on. That is how a
 * phone ended up calling a chat function the server no longer had.
 *
 * So the app looks itself: on coming back to the foreground, and every half
 * hour. A new version found while the app is just opening is applied at
 * once, before the player has done anything; later, it waits for them to tap
 * Update, so a reload never lands in the middle of answering a question.
 */

const OPENING_MS = 10_000;
const CHECK_EVERY_MS = 30 * 60_000;

let ready = false;
const listeners = new Set<() => void>();
let apply: ((reload?: boolean) => Promise<void>) | null = null;

export function startUpdates(): void {
  if (!('serviceWorker' in navigator)) return;
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (performance.now() < OPENING_MS) { void apply?.(true); return; }
      ready = true;
      listeners.forEach((l) => l());
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => { if (navigator.onLine) registration.update().catch(() => {}); };
      window.setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    },
  });
}

/** Whether a newer version is waiting, and the way to switch to it. */
export function useUpdate(): { ready: boolean; update: () => void } {
  const isReady = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => ready,
  );
  return { ready: isReady, update: () => void apply?.(true) };
}
