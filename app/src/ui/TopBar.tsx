import { useGame } from '../store/game';
import { describeAccuracy, isStale, useFixAge, type LocationState } from '../location/useLocation';
import { formatDistance } from './units';

export function TopBar(props: {
  loc: LocationState;
  alive: number;
  total: number;
  tab: 'play' | 'layers' | 'help';
  onTab: (t: 'play' | 'layers' | 'help') => void;
}) {
  const { loc, alive, total, tab, onTab } = props;
  const role = useGame((s) => s.role);
  const setRole = useGame((s) => s.setRole);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="seg">
          <button className={role === 'seeker' ? 'on' : ''} onClick={() => setRole('seeker')}>Seeker</button>
          <button className={role === 'hider' ? 'on' : ''} onClick={() => setRole('hider')}>Hider</button>
        </div>

        <div className="count" title={`${alive} of ${total} hiding zones still possible`}>
          <strong>{alive}</strong>
          <span className="muted">/{total}</span>
        </div>

        <div className="seg">
          <button className={tab === 'play' ? 'on' : ''} onClick={() => onTab('play')}>Play</button>
          <button className={tab === 'layers' ? 'on' : ''} onClick={() => onTab('layers')}>Map</button>
          <button className={tab === 'help' ? 'on' : ''} onClick={() => onTab('help')} title="Diagnostics">?</button>
        </div>
      </div>

      <LocationLine loc={loc} onTab={onTab} />
    </header>
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
  onTab: (t: 'play' | 'layers' | 'help') => void;
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
