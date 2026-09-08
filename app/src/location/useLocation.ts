import { useEffect, useRef, useState } from 'react';
import type { LngLat } from '../engine/types';

export type Fix = {
  coords: LngLat;
  /** Radius of the 68% confidence circle, in metres. */
  accuracyM: number;
  at: number;
};

export type LocationState = {
  fix: Fix | null;
  status: 'idle' | 'prompting' | 'watching' | 'denied' | 'unavailable' | 'error';
  error: string | null;
  start: () => void;
  stop: () => void;
};

const STALE_AFTER_S = 30;

/**
 * Live GPS, kept in one place so every panel reads the same position.
 *
 * Design notes:
 *  - watchPosition, not getCurrentPosition: the thermometer and radar anchor on
 *    where the seeker is *now*, and a one-shot fix goes stale immediately.
 *  - Denial is a first-class state, not an error. Every flow that consumes a
 *    fix must also accept a hand-dropped pin, because permission can be denied,
 *    revoked, or simply unavailable in a BART tunnel.
 *  - A backgrounded mobile browser suspends the watch. Rather than fighting
 *    that, we re-acquire on foreground and expose the fix age so the UI can say
 *    plainly that the reading is old.
 */
export function useLocation(autoStart = true): LocationState {
  const [fix, setFix] = useState<Fix | null>(null);
  const [status, setStatus] = useState<LocationState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);

  const stop = () => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
  };

  const start = () => {
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      setError('This browser has no geolocation support.');
      return;
    }
    // Geolocation is blocked on insecure origins; localhost is exempt.
    if (!window.isSecureContext) {
      setStatus('unavailable');
      setError('Location needs HTTPS. Open the site over https:// or on localhost.');
      return;
    }
    stop();
    setStatus((s) => (s === 'watching' ? s : 'prompting'));
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus('watching');
        setError(null);
        setFix({
          coords: [pos.coords.longitude, pos.coords.latitude],
          accuracyM: pos.coords.accuracy ?? 0,
          at: Date.now(),
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied');
          setError('Location permission denied. You can still drop pins by hand.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setStatus('error');
          setError('No position available right now — common underground.');
        } else {
          setStatus('error');
          setError(err.message || 'Location timed out.');
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  };

  useEffect(() => {
    if (autoStart) start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // Re-acquire when the tab comes back; mobile browsers suspend the watch.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && status !== 'denied' && status !== 'unavailable') start();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return { fix, status, error, start, stop };
}

/**
 * Fix age, ticking once a second.
 *
 * Deliberately its own hook rather than part of useLocation: a clock inside the
 * shared location state re-rendered the whole app every second, which re-ran the
 * full map redraw (rebuilding every GeoJSON source) and replaced live DOM nodes
 * mid-tap. Only the component showing the readout needs to re-render.
 */
export function useFixAge(fix: Fix | null): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!fix) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [fix]);
  return fix ? Math.round((Date.now() - fix.at) / 1000) : null;
}

export const isStale = (ageSeconds: number | null) => ageSeconds !== null && ageSeconds > STALE_AFTER_S;

export function describeAccuracy(m: number): string {
  if (m <= 10) return 'good';
  if (m <= 30) return 'fair';
  if (m <= 75) return 'poor';
  return 'very poor';
}
