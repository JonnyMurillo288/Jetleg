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
import { GamePanel } from './ui/GamePanel';
import { checkEntitlement, hasCachedValidEntitlement } from './payments/entitlement';
import { loadGame, type LocalGame } from './live/room';
import { useLiveLocations } from './live/useLiveLocations';
import { buildPeersFc, type SharePosition } from './live/share';
import { supabase } from './sync/client';
import { CommunityPanel } from './ui/CommunityPanel';
import { editorTap, type EditorState } from './ui/MapEditor';
import { applyMap, checkMap } from './community/board';
import { loadActiveMap, saveActiveMap, stampOf, type ActiveMap } from './community/active';

export default function App() {
  // The board as shipped. `data`, below, is what is actually played on: this,
  // or this with a community map's stations swapped in.
  const [base, setBase] = useState<GameData | null>(null);
  const [activeMap, setActiveMap] = useState<ActiveMap | null>(null);
  /** An open map editor. Its draft is the board for as long as it is open. */
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<'play' | 'layers' | 'results' | 'game' | 'community' | 'help'>('play');
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
  const setBoard = useGame((s) => s.setBoard);
  const updateSettings = useGame((s) => s.updateSettings);
  const roundActive = !!round && !round.endedAt;

  /**
   * Only the station list decides the board, so only it is a dependency:
   * typing a draft's name must not rebuild 192 zones per keystroke.
   */
  const boardStations = (editor?.draft ?? activeMap?.map)?.stations;
  const data = useMemo(() => {
    if (!base) return null;
    const map = editor?.draft ?? activeMap?.map;
    return map ? applyMap(base, map) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, boardStations]);

  // Rounds are stamped with the board they start on (store/game.ts).
  useEffect(() => { setBoard(stampOf(activeMap)); }, [activeMap, setBoard]);

  /** Choose a board. Returns why not, when it cannot be chosen. */
  const activate = async (next: ActiveMap | null): Promise<string | null> => {
    if (!base) return 'The board is still loading.';
    if (roundActive) return 'End your round before changing boards.';
    if (next) {
      const blocker = checkMap(next.map, base.boundary).find((p) => p.blocking);
      if (blocker) return blocker.text;
    }
    await saveActiveMap(next);
    setActiveMap(next);
    // A map's house rules are applied once, when it is chosen; the player
    // can still change them on the Map tab afterwards.
    if (next) updateSettings(next.map.rules);
    return null;
  };

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
    Promise.all([loadGameData(), loadActiveMap().catch(() => null)])
      .then(([loaded, stored]) => {
        setBase(loaded);
        // A stored map that no longer fits this board (a boundary change in
        // a later build) is dropped rather than drawn wrong.
        if (stored && !checkMap(stored.map, loaded.boundary).some((p) => p.blocking)) setActiveMap(stored);
      })
      .catch((e) => setLoadError(String(e)));
    requestPersistence();
  }, []);

  // The game room this device is in, if any. Membership only — which game,
  // which team — restored from IndexedDB so a reload stays in the game.
  const [game, setGame] = useState<LocalGame | null>(null);
  useEffect(() => {
    loadGame().then(setGame);
  }, []);

  /**
   * What this device would share with its game: the same `origin` every
   * panel anchors on, so the dot the others see is the position this
   * player's own questions are being asked from. Only ever sent while
   * seeking — see live/share.ts.
   */
  const sharePosition = useMemo<SharePosition | null>(
    () =>
      origin
        ? { coords: origin, accuracyM: manual.enabled ? undefined : loc.fix?.accuracyM, manual: manual.enabled }
        : null,
    [origin?.[0], origin?.[1], manual.enabled, loc.fix?.accuracyM],
  );
  // A hider's position is not handed to the live module at all.
  const live = useLiveLocations(game, role, role === 'seeker' ? sharePosition : null);
  const peersFc = useMemo(() => buildPeersFc(live.peers), [live.peers]);

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

    // Who is signed in changes what they are entitled to: a developer's
    // sign-in unlocks play on the spot, and signing out gives it back. The
    // check is deferred a tick — supabase-js must not be called from inside
    // its own auth callback.
    const sub = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') setEntitled(false);
      else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') window.setTimeout(refreshEntitlement, 0);
    });
    return () => { cancelled = true; sub?.data.subscription.unsubscribe(); };
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

  // The editor owns the panel while it is open, whichever tab was showing.
  const shownTab = editor ? 'community' : tab;
  const editorSelected = editor?.selectedId ? editor.draft.stations.find((s) => s.id === editor.selectedId) : undefined;
  const editorPoint: LngLat | null = editor
    ? editor.pending ?? (editorSelected ? [editorSelected.lon, editorSelected.lat] : null)
    : null;

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
        tab={shownTab}
        onTab={(t) => { if (!editor) setTab(t); }}
        gameCode={game?.joinCode ?? null}
      />

      <MapView
        data={data}
        aliveIds={aliveIds}
        resolved={evaluated.resolved}
        hiddenOverlays={hiddenOverlays}
        visibleLayers={visibleLayers}
        outOfPlay={outOfPlay}
        mapLayers={mapLayers}
        // While a map is being edited the hollow ring marks the spot being
        // added, or the station selected — the player's own dot would only
        // be in the way.
        fix={editor || manual.enabled ? null : loc.fix}
        manualPoint={editor ? editorPoint : manual.enabled ? manual.coords ?? null : null}
        pins={
          role === 'hider'
            ? { seekers: round?.seekerPin, start: hiderThermo.start, end: hiderThermo.end }
            : pins
        }
        hiderStation={hiderStation}
        measureFc={measureFc}
        planFc={planFc}
        peersFc={peersFc}
        // Armed placement wins over claiming a station — otherwise the station
        // hit targets swallow the tap and the pin can never be placed.
        onStationClick={(id, ll) => {
          if (editor) { setEditor(editorTap(editor, ll, id)); return; }
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
          if (editor) { setEditor(editorTap(editor, ll)); return; }
          if (measure.tool !== 'off') { measureTap(ll); return; }
          if (role !== 'hider' || !round || round.endedAt) return;
          if (hiderThermo.arm !== 'none') { placeHiderThermo(ll); return; }
          if (armSeekerPin || !manual.enabled) setSeekerPin(ll);
        }}
        onLongPress={(ll) => {
          if (editor || !manual.enabled) return;
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
        canMeasure={roundActive && !editor}
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

        {shownTab === 'community' ? (
          <CommunityPanel
            base={base!}
            stations={data.stations}
            active={activeMap}
            onActivate={activate}
            editor={editor}
            setEditor={setEditor}
            roundActive={roundActive}
          />
        ) : tab === 'help' ? (
          <Diagnostics />
        ) : tab === 'layers' ? (
          <LayerPanel data={data} boardName={activeMap?.map.name ?? null} onCommunity={() => setTab('community')} />
        ) : tab === 'results' ? (
          <ResultsPanel data={data} />
        ) : tab === 'game' ? (
          <GamePanel
            game={game}
            onGame={setGame}
            peers={live.peers}
            status={live.status}
            hasPosition={!!origin}
          />
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
