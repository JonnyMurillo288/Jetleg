import { useEffect, useMemo, useState } from 'react';
import { loadGameData, type GameData } from './data/load';
import { MapView } from './map/MapView';
import { useLocation } from './location/useLocation';
import { useGame, useActiveRound, requestPersistence, newAskId, type Round } from './store/game';
import { QUESTIONS_BY_ID } from './engine/questions';
import { evaluate } from './engine/candidates';
import { layerIndex } from './engine/spatial';
import { playArea } from './engine/regions';
import { planCandidate, type PlanCandidate } from './engine/plan';
import { metresCached } from './engine/project';
import { buildMeasureFc, buildPlanFc } from './map/overlays';
import { MapToolbar } from './ui/MapToolbar';
import type { Answer, LngLat, Question } from './engine/types';
import { SeekerPanel } from './ui/SeekerPanel';
import { HiderPanel } from './ui/HiderPanel';
import { TopBar, type Tab } from './ui/TopBar';
import { ChatPanel, type AskExtra } from './ui/ChatPanel';
import { useGameChat } from './chat/useGameChat';
import { chatGamesOf, forgetUnusedChats } from './chat/local';
import { subjectFor } from './chat/subject';
import { openQuestions, type ChatQuestion } from './chat/chat';
import { formatDistance } from './ui/units';
import { LayerPanel } from './ui/LayerPanel';
import { RoundGate } from './ui/RoundGate';
import { Diagnostics } from './ui/Diagnostics';
import { ResultsPanel } from './ui/ResultsPanel';
import { GamePanel } from './ui/GamePanel';
import { checkEntitlement, hasCachedValidEntitlement } from './payments/entitlement';
import { loadGame, type LocalGame } from './live/room';
import { useLiveLocations } from './live/useLiveLocations';
import { buildPeersFc, pickFollowed, type SharePosition } from './live/share';
import { supabase } from './sync/client';
import { applyMap, checkMap } from './community/board';
import { enterBoard } from './engine/reset';
import { loadActiveMap, sameBoard, saveActiveMap, stampOf, type ActiveMap } from './community/active';
import { getVersion } from './community/api';

export default function App() {
  // The board as shipped. `data`, below, is what is actually played on: this,
  // or a community map — the same board with other stations, or a different
  // city altogether. Maps are made and chosen in the studio (#/maps).
  const [base, setBase] = useState<GameData | null>(null);
  const [activeMap, setActiveMap] = useState<ActiveMap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('play');
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
  const roundActive = !!round && !round.endedAt;

  const data = useMemo(() => {
    if (!base) return null;
    const board = activeMap ? applyMap(base, activeMap.map) : base;
    // Here, and not in an effect: everything below this line in the same
    // render evaluates against `board`, and must do so in its projection
    // and with none of the last board's cached regions.
    enterBoard(board.bbox, board.zoneRadiusM);
    return board;
  }, [base, activeMap]);

  // Rounds are stamped with the board they start on (store/game.ts).
  useEffect(() => { setBoard(stampOf(activeMap)); }, [activeMap, setBoard]);

  const resumeInStore = useGame((s) => s.resumeRound);
  const updateSettings = useGame((s) => s.updateSettings);
  /**
   * Play a round again — one left unfinished, or one that was ended.
   *
   * A round's log names stations by id, so it must be resumed on the board
   * it was played on: that board is put back first, or, where it cannot be,
   * the round is not resumed at all and the reason is returned. Resumed on
   * any other board, every answer would be scored against the wrong stations.
   */
  const resumeRound = async (r: Round): Promise<string | null> => {
    if (!base) return 'The board is still loading.';
    const want = r.board;
    if (!sameBoard(want, stampOf(activeMap))) {
      if (!want) {
        await saveActiveMap(null);
        setActiveMap(null);
      } else if (!want.versionId) {
        return `This round was played on “${want.name}”, a map opened from a file. Open that file in the map studio, play on it, then resume the round.`;
      } else {
        const got = await getVersion(want.versionId);
        if (!got.ok) return `This round was played on “${want.name}”, which could not be loaded: ${got.error}`;
        const next: ActiveMap = { mapId: got.value.mapId, versionId: want.versionId, map: got.value.map };
        const blocker = checkMap(next.map, base.boundary).find((p) => p.blocking);
        if (blocker) return blocker.text;
        await saveActiveMap(next);
        updateSettings(next.map.rules);
        setActiveMap(next);
      }
    }
    resumeInStore(r.id);
    setTab('play');
    return null;
  };

  /** Back to the board the app ships with. Maps are chosen in the studio. */
  const useBuiltInBoard = async () => {
    if (roundActive) return;
    await saveActiveMap(null);
    setActiveMap(null);
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
  const [gameLoaded, setGameLoaded] = useState(false);
  useEffect(() => {
    loadGame().then((g) => { setGame(g); setGameLoaded(true); });
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
  /**
   * The hider's "seekers" point. In a game it is a live seeker's position;
   * otherwise, or by choice, the pin placed by hand. Derived on every
   * update rather than copied into the round, so a live position is never
   * written to storage and the pin can never lag the dot it stands for.
   */
  const seekerFollow = useGame((s) => s.seekerFollow);
  const setSeekerFollow = useGame((s) => s.setSeekerFollow);
  const followed = useMemo(
    () => (role === 'hider' ? pickFollowed(live.peers, seekerFollow) : null),
    [role, live.peers, seekerFollow],
  );
  const seekerPoint: LngLat | undefined = followed?.coords ?? round?.seekerPin;
  const peersFc = useMemo(() => buildPeersFc(live.peers, followed?.id), [live.peers, followed?.id]);

  // ---- the game chat (src/chat): questions with a clock, and free chat.
  const chat = useGameChat(game, role, tab === 'chat');
  const addAsk = useGame((s) => s.addAsk);
  const addChatAsk = useGame((s) => s.addChatAsk);
  const applyChatAnswer = useGame((s) => s.applyChatAnswer);
  const playing = !!round && !round.endedAt && round.role === role;

  /**
   * A seeker asks in the chat. Only the question goes to the server; where
   * they stood stays in the round on this phone, waiting for the answer.
   */
  const askInChat = async (q: Question, extra?: AskExtra): Promise<string | null> => {
    if (!game) return 'Join a game first.';
    if (role !== 'seeker' || !playing) return 'Start a seeking round first.';
    const from = extra?.origin ?? origin;
    if (!from) return 'No position yet. Turn on location, or switch to Manual and tap-and-hold the map.';
    const text = q.id === 'radar-choose' && extra?.distanceM
      ? `Are you within ${formatDistance(extra.distanceM, settings.units)} of me?`
      : q.text;
    const res = await chat.ask(q, text, extra?.distanceM, data ? subjectFor(q, from, data) : null);
    if (!res.ok) return res.error;
    addChatAsk(res.value.id, {
      questionId: q.id,
      askedAt: Date.now(),
      origin: from,
      destination: extra?.destination,
      distanceM: extra?.distanceM,
    });
    if (q.category === 'thermometer') setPins({});
    return null;
  };

  // The hider answered: log it into the round it was asked in. The store
  // makes this idempotent, so the live delivery and the history reload can
  // both hand over the same answer.
  const chatAsks = round?.chatAsks;
  useEffect(() => {
    if (role !== 'seeker' || !chatAsks) return;
    for (const q of chat.questions) if (q.answer && chatAsks[q.id]) applyChatAnswer(q.id, q.answer);
  }, [chat.questions, chatAsks, role, applyChatAnswer]);

  /**
   * The hider answered in the chat: record it in their exposure log too,
   * measured from the seeker who asked — their live dot, else the pin.
   */
  const logHiderAnswer = (cq: ChatQuestion, answer: Answer): string | null => {
    const q = QUESTIONS_BY_ID[cq.questionId];
    if (!q || !round || round.endedAt || role !== 'hider') return null;
    if (round.asks.some((a) => a.chatId === cq.id)) return null;
    const asker = live.peers.find((p) => p.id === cq.askedBy)?.coords ?? seekerPoint;
    const thermo = q.category === 'thermometer' && hiderThermo.start && hiderThermo.end;
    // A photo or a null has no geometry; any point will do, and it never leaves this phone.
    const from = thermo ? hiderThermo.start : asker ?? (answer.kind === 'photo' || answer.kind === 'null' ? origin ?? undefined : undefined);
    if (!from) {
      return q.category === 'thermometer'
        ? 'Sent. Not in your exposure log: place the seekers’ start and end on the Play tab’s Thermometer to track it.'
        : 'Sent. Not in your exposure log: there was no seeker position to measure it from.';
    }
    addAsk({
      id: newAskId(),
      questionId: q.id,
      askedAt: cq.askedAt,
      origin: from,
      destination: thermo ? hiderThermo.end : undefined,
      distanceM: cq.distanceM ?? undefined,
      answer,
      chatId: cq.id,
    });
    return null;
  };
  const owed = role === 'hider' ? openQuestions(chat.questions).length : 0;

  /**
   * The chat is game data, kept on this phone only (chat/local.ts). A round
   * played while in a game names that game, so its chat goes with the round
   * into the game file — and is deleted, photos and all, once no round on
   * this phone names the game and the phone has left it.
   */
  const addChatGame = useGame((s) => s.addChatGame);
  const rounds = useGame((s) => s.rounds);
  useEffect(() => {
    if (game && playing && !round?.chatGames?.includes(game.gameId)) addChatGame(game.gameId);
  }, [game?.gameId, playing, round?.chatGames, addChatGame]);
  // Rounds load from storage after the first render. Until they have, and
  // until the game this phone is in has, "no round names it" is not yet true.
  const [roundsLoaded, setRoundsLoaded] = useState(() => useGame.persist.hasHydrated());
  useEffect(() => useGame.persist.onFinishHydration(() => setRoundsLoaded(true)), []);
  const keptChats = [...chatGamesOf(rounds), ...(game ? [game.gameId] : [])].sort().join(',');
  useEffect(() => {
    if (!roundsLoaded || !gameLoaded) return;
    forgetUnusedChats(new Set(keptChats ? keptChats.split(',') : [])).catch(() => {});
  }, [roundsLoaded, gameLoaded, keptChats]);

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
      // The hash is the page (route.ts): dropping it here would send a reload to the landing page.
      window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
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
    <div className={`app ${sheetCollapsed ? 'collapsed' : ''} ${tab === 'chat' ? 'chat-open' : ''}`}>
      <TopBar
        loc={loc}
        alive={evaluated.alive.length}
        total={data.stations.length}
        tab={tab}
        onTab={setTab}
        gameCode={game?.joinCode ?? null}
        chatBadge={{ unread: chat.unread, owed }}
      />

      <MapView
        data={data}
        aliveIds={aliveIds}
        zoneCuts={evaluated.cuts}
        resolved={evaluated.resolved}
        hiddenOverlays={hiddenOverlays}
        visibleLayers={visibleLayers}
        outOfPlay={outOfPlay}
        mapLayers={mapLayers}
        fix={manual.enabled ? null : loc.fix}
        manualPoint={manual.enabled ? manual.coords ?? null : null}
        pins={
          role === 'hider'
            // While a live seeker is followed, their own dot is the pin.
            ? { seekers: followed ? undefined : round?.seekerPin, start: hiderThermo.start, end: hiderThermo.end }
            : pins
        }
        // Only a hider's own claim is drawn. A seeker can record where the hider
        // was once a round is over, and resuming that round must not then
        // show the answer on their map.
        hiderStation={role === 'hider' ? hiderStation : null}
        measureFc={measureFc}
        planFc={planFc}
        peersFc={peersFc}
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
          // While the seekers' point follows a live seeker, a stray tap must
          // not quietly replace it with a hand-placed pin.
          if (followed && !armSeekerPin) return;
          if (armSeekerPin || !manual.enabled) setSeekerPin(ll);
        }}
        onLongPress={(ll) => {
          if (!manual.enabled) return;
          if (role === 'hider' && hiderPlaceTarget === 'seekers') {
            if (round && !round.endedAt && !followed) setSeekerPin(ll);
          } else {
            setManualCoords(ll);
          }
        }}
      />

      <MapToolbar
        data={data}
        alive={evaluated.alive}
        total={data.stations.length}
        canMeasure={roundActive}
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
          <Diagnostics boardName={activeMap?.map.name ?? null} />
        ) : tab === 'layers' ? (
          <LayerPanel
            data={data}
            boardName={activeMap?.map.name ?? null}
            onBuiltIn={activeMap && !roundActive ? useBuiltInBoard : null}
          />
        ) : tab === 'results' ? (
          <ResultsPanel data={data} onResume={resumeRound} canResume={entitled === true && !roundActive} roundActive={roundActive} />
        ) : tab === 'chat' ? (
          <ChatPanel
            game={game}
            chat={chat}
            role={role}
            playing={playing}
            data={data}
            origin={origin}
            seekerPoint={seekerPoint ?? null}
            seekerDots={live.peers}
            pins={pins}
            onAsk={askInChat}
            onAnswered={logHiderAnswer}
            onOpenGame={() => setTab('game')}
          />
        ) : tab === 'game' ? (
          <GamePanel
            game={game}
            onGame={setGame}
            peers={live.peers}
            status={live.status}
            hasPosition={!!origin}
          />
        ) : !round || round.endedAt ? (
          <RoundGate canStart={entitled === true} onRestored={refreshEntitlement} onResume={resumeRound} />
        ) : role === 'seeker' ? (
          <SeekerPanel
            data={data}
            round={round}
            evaluated={evaluated}
            origin={origin}
            pins={pins}
            setPins={setPins}
            planCandidates={planCandidates}
            builtInGround={!activeMap || activeMap.map.kind === 'stations'}
            chat={game ? { questions: chat.questions, photos: chat.photos, onAsk: askInChat } : undefined}
          />
        ) : (
          <HiderPanel
            data={data}
            round={round}
            origin={origin}
            hiderStation={hiderStation}
            evaluated={evaluated}
            seekerPoint={seekerPoint ?? null}
            liveSeekers={live.peers}
            followed={followed}
            follow={seekerFollow}
            onFollow={setSeekerFollow}
          />
        )}
      </div>
    </div>
  );
}
