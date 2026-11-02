import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import App from './App';
import { StudioApp } from './studio/StudioApp';
import { Landing } from './pages/Landing';
import { StartGame } from './pages/StartGame';
import { StatsPage } from './pages/StatsPage';
import { AboutPage, PrivacyPage } from './pages/InfoPages';
import { parseRoute, useRoute } from './route';
import { finishGoogleSignIn, restorePageAfterGoogle } from './community/account';
import { startUpdates } from './update';
import { UpdateBanner } from './ui/UpdateBanner';

/**
 * Several pages in one bundle, chosen by hash (route.ts): the landing page,
 * the game at `#/play`, the map studio at `#/maps`, and the pages around them.
 *
 * Only one is ever mounted. The game, the studio and the stats page share
 * the engine, whose caches and projection belong to whichever board was
 * loaded last, and each re-enters its own board when it mounts.
 */

// Stripe sends a buyer back to the site's root with `?checkout=…`. The game
// is what reads that, and it no longer lives at the root.
if (new URLSearchParams(window.location.search).has('checkout') && parseRoute(window.location.hash).page === 'home') {
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#/play`);
}

// Back from Google sign-in: put the page back now, finish the sign-in after.
restorePageAfterGoogle();
void finishGoogleSignIn();
startUpdates();

function Root() {
  const route = useRoute();
  switch (route.page) {
    case 'play': return <App />;
    case 'maps': return <StudioApp openId={route.open ?? null} create={!!route.create} />;
    case 'start': return <StartGame />;
    case 'stats': return <StatsPage />;
    case 'about': return <AboutPage />;
    case 'privacy': return <PrivacyPage />;
    default: return <Landing />;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
    <UpdateBanner />
  </StrictMode>,
);
