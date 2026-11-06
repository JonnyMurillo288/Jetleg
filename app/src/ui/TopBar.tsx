import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store/game';
import { describeAccuracy, isStale, useFixAge, type LocationState } from '../location/useLocation';
import { formatDistance } from './units';
import { ENTITLEMENT_EVENT, getCachedEntitlement, type CachedEntitlement } from '../payments/entitlement';
import { isProduct } from '../payments/products';
import { formatTimeLeft } from './time';

export type Tab = 'play' | 'layers' | 'results' | 'game' | 'chat' | 'help';

export function TopBar(props: {
  loc: LocationState;
  alive: number;
  total: number;
  tab: Tab;
  onTab: (t: Tab) => void;
  /** The code of the game room this device is in, if any. */
  gameCode: string | null;
  /** Game chat: unread items, and questions a hider still owes an answer. */
  chatBadge: { unread: number; owed: number };
}) {
  const { loc, alive, total, tab, onTab } = props;
  const role = useGame((s) => s.role);
  const setRole = useGame((s) => s.setRole);

  // The map's floating tools sit just below the bar, and the bar's height
  // changes — a chat button, a manual-location hint, a pass line. Publish it
  // rather than have the tools guess a fixed number of pixels.
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /*
   * Three rows, because one could not hold them: at phone width the old single
   * row already cut the zone counter to "192/…". Who you are and how many
   * zones are left, with the way home and into the game; then where you are
   * in the app; then the GPS.
   */
  return (
    <header className="topbar" ref={bar}>
      <div className="topbar-row">
        <a className="homebtn" href="#/" title="Home" aria-label="Home">
          <span aria-hidden="true">⌂</span><span className="homelabel">Home</span>
        </a>
        <div className="seg">
          <button className={role === 'seeker' ? 'on' : ''} onClick={() => setRole('seeker')}>Seeker</button>
          <button className={role === 'hider' ? 'on' : ''} onClick={() => setRole('hider')}>Hider</button>
        </div>

        <div className="count" title={`${alive} of ${total} hiding zones still possible`}>
          <strong>{alive}</strong>
          <span className="muted">/{total}</span>
        </div>

        <GameButtons tab={tab} onTab={onTab} gameCode={props.gameCode} chatBadge={props.chatBadge} />
      </div>

      <div className="seg wide topbar-tabs">
        <button className={tab === 'play' ? 'on' : ''} onClick={() => onTab('play')}>Play</button>
        <button className={tab === 'layers' ? 'on' : ''} onClick={() => onTab('layers')}>Map</button>
        <button className={tab === 'results' ? 'on' : ''} onClick={() => onTab('results')}>Results</button>
        <button className={tab === 'help' ? 'on' : ''} onClick={() => onTab('help')} title="Diagnostics and bug reports">?</button>
      </div>

      <LocationLine loc={loc} onTab={onTab} />
      <EntitlementLine />
    </header>
  );
}

/**
 * The game room's button and, once in one, its chat. Showing the code doubles
 * as the reminder that this phone is in a game — and so, when seeking,
 * sharing its position.
 */
function GameButtons(props: {
  tab: Tab;
  onTab: (t: Tab) => void;
  gameCode: string | null;
  chatBadge: { unread: number; owed: number };
}) {
  return (
    <>
      <button
        className={`gpstoggle gamebtn ${props.tab === 'game' ? 'on' : ''}`}
        onClick={() => props.onTab(props.tab === 'game' ? 'play' : 'game')}
        aria-pressed={props.tab === 'game'}
        title={props.gameCode ? `In game ${props.gameCode}` : 'Create or join a game to share seeker locations'}
      >
        {props.gameCode ?? 'Game'}
      </button>

      {props.gameCode && (
        // A question owed is louder than a message unread: it has a clock on it.
        <button
          className={`gpstoggle chatbtn ${props.tab === 'chat' ? 'on' : ''} ${props.chatBadge.owed ? 'owed' : ''}`}
          onClick={() => props.onTab(props.tab === 'chat' ? 'play' : 'chat')}
          aria-pressed={props.tab === 'chat'}
          title="Questions and chat with everyone in this game"
        >
          Chat
          {(props.chatBadge.owed || props.chatBadge.unread) > 0 && (
            <span className="badge" aria-label={props.chatBadge.owed ? `${props.chatBadge.owed} to answer` : `${props.chatBadge.unread} unread`}>
              {props.chatBadge.owed || props.chatBadge.unread}
            </span>
          )}
        </button>
      )}
    </>
  );
}

/** Reads the same cache App.tsx's paywall check writes — no RPC of its own. */
function EntitlementLine() {
  const [entitlement, setEntitlement] = useState<CachedEntitlement | null>(null);

  useEffect(() => {
    const read = () => getCachedEntitlement().then(setEntitlement);
    read();
    // A new check (joining a room, starting its clock, signing in) shows at
    // once; the poll is for the time left, which only the clock changes.
    window.addEventListener(ENTITLEMENT_EVENT, read);
    const id = window.setInterval(read, 60_000);
    return () => { window.clearInterval(id); window.removeEventListener(ENTITLEMENT_EVENT, read); };
  }, []);

  if (!entitlement?.eligible) return null;
  if (entitlement.product === 'developer') return <div className="muted small">Developer access</div>;
  if (!entitlement.expiresAt) {
    return isProduct(entitlement.product) ? <div className="muted small">Game room ready — its clock starts at the first round</div> : null;
  }

  const remainingMs = new Date(entitlement.expiresAt).getTime() - Date.now();
  if (remainingMs <= 0) return null;

  return (
    <div className="muted small">
      {formatTimeLeft(remainingMs)} left {isProduct(entitlement.product) ? 'in your game room' : "on this device's pass"}
    </div>
  );
}

/**
 * GPS readout on the left, manual-location switch on the right.
 *
 * Switching to manual stops the GPS watch outright rather than just ignoring
 * it. A bad fix in an urban canyon is worse than no fix — it silently anchors
 * radar and thermometer answers to the wrong place — and the watch is a real
 * battery cost across a day-long game.
 */
function LocationLine(props: {
  loc: LocationState;
  onTab: (t: Tab) => void;
}) {
  const { loc } = props;
  const ageSeconds = useFixAge(loc.fix);
  const units = useGame((s) => s.settings.units);
  const manual = useGame((s) => s.manualLocation);
  const setManualEnabled = useGame((s) => s.setManualEnabled);
  const role = useGame((s) => s.role);
  const placeTarget = useGame((s) => s.hiderPlaceTarget);
  const placingSeekers = role === 'hider' && placeTarget === 'seekers';

  return (
    <>
      <div className="gpsrow">
        <div className={`gps grow ${tone(loc, ageSeconds, manual.enabled)}`}>
          {manual.enabled ? (
            manual.coords
              ? <>Manual · {manual.coords[1].toFixed(4)}, {manual.coords[0].toFixed(4)}</>
              : <>Manual · no point set yet</>
          ) : loc.status === 'denied' || loc.status === 'unavailable' ? (
            <>
              {loc.error} <button className="link" onClick={loc.start}>Retry</button>
              <button className="link" onClick={() => props.onTab('help')}>Why?</button>
            </>
          ) : !loc.fix ? (
            <>Acquiring location… <button className="link" onClick={loc.start}>Retry</button></>
          ) : (
            <>
              GPS ±{formatDistance(loc.fix.accuracyM, units)} ({describeAccuracy(loc.fix.accuracyM)})
              {isStale(ageSeconds) && <> · fix is {ageSeconds}s old</>}
            </>
          )}
        </div>

        <button
          className={`gpstoggle ${manual.enabled ? 'on' : ''}`}
          onClick={() => setManualEnabled(!manual.enabled, loc.fix?.coords)}
          aria-pressed={manual.enabled}
          title={manual.enabled ? 'Switch back to GPS' : 'Set your position by hand and stop using GPS'}
        >
          {manual.enabled ? 'Manual' : 'GPS'}
        </button>

      </div>

      {manual.enabled && (
        <div className="manualhint">
          {placingSeekers ? 'Tap and hold for seeker point' : 'Tap and hold for manual point'}
        </div>
      )}
    </>
  );
}

function tone(loc: LocationState, age: number | null, manual: boolean): string {
  if (manual) return 'manual';
  if (loc.status === 'denied' || loc.status === 'unavailable') return 'bad';
  if (loc.fix && isStale(age)) return 'warn';
  return '';
}
