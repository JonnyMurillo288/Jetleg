import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeatureCollection, Polygon } from 'geojson';
import { loadGameData, type GameData } from '../data/load';
import { MapView } from '../map/MapView';
import { enterBoard } from '../engine/reset';
import type { LngLat } from '../engine/types';
import { requestPersistence, useActiveRound, useGame } from '../store/game';
import { useAccount } from '../community/account';
import { loadActiveMap, saveActiveMap, type ActiveMap } from '../community/active';
import { CITY, applyMap, checkMap } from '../community/board';
import { mapFromBoard, type MapFile } from '../community/format';
import { newPack, packFromBoard } from '../community/pack';
import { CommunityPanel, type NewMapKind } from '../ui/CommunityPanel';
import { Editor, editorTap, newEditor, type EditorState, type EditorTarget } from './Editor';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const ALL_LAYERS_ON = { outOfPlay: true, zoneBuffers: true, stationDots: true };

/**
 * The map studio — its own page (`#/maps`), apart from the game.
 *
 * The game is for playing a board; this is for looking at boards, choosing
 * one, and making new ones. It has no round, no location and no questions:
 * the map here always shows the *board itself* — the one being edited, the
 * one whose page is open, or the one currently in play.
 *
 * Whatever is on the map is a real board built by the same `applyMap` the
 * game uses, so a map looks here exactly as it will when played.
 */
export function StudioApp() {
  const [base, setBase] = useState<GameData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveMap | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<MapFile | null>(null);
  const [lookAt, setLookAt] = useState<{ bbox: [number, number, number, number] } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const account = useAccount();
  const round = useActiveRound();
  const roundActive = !!round && !round.endedAt;
  const settings = useGame((s) => s.settings);
  const updateSettings = useGame((s) => s.updateSettings);

  useEffect(() => {
    Promise.all([loadGameData(), loadActiveMap().catch(() => null)])
      .then(([loaded, stored]) => { setBase(loaded); setActive(stored); })
      .catch((e) => setLoadError(String(e)));
    requestPersistence();
  }, []);

  // What the map shows: the draft, else the map whose page is open, else the board in play.
  const shown: MapFile | null = editor?.draft ?? preview ?? active?.map ?? null;
  const shownPack = shown?.kind === 'pack' ? shown : null;
  const data = useMemo(() => {
    if (!base) return null;
    // A station map for some other city cannot be drawn on this board.
    const playable = shown && !(shown.kind === 'stations' && shown.city !== CITY);
    const board = playable ? applyMap(base, shown) : base;
    enterBoard(board.bbox);
    return board;
    // Only what is drawn: typing a name must not rebuild every zone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, shown?.kind, shown?.stations, shownPack?.boundary, shownPack?.layers, shownPack?.voronoi]);

  const aliveIds = useMemo(() => new Set((data?.stations ?? []).map((s) => s.id)), [data]);

  const visibleLayers = useMemo(() => {
    const key = editor?.layerKey;
    if (!key || (editor.tab !== 'layers' && editor.tab !== 'voronoi')) return [];
    return editor.showCells ? [key, `${key}:voronoi`] : [key];
  }, [editor?.layerKey, editor?.showCells, editor?.tab]);

  /** A boundary being drawn, in the measuring tool's own draft style. */
  const drawingFc = useMemo<FeatureCollection>(() => {
    const pts = editor?.drawing;
    if (!pts?.length) return EMPTY;
    const features: FeatureCollection['features'] = pts.map((p) => ({
      type: 'Feature', properties: { kind: 'vertex', draft: true }, geometry: { type: 'Point', coordinates: p },
    }));
    if (pts.length > 1) {
      features.push({
        type: 'Feature',
        properties: { kind: 'segment', draft: true },
        geometry: { type: 'LineString', coordinates: pts.length > 2 ? [...pts, pts[0]] : pts },
      });
    }
    return { type: 'FeatureCollection', features };
  }, [editor?.drawing]);

  /** The hollow ring marks the spot being added, or the thing selected. */
  const marker = useMemo<LngLat | null>(() => {
    if (!editor) return null;
    if (editor.pending) return editor.pending;
    const sel = editor.selected;
    if (sel?.type === 'station') {
      const s = editor.draft.stations.find((x) => x.id === sel.id);
      return s ? [s.lon, s.lat] : null;
    }
    if (sel?.type === 'poi' && editor.draft.kind === 'pack') {
      const f = editor.draft.layers[sel.key]?.find((x) => x.properties.id === sel.id);
      return f?.geometry.type === 'Point' ? (f.geometry.coordinates as LngLat) : null;
    }
    return null;
  }, [editor]);

  const edit = useCallback((draft: MapFile, target: EditorTarget) => {
    setPreview(null);
    setEditor(newEditor(draft, target));
  }, []);

  const startNew = (kind: NewMapKind) => {
    if (!base) return;
    const rules = { gameSize: settings.gameSize };
    if (kind === 'stations') {
      edit(mapFromBoard(base.stations, { ...rules, supervisorDistrictsAsAdmin4: settings.supervisorDistrictsAsAdmin4 }, '', CITY), { type: 'new' });
    } else if (kind === 'sf-pack') {
      edit(packFromBoard(base, 'San Francisco', CITY, rules), { type: 'new' });
    } else {
      // A new city needs somewhere to start. Whatever the map is looking at
      // becomes a first, rectangular boundary; the Boundary tab replaces it.
      const view = (window as any).__map?.getBounds?.();
      const [w, s, e, n]: number[] = view ? [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()] : base.bbox;
      const inset = (a: number, b: number) => [a + (b - a) * 0.1, b - (b - a) * 0.1];
      const [x0, x1] = inset(w, e);
      const [y0, y1] = inset(s, n);
      const rectangle: Polygon = { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
      const next = newEditor(newPack('', '', rectangle, rules), { type: 'new' });
      setPreview(null);
      setEditor({ ...next, tab: 'boundary' });
    }
  };

  /** Choose a board and go and play on it. */
  const play = async (next: ActiveMap): Promise<string | null> => {
    if (!base) return 'The board is still loading.';
    if (roundActive) return 'You have a round in progress. End it before changing boards.';
    const blocker = checkMap(next.map, base.boundary).find((p) => p.blocking);
    if (blocker) return blocker.text;
    await saveActiveMap(next);
    // A map's house rules are applied once, when it is chosen; the player
    // can still change them on the game's Map tab afterwards.
    updateSettings(next.map.rules);
    window.location.hash = '';
    return null;
  };

  const builtIn = async () => {
    if (roundActive) return;
    await saveActiveMap(null);
    setActive(null);
  };

  if (loadError) return <div className="fatal"><h1>Could not load the map studio</h1><p>{loadError}</p></div>;
  if (!base || !data) return <div className="fatal"><h1>Loading the map studio…</h1></div>;

  return (
    <div className={`app studio ${collapsed ? 'collapsed' : ''}`}>
      <header className="topbar">
        <div className="topbar-row">
          <a className="buttonlink" href="#">← Game</a>
          <strong className="grow studiotitle">Map studio</strong>
          <span className="muted small">
            {account.state === 'signedIn' ? account.displayName ?? account.email : account.state === 'guest' ? 'Not signed in' : ''}
          </span>
        </div>
      </header>

      <MapView
        data={data}
        aliveIds={aliveIds}
        resolved={[]}
        hiddenOverlays={[]}
        visibleLayers={visibleLayers}
        outOfPlay={null}
        mapLayers={ALL_LAYERS_ON}
        fix={null}
        manualPoint={marker}
        pins={{}}
        measureFc={drawingFc}
        planFc={EMPTY}
        peersFc={EMPTY}
        lookAt={lookAt}
        onMapClick={(ll) => editor && setEditor(editorTap(editor, ll))}
        onStationClick={(id, ll) => editor && setEditor(editorTap(editor, ll, { type: 'station', id }))}
        onPoiClick={editor ? (key, id, ll) => setEditor(editorTap(editor, ll, { type: 'poi', key, id })) : undefined}
      />

      <div className="sheet">
        <button className="sheet-handle" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand panel' : 'Collapse panel for a bigger map'}>
          <span className="grip" />
          <span className="sheet-handle-label">{collapsed ? 'Tap to open' : 'Hide panel'}</span>
        </button>

        {editor ? (
          <Editor
            editor={editor}
            onChange={setEditor}
            onClose={() => setEditor(null)}
            base={base}
            account={account}
            roundActive={roundActive}
            onLookAt={(bbox) => setLookAt({ bbox })}
            onPlay={async (map) => {
              const err = await play({ mapId: null, versionId: null, map });
              if (err) alert(err);
            }}
            onPublished={() => setEditor(null)}
          />
        ) : (
          <CommunityPanel
            account={account}
            active={active}
            activeStations={active ? active.map.stations.length : base.stations.length}
            roundActive={roundActive}
            onPlay={play}
            onBuiltIn={builtIn}
            onNew={startNew}
            onEdit={edit}
            onPreview={setPreview}
          />
        )}
      </div>
    </div>
  );
}
