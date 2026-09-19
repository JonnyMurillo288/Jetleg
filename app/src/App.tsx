import { useEffect, useMemo, useState } from 'react';
import { loadGameData, type GameData } from './data/load';
import { MapView } from './map/MapView';
import { useLocation } from './location/useLocation';
import { useGame, useActiveRound, requestPersistence } from './store/game';
import { QUESTIONS_BY_ID } from './engine/questions';
import { evaluate } from './engine/candidates';
import { layerIndex } from './engine/spatial';
import { playArea } from './engine/regions';
import { planCandidate, type PlanCandidate } from './engine/plan';
import { metresCached } from './engine/project';
import { buildMeasureFc, buildPlanFc } from './map/overlays';
import { MapToolbar } from './ui/MapToolbar';
import type { LngLat } from './engine/types';
import { SeekerPanel } from './ui/SeekerPanel';
import { HiderPanel } from './ui/HiderPanel';
import { TopBar } from './ui/TopBar';
import { LayerPanel } from './ui/LayerPanel';
import { RoundGate } from './ui/RoundGate';
import { Diagnostics } from './ui/Diagnostics';
import { ResultsPanel } from './ui/ResultsPanel';
import { checkEntitlement, hasCachedValidEntitlement } from './payments/entitlement';

export default function App() {
  const [data, setData] = useState<GameData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<'play' | 'layers' | 'results' | 'help'>('play');
  const [pins, setPins] = useState<{ start?: LngLat; end?: LngLat }>({});

  const role = useGame((s) => s.role);
  const settings = useGame((s) => s.settings);
  const visibleLayers = useGame((s) => s.visibleLayers);
  const hiddenOverlays = useGame((s) => s.hiddenOverlays);
  const mapLayers = useGame((s) => s.mapLayers);
  const sheetCollapsed = useGame((s) => s.sheetCollapsed);
  const setSheetCollapsed = useGame((s) => s.setSheetCollapsed);
  const setHiderStation = useGame((s) => s.setHiderStation);
  const setSeekerPin = useGame((s) => s.setSeekerPin);
  const manual = useGame((s) => s.manualLocation);
  const setManualCoords = useGame((s) => s.setManualCoords);
  const hiderPlaceTarget = useGame((s) => s.hiderPlaceTarget);
  const armSeekerPin = useGame((s) => s.armSeekerPin);
  const measure = useGame((s) => s.measure);
  const measureTap = useGame((s) => s.measureTap);
  const hiderThermo = useGame((s) => s.hiderThermo);
  const placeHiderThermo = useGame((s) => s.placeHiderThermo);
  const plan = useGame((s) => s.plan);
  const planOnMap = useGame((s) => s.planOnMap);
  const round = useActiveRound();

  // Manual mode stops the watch outright rather than ignoring it.
  const loc = useLocation(!manual.enabled);

  /**
   * The position every panel and question anchors on. One decision, made here,
   * so a manual point and a GPS fix can never disagree between panels.
   */
  const origin: LngLat | null = manual.enabled
    ? manual.coords ?? null
    : loc.fix?.coords ?? null;

  useEffect(() => {
    loadGameData().then(setData).catch((e) => setLoadError(String(e)));
    requestPersistence();
  }, []);

  // null = not checked yet, so the paywall never flashes before the (fast,
  // local) cache read resolves.
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const refreshEntitlement = () => checkEntitlement().then((r) => setEntitled((was) => r.eligible || was === true));

  useEffect(() => {
    // Strip Checkout's own return param (?checkout=success|cancel) so a
    // reload doesn't re-trigger anything; the entitlement refresh below is
    // unconditional either way, since success/cancel both just mean "go
    // check the real state."
    const params = new URLSearchParams(window.location.search);
    if (params.has('checkout')) {
      params.delete('checkout');
      const rest = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    }

    let cancelled = false;
    (async () => {
      // Cached state first, so an already-activated device isn't stuck on
      // "checking" while offline. checkEntitlement() below can only raise
      // this to true (a stale "was eligible" cache never wins over a live
      // "no" from the server that actually reached it) — see
      // refreshEntitlement's `r.eligible || was === true`, which folds a
      // reachable-but-negative check together with an unreachable one the
      // same way.
      const cachedOk = await hasCachedValidEntitlement();
      if (!cancelled) setEntitled(cachedOk);
      if (!cancelled) refreshEntitlement();
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Project every layer once, while the map is still settling.
   *
   * Building these on demand put the whole cost on whichever category the
   * player opened first — a visible hitch on a phone, and much worse before the
   * index existed at all. Doing it during idle time means the first tap on
   * Matching or Measuring is instant.
   */
  useEffect(() => {
    if (!data) return;
    const warm = () => { for (const layer of Object.values(data.layers)) layerIndex(layer); };
    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void) => number);
    const id = ric ? ric(warm) : window.setTimeout(warm, 300);
    return () => {
      const cic = (window as any).cancelIdleCallback as undefined | ((h: number) => void);
      if (ric && cic) cic(id); else clearTimeout(id);
    };
  }, [data]);

  // The ask log is the source of truth: candidates are always recomputed from
  // it, so undo and edit can never leave the map out of sync.
  const evaluated = useMemo(() => {
    if (!data) return null;
    return evaluate(
      data.stations,
      round?.asks ?? [],
      QUESTIONS_BY_ID,
      data.layers,
      data.boundary,
      settings.strictness,
    );
  }, [data, round?.asks, settings.strictness]);

  const aliveIds = useMemo(
    () => new Set((evaluated?.alive ?? data?.stations ?? []).map((s) => s.id)),
    [evaluated, data],
  );

  /**
   * The ruled-out area, as one polygon. Derived from the same resolved answers
   * the elimination engine uses, so the shading can never disagree with the
   * zone count.
   */
  const outOfPlay = useMemo(() => {
    if (!data || !evaluated) return null;
    const active = evaluated.resolved.filter((r) => !hiddenOverlays.includes(r.entry.id));
    return playArea(data.boundary, active).outOfPlay;
  }, [data, evaluated, hiddenOverlays]);

  /**
   * Where the plan's candidate regions are anchored.
   *
   * Not the live fix. A measuring candidate is a union of disks around every
   * park on the board, and rebuilding three of those on every GPS tick is the
   * same mistake that once froze the question list for 74 seconds. The anchor
   * only moves when the player has actually moved a block.
   */
  const [planAnchor, setPlanAnchor] = useState<LngLat | null>(null);
  useEffect(() => {
    if (!origin) { setPlanAnchor((a) => (a ? null : a)); return; }
    setPlanAnchor((a) => (!a || metresCached(a, origin) > 50 ? origin : a));
  }, [origin?.[0], origin?.[1]]);

  /**
   * The shortlist, evaluated. Computed in an effect rather than a memo so the
   * geometry never runs inside a render — the panel opens immediately and the
   * regions arrive a frame later.
   */
  const [planCandidates, setPlanCandidates] = useState<PlanCandidate[]>([]);
  const alive = evaluated?.alive;
  useEffect(() => {
    const questions = plan.map((id) => QUESTIONS_BY_ID[id]).filter(Boolean);
    if (!data || !questions.length) { setPlanCandidates([]); return; }
    let cancelled = false;
    const run = () => {
      const out = questions.map((q) =>
        planCandidate(q, planAnchor, alive ?? [], data.layers, data.boundary),
      );
      if (!cancelled) setPlanCandidates(out);
    };
    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void) => number);
    const id = ric ? ric(run) : window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      const cic = (window as any).cancelIdleCallback as undefined | ((h: number) => void);
      if (ric && cic) cic(id); else clearTimeout(id as number);
    };
  }, [data, plan.join(','), planAnchor?.join(','), alive]);

  // Both drawings are built here, where the unit setting lives, and handed to
  // the map as finished GeoJSON.
  // The hider's thermometer run rides along with the measuring tool's drawing,
  // so the seekers' travel is labelled with its length in the same hand.
  const thermoPath = useMemo(
    () =>
      role === 'hider' && hiderThermo.start && hiderThermo.end
        ? [hiderThermo.start, hiderThermo.end]
        : undefined,
    [role, hiderThermo.start, hiderThermo.end],
  );
  const measureFc = useMemo(
    () => buildMeasureFc(measure, settings.units, thermoPath),
    [measure, settings.units, thermoPath],
  );
  const planFc = useMemo(
    () => buildPlanFc(planCandidates, planOnMap),
    [planCandidates, planOnMap],
  );

  const hiderStation = useMemo(
    () => data?.stations.find((s) => s.id === round?.hiderStationId) ?? null,
    [data, round?.hiderStationId],
  );

  if (loadError) {
    return (
      <div className="fatal">
        <h1>Could not load the game map</h1>
        <p>{loadError}</p>
        <p className="muted">Run the pipeline: <code>cd pipeline &amp;&amp; npm run all</code></p>
      </div>
    );
  }

  if (!data || !evaluated) {
    return <div className="fatal"><h1>Loading San Francisco…</h1></div>;
  }

  return (
    <div className={`app ${sheetCollapsed ? 'collapsed' : ''}`}>
      <TopBar
        loc={loc}
        alive={evaluated.alive.length}
        total={data.stations.length}
        tab={tab}
        onTab={setTab}
      />

      <MapView
        data={data}
        aliveIds={aliveIds}
        resolved={evaluated.resolved}
        hiddenOverlays={hiddenOverlays}
        visibleLayers={visibleLayers}
        outOfPlay={outOfPlay}
        mapLayers={mapLayers}
        fix={manual.enabled ? null : loc.fix}
        manualPoint={manual.enabled ? manual.coords ?? null : null}
        pins={
          role === 'hider'
            ? { seekers: round?.seekerPin, start: hiderThermo.start, end: hiderThermo.end }
            : pins
        }
        hiderStation={hiderStation}
        measureFc={measureFc}
        planFc={planFc}
        // Armed placement wins over claiming a station — otherwise the station
        // hit targets swallow the tap and the pin can never be placed.
        onStationClick={(id, ll) => {
          // An armed measuring tool owns every tap, including one that lands on
          // a station — otherwise a circle can never be centred on one.
          if (measure.tool !== 'off') { measureTap(ll); return; }
          if (role !== 'hider' || !round || round.endedAt) return;
          if (hiderThermo.arm !== 'none') { placeHiderThermo(ll); return; }
          if (armSeekerPin) setSeekerPin(ll);
          else setHiderStation(id);
        }}
        // Hider taps empty map to place the seekers' pin; tapping a station
        // claims it. Seekers use the panel controls instead.
        // A plain tap places the seekers' pin — but not while manual location
        // is on, where every placement goes through tap-and-hold plus the
        // panel toggle, so a stray tap cannot silently move a point.
        onMapClick={(ll) => {
          if (measure.tool !== 'off') { measureTap(ll); return; }
          if (role !== 'hider' || !round || round.endedAt) return;
          if (hiderThermo.arm !== 'none') { placeHiderThermo(ll); return; }
          if (armSeekerPin || !manual.enabled) setSeekerPin(ll);
        }}
        onLongPress={(ll) => {
          if (!manual.enabled) return;
          if (role === 'hider' && hiderPlaceTarget === 'seekers') {
            if (round && !round.endedAt) setSeekerPin(ll);
          } else {
            setManualCoords(ll);
          }
        }}
      />

      <MapToolbar
        data={data}
        alive={evaluated.alive}
        total={data.stations.length}
        canMeasure={!!round && !round.endedAt}
      />

      <div className="sheet">
        <button
          className="sheet-handle"
          onClick={() => setSheetCollapsed(!sheetCollapsed)}
          aria-label={sheetCollapsed ? 'Expand panel' : 'Collapse panel for a bigger map'}
        >
          <span className="grip" />
          <span className="sheet-handle-label">
            {sheetCollapsed ? `${evaluated.alive.length} zones left — tap to open` : 'Hide panel'}
          </span>
        </button>

        {tab === 'help' ? (
          <Diagnostics />
        ) : tab === 'layers' ? (
          <LayerPanel data={data} />
        ) : tab === 'results' ? (
          <ResultsPanel data={data} />
        ) : !round || round.endedAt ? (
          <RoundGate canStart={entitled === true} onRestored={refreshEntitlement} />
        ) : role === 'seeker' ? (
          <SeekerPanel
            data={data}
            round={round}
            evaluated={evaluated}
            origin={origin}
            pins={pins}
            setPins={setPins}
            planCandidates={planCandidates}
          />
        ) : (
          <HiderPanel
            data={data}
            round={round}
            origin={origin}
            hiderStation={hiderStation}
            evaluated={evaluated}
          />
        )}
      </div>
    </div>
  );
}
