import { useEffect, useState } from 'react';

/**
 * Environment self-check.
 *
 * The worker check earns its place: a broken MapLibre worker renders the map
 * completely blank — no basemap and no hiding zones, since those are parsed in
 * the worker too — while every network request still returns 200 and nothing
 * appears in the console. That failure has two very different causes (a broken
 * build, or a browser refusing workers on an untrusted origin) and no visible
 * difference between them, so the panel reports the capability and lets the
 * reader pick the fix rather than asserting one.
 */

type Check = {
  label: string;
  state: 'pass' | 'fail' | 'warn' | 'pending';
  detail: string;
  fix?: string;
};

export function Diagnostics() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    let cancelled = false;
    run().then((c) => { if (!cancelled) { setChecks(c); setRunning(false); } });
    return () => { cancelled = true; };
  }, []);

  const failing = checks.filter((c) => c.state === 'fail');

  return (
    <div className="pad">
      <h3>Diagnostics</h3>

      {running && <p className="muted">Running checks…</p>}

      {!running && failing.length === 0 && (
        <p className="hint fact">Everything checks out. Location and the map should both work here.</p>
      )}

      {!running && failing.length > 0 && !certificateLikely(checks)
        && failing.some((c) => c.label === 'Location permission') && (
        <div className="hint warn">
          <b>Location is blocked for this site.</b> Everything else on this device
          is fine, so this is a permission setting rather than a broken build —
          follow the steps below to re-grant it. You can keep playing meanwhile by
          dropping pins on the map by hand.
        </div>
      )}

      {!running && failing.length > 0 && certificateLikely(checks) && (
        <div className="hint warn">
          <b>Workers are blocked, so the map cannot draw.</b> Two things cause
          this and they look identical from here:
          <br /><br />
          1. <b>An untrusted certificate.</b> iOS Safari keeps blocking workers
          on a self-signed address even after you tap through the warning. Open
          the deployed <code>*.pages.dev</code> URL rather than a
          <code> 192.168.x.x</code> one.
          <br /><br />
          2. <b>A bad build.</b> Re-run <code>npm run build</code>, which now
          fails loudly if the worker chunk is missing or broken.
          <br /><br />
          Questions, answers and zone elimination all keep working without the
          map.
        </div>
      )}

      <ul className="list checks">
        {checks.map((c) => (
          <li key={c.label}>
            <span className={`dot ${c.state}`} aria-hidden />
            <div className="grow">
              <div><b>{c.label}</b></div>
              <div className="muted small">{c.detail}</div>
              {c.fix && c.state !== 'pass' && <div className="warntext small">{c.fix}</div>}
            </div>
          </li>
        ))}
      </ul>

      <h3>Reset</h3>
      <p className="muted small">
        A service worker keeps serving the version it cached, so if you loaded a
        broken build once it can persist across reloads. This clears the cache
        and reloads from the server. <b>Your rounds are not touched</b> — they
        live in a separate store.
      </p>
      <button onClick={hardReset}>Clear cache and reload</button>

      <h3>This device</h3>
      <p className="muted small mono">{navigator.userAgent}</p>
      <p className="muted small mono">{location.origin}</p>
    </div>
  );
}

/**
 * Drop every cached asset and unregister the service worker, then reload.
 *
 * Deliberately does not touch IndexedDB: that is where rounds live, and losing
 * a day's hiding run to a troubleshooting step would be far worse than the
 * problem being fixed.
 */
async function hardReset() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Best effort — reload regardless.
  }
  location.reload();
}

/**
 * Is an untrusted certificate the actual cause?
 *
 * Blocked *workers* are the tell. A user who simply tapped "Don't Allow" on the
 * location prompt still gets working workers, so location failing on its own
 * means nothing about the certificate — pointing them at the deployed URL in
 * that case would send them chasing the wrong problem entirely.
 */
function certificateLikely(checks: Check[]): boolean {
  const failed = (label: string) => checks.find((c) => c.label === label)?.state === 'fail';
  return failed('Web workers') || failed('Secure origin');
}

async function run(): Promise<Check[]> {
  const out: Check[] = [];

  // --- secure origin
  out.push(
    window.isSecureContext
      ? { label: 'Secure origin', state: 'pass', detail: `${location.protocol}//${location.host}` }
      : {
          label: 'Secure origin',
          state: 'fail',
          detail: `${location.protocol}//${location.host} is not a secure context.`,
          fix: 'Location is blocked on plain HTTP. Open the site over https://.',
        },
  );

  // --- web workers. MapLibre parses every source in one, so a failure here
  //     blanks the entire map, not just the basemap.
  out.push(await checkWorker());

  // --- WebGL
  out.push(checkWebGL());

  // --- geolocation
  out.push(await checkGeolocation());

  // --- service worker (offline support; not fatal)
  out.push(
    'serviceWorker' in navigator
      ? (await navigator.serviceWorker.getRegistration())
        ? { label: 'Offline caching', state: 'pass', detail: 'Service worker registered.' }
        : {
            label: 'Offline caching',
            state: 'warn',
            detail: 'Service worker not registered yet.',
            fix: 'Add the app to your home screen, then reopen it. On an untrusted certificate Safari will never register one.',
          }
      : { label: 'Offline caching', state: 'warn', detail: 'Service workers unsupported in this browser.' },
  );

  // --- persistent storage
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  out.push(
    persisted
      ? { label: 'Persistent storage', state: 'pass', detail: 'Rounds will survive memory pressure.' }
      : {
          label: 'Persistent storage',
          state: 'warn',
          detail: 'Storage is evictable.',
          fix: 'Add the app to your home screen so an all-day round is not discarded. Export a round to be safe.',
        },
  );

  return out;
}

function checkWorker(): Promise<Check> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (c: Check) => { if (!settled) { settled = true; resolve(c); } };
    try {
      // A trivial module worker, the same kind MapLibre uses.
      const src = 'self.onmessage=()=>self.postMessage("ok")';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url, { type: 'module' });
      const timer = setTimeout(() => {
        w.terminate(); URL.revokeObjectURL(url);
        done({
          label: 'Web workers', state: 'fail',
          detail: 'A worker started but never replied.',
          fix: 'The map is parsed in a worker, so it will render blank. Either the build is missing the worker chunk, or this browser is refusing workers on an untrusted certificate.',
        });
      }, 4000);
      w.onmessage = () => {
        clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url);
        done({ label: 'Web workers', state: 'pass', detail: 'Module workers run — the map can parse its layers.' });
      };
      w.onerror = () => {
        clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url);
        done({
          label: 'Web workers', state: 'fail',
          detail: 'The browser refused to start a worker.',
          fix: 'This is why the map is blank. Try the deployed https address; if that fails too, the build is missing its worker chunk (run npm run build, which checks for this).',
        });
      };
      w.postMessage('ping');
    } catch (e) {
      done({
        label: 'Web workers', state: 'fail',
        detail: e instanceof Error ? e.message : 'Workers unavailable.',
        fix: 'The map cannot render without workers. Use the deployed https address.',
      });
    }
  });
}

function checkWebGL(): Check {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) {
      return {
        label: 'WebGL', state: 'fail',
        detail: 'No WebGL context available.',
        fix: 'The map needs WebGL. On iOS check Settings → Safari → Advanced → Experimental Features, or try another browser.',
      };
    }
    return { label: 'WebGL', state: 'pass', detail: c.getContext('webgl2') ? 'WebGL 2' : 'WebGL 1' };
  } catch {
    return { label: 'WebGL', state: 'fail', detail: 'WebGL threw on creation.' };
  }
}

async function checkGeolocation(): Promise<Check> {
  if (!('geolocation' in navigator)) {
    return { label: 'Location permission', state: 'fail', detail: 'No geolocation API in this browser.' };
  }

  // Safari has no Permissions API for geolocation, so fall back to a probe.
  let state: string | null = null;
  try {
    state = (await navigator.permissions?.query({ name: 'geolocation' as PermissionName }))?.state ?? null;
  } catch {
    state = null;
  }

  if (state === 'granted') {
    return { label: 'Location permission', state: 'pass', detail: 'Granted.' };
  }
  if (state === 'denied') {
    return {
      label: 'Location permission', state: 'fail',
      detail: 'Denied for this site.',
      fix: IOS_FIX,
    };
  }

  // Probe once with a short timeout.
  return new Promise<Check>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        label: 'Location permission', state: 'pass',
        detail: `Fix acquired, ±${Math.round(pos.coords.accuracy)} m.`,
      }),
      (err) => resolve(
        err.code === err.PERMISSION_DENIED
          ? { label: 'Location permission', state: 'fail', detail: 'Denied.', fix: IOS_FIX }
          : {
              label: 'Location permission', state: 'warn',
              detail: err.code === err.POSITION_UNAVAILABLE ? 'No position available (common indoors or underground).' : 'Timed out.',
              fix: 'Step outside and try again. Every flow also accepts a hand-dropped pin.',
            },
      ),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });
}

const IOS_FIX =
  'iPhone: Settings → Privacy & Security → Location Services → make sure it is on, and that Safari Websites is set to "While Using". ' +
  'Then in Safari tap the "aA" (or ⓘ) icon in the address bar → Website Settings → Location → Allow, and reload. ' +
  'If the address is a 192.168.x.x one with a certificate warning, Safari will refuse regardless — use the deployed https address.';
