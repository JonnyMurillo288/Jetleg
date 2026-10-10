import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import App from './App';
import { StudioApp } from './studio/StudioApp';

/**
 * Two pages in one bundle: the game, and the map studio at `#/maps`.
 *
 * A hash, not a path, on purpose. The app is served from static hosting, a
 * LAN dev server and an installed PWA's cache; a hash route works identically
 * in all three with no rewrite rule to forget.
 *
 * Only one is ever mounted. They share the engine, whose caches and
 * projection belong to whichever board was loaded last, and each re-enters
 * its own board when it mounts.
 */
const isStudio = () => window.location.hash.startsWith('#/maps');

function Root() {
  const [studio, setStudio] = useState(isStudio);
  useEffect(() => {
    const onHash = () => setStudio(isStudio());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return studio ? <StudioApp /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
