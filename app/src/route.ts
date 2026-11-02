import { useEffect, useState } from 'react';

/**
 * Every page of the site, by hash.
 *
 * A hash, not a path, on purpose. The app is served from static hosting, a
 * LAN dev server and an installed PWA's cache; a hash route works identically
 * in all three with no rewrite rule to forget.
 */
export type Route =
  | { page: 'home' }
  | { page: 'play' }
  | { page: 'start' }
  /** The map studio: browsing, one map's page (`open`), or straight into making one (`create`). */
  | { page: 'maps'; open?: string; create?: boolean }
  | { page: 'stats' }
  | { page: 'about' }
  | { page: 'privacy' };

export function parseRoute(hash: string): Route {
  const [head, ...rest] = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (head) {
    case 'play': return { page: 'play' };
    case 'start': return { page: 'start' };
    case 'stats': return { page: 'stats' };
    case 'about': return { page: 'about' };
    case 'privacy': return { page: 'privacy' };
    case 'maps':
      if (rest[0] === 'new') return { page: 'maps', create: true };
      if (rest[0] === 'map' && rest[1]) return { page: 'maps', open: decodeURIComponent(rest[1]) };
      return { page: 'maps' };
    default: return { page: 'home' };
  }
}

export const mapHref = (id: string) => `#/maps/map/${encodeURIComponent(id)}`;

/** Go to a page. `go('/play')`, `go('/maps')`, `go('/')`. */
export function go(path: string): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
