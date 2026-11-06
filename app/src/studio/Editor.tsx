import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MultiPolygon, Polygon } from 'geojson';
import type { GameData } from '../data/load';
import { LAYER_DEFS, VORONOI_KEYS } from '../data/layers';
import type { GameSize, LngLat, Mode } from '../engine/types';
import type { Account } from '../community/account';
import { publishMap, publishVersion } from '../community/api';
import { CITY, HOME_MAP_NAME, checkMap, radiusOf } from '../community/board';
import { clashGraph, simplifyStations } from '../community/simplify';
import { combine, idsInShape } from './select';
import { ZONE_RADIUS_M } from '../engine/candidates';
import {
  MAP_FILE_SUFFIX,
  MAX_STATIONS,
  MAX_ZONE_RADIUS_M,
  MIN_ZONE_RADIUS_M,
  clampZoneRadius,
  describeDiff,
  diffStations,
  parseMapFile,
  readCells,
  readLayer,
  readMapText,
  serializeMap,
  slugId,
  type LayerFeature,
  type MapFile,
  type MapStation,
  type PackMap,
} from '../community/format';
import {
  POI_DEFS,
  fetchAllPois,
  fetchCoastline,
  fetchPois,
  fetchStations,
  fetchTransitLines,
  prefetchBoard,
  searchPlaces,
  spaceOut,
  type Place,
} from '../community/osm';
import {
  auditPack,
  boundaryStats,
  clipToBoundary,
  coastlineFromBoundary,
  finalizePack,
  finalizePackStepwise,
  largestLandmass,
  packFromBoard,
  polygonFromTaps,
  simplifyBoundary,
} from '../community/pack';
import { countryName, flagOf } from '../community/cities';
import { AccountBox } from '../ui/AccountBox';

/**
 * What the draft will become when published: a map of its own, the next
 * version of one the author already has, or a branch of someone else's.
 */
export type EditorTarget =
  | { type: 'new' }
  | { type: 'version'; mapId: string }
  | { type: 'branch'; parentVersionId: string; parentName: string };

export type EditorTab = 'details' | 'boundary' | 'stations' | 'layers' | 'voronoi' | 'publish';

export type Selection = { type: 'station'; id: string } | { type: 'poi'; key: string; id: string };

export type EditorState = {
  draft: MapFile;
  /** What the draft started from, to say what changed. */
  original: MapStation[];
  target: EditorTarget;
  tab: EditorTab;
  /** A map tap waiting for a name before it becomes a station or a place. */
  pending: LngLat | null;
  selected: Selection | null;
  /** The layer being looked at and edited on the Layers and Voronoi tabs. */
  layerKey: string | null;
  showCells: boolean;
  /** Corners of a boundary being drawn; null when not drawing. */
  drawing: LngLat[] | null;
  /** Points, stations or the boundary changed since the cells were last built. */
  cellsStale: boolean;
  /**
   * Select mode: a tap on a station (Stations tab) or a place (Places tab)
   * adds it to or takes it out of `picked`, instead of adding a new one.
   */
  picking: boolean;
  /** Ids selected for a bulk edit: stations, or places of the open category. */
  picked: string[];
  /** Earlier drafts, newest first, for Undo. Drafts are immutable, so this shares nearly everything. */
  undo: MapFile[];
  /**
   * How a selection is made: a tap toggles one thing; a rectangle or a lasso
   * is dragged across the map; a polygon is tapped corner by corner.
   */
  shape: 'tap' | 'rect' | 'lasso' | 'polygon';
  /** A shape adds what it covers to the selection, or takes it out. */
  shapeMode: 'add' | 'remove';
  /** Stations: the shape must hold the station's point, or only touch its hiding zone. */
  shapeMatch: 'points' | 'zones';
  /** Corners of a polygon selection being tapped out. */
  shapePts: LngLat[] | null;
};

export const newEditor = (draft: MapFile, target: EditorTarget): EditorState => ({
  draft,
  original: draft.stations,
  target,
  tab: 'details',
  pending: null,
  selected: null,
  layerKey: null,
  showCells: false,
  drawing: null,
  cellsStale: draft.kind === 'pack',
  picking: false,
  picked: [],
  undo: [],
  shape: 'tap',
  shapeMode: 'add',
  shapeMatch: 'points',
  shapePts: null,
});

/** The things a selection shape can pick on the tab that is open, with where each is. */
function pickable(e: EditorState): { id: string; at: LngLat }[] {
  if (e.tab === 'stations') return e.draft.stations.map((s) => ({ id: s.id, at: [s.lon, s.lat] as LngLat }));
  if (e.tab === 'layers' && e.layerKey && e.draft.kind === 'pack') {
    return (e.draft.layers[e.layerKey] ?? []).flatMap((f) => (f.geometry.type === 'Point' ? [{ id: f.properties.id, at: f.geometry.coordinates as LngLat }] : []));
  }
  return [];
}

/** A drawn shape — rectangle, lasso or polygon — applied to the selection. */
export function shapePick(e: EditorState, ring: LngLat[]): EditorState {
  const zoneM = e.tab === 'stations' && e.shapeMatch === 'zones' ? radiusOf(e.draft) : undefined;
  const hit = idsInShape(pickable(e), ring, zoneM);
  return { ...e, picking: true, picked: combine(e.picked, hit, e.shapeMode), shapePts: null };
}

/** Add an id to the selection, or take it out. */
const toggle = (ids: string[], id: string) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

const isPointLayer = (key: string | null) => !!key && LAYER_DEFS.some((d) => d.key === key && d.kind === 'point');

/**
 * Where a tap on the studio's map goes. One decision, made here, so the
 * tools cannot disagree about who owns a tap.
 */
export function editorTap(e: EditorState, ll: LngLat, hit?: Selection): EditorState {
  if (e.drawing) return { ...e, drawing: [...e.drawing, ll] };
  // Selecting: a tap on a thing toggles it; a tap on empty map does nothing.
  if (e.picking) {
    // A polygon is tapped out corner by corner, wherever the taps land.
    if (e.shape === 'polygon') return { ...e, shapePts: [...(e.shapePts ?? []), ll] };
    if (e.tab === 'stations' && hit?.type === 'station') return { ...e, picked: toggle(e.picked, hit.id) };
    if (e.tab === 'layers' && hit?.type === 'poi' && hit.key === e.layerKey) return { ...e, picked: toggle(e.picked, hit.id) };
    return e;
  }
  if (e.tab === 'stations') {
    return hit?.type === 'station' ? { ...e, selected: hit, pending: null } : { ...e, pending: ll, selected: null };
  }
  if (e.tab === 'layers' && isPointLayer(e.layerKey)) {
    return hit?.type === 'poi' && hit.key === e.layerKey ? { ...e, selected: hit, pending: null } : { ...e, pending: ll, selected: null };
  }
  return e;
}

export function downloadMap(map: MapFile): void {
  const blob = new Blob([serializeMap(map)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slugId(map.name)}${MAP_FILE_SUFFIX}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** A polygon out of whatever GeoJSON someone has: a geometry, a feature, or a collection's first polygon. */
function polygonIn(raw: any): Polygon | MultiPolygon | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'Polygon' || raw.type === 'MultiPolygon') return raw;
  if (raw.type === 'Feature') return polygonIn(raw.geometry);
  if (raw.type === 'FeatureCollection' && Array.isArray(raw.features)) {
    for (const f of raw.features) { const g = polygonIn(f); if (g) return g; }
  }
  return null;
}

const km2 = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const MODES: Mode[] = ['rail', 'metro', 'cablecar', 'ferry', 'bus'];

type Props = {
  editor: EditorState;
  onChange: (e: EditorState) => void;
  onClose: () => void;
  /** Play on the finished map without publishing it. */
  onPlay: (map: MapFile) => void;
  onPublished: (mapId: string) => void;
  /** Move the map view somewhere — a place just found, say. */
  onLookAt: (bbox: [number, number, number, number]) => void;
  base: GameData;
  account: Account;
  roundActive: boolean;
};

/**
 * The map editor. The draft *is* the board on the studio's map — every change
 * redraws the real boundary, zones and points, so what is published is
 * exactly what was on screen.
 *
 * For a full city pack its tabs are the pipeline's steps in order: boundary,
 * stations, the POI layers, their Voronoi cells, then an audit before
 * publishing.
 */
export function Editor(props: Props) {
  const { editor, onChange, base } = props;
  const { draft } = editor;
  const pack = draft.kind === 'pack' ? draft : null;
  const [busy, setBusyState] = useState<Busy | null>(null);
  const setBusy = (text: string | null, tool?: string, progress?: number) =>
    setBusyState((was) => (text === null ? null : {
      text,
      tool,
      progress,
      // A retry or a step of the same tool keeps its clock running.
      since: was && was.tool === tool ? was.since : Date.now(),
    }));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // For work that spans renders: what the editor is now, not when it started.
  const latestRef = useRef(editor);
  latestRef.current = editor;
  const latest = () => latestRef.current;

  /**
   * Any edit that moves a point, a station or the boundary leaves the cells
   * behind. Every edit made through here can be undone.
   */
  const patch = (d: Partial<MapFile>, more: Partial<EditorState> = {}, stale = true) =>
    onChange({
      ...editor,
      draft: { ...draft, ...d } as MapFile,
      cellsStale: editor.cellsStale || (stale && !!pack),
      undo: [draft, ...editor.undo].slice(0, 40),
      ...more,
    });
  const undo = () => {
    const [previous, ...older] = editor.undo;
    if (!previous) return;
    // The cells are rebuilt from the points anyway; marking them stale is always safe.
    onChange({ ...editor, draft: previous, undo: older, picked: [], selected: null, pending: null, cellsStale: editor.cellsStale || !!pack });
    setNote('Undone.');
  };

  const problems = useMemo(() => checkMap(draft, base.boundary), [draft.stations, pack?.boundary, draft.city, base.boundary]);
  const blocking = problems.some((p) => p.blocking);

  /**
   * The draft made consistent and run through the one validator, or null.
   * Rebuilding a city's cells takes a moment, so this is what every
   * "finish" action shares rather than each doing its own half.
   */
  const finished = (): MapFile | null => {
    setError(null);
    if (!draft.name.trim()) { setError('Give the map a name first.'); return null; }
    if (blocking) { setError('Fix the problems listed above first.'); return null; }
    let out: MapFile = draft;
    if (pack) {
      const done = finalizePack(pack);
      out = done.pack;
      onChange({ ...editor, draft: out, cellsStale: false });
      if (auditPack(done.pack).tooBig) { setError('This map is too large to publish. Simplify the boundary, or thin the biggest layers.'); return null; }
    }
    const parsed = parseMapFile(JSON.parse(serializeMap(out)));
    if (!parsed.ok) { setError(parsed.error); return null; }
    return parsed.map;
  };

  const tabs: [EditorTab, string][] = pack
    ? [['details', 'Details'], ['boundary', 'Boundary'], ['stations', 'Stations'], ['layers', 'Places'], ['voronoi', 'Voronoi'], ['publish', 'Publish']]
    : [['details', 'Details'], ['stations', 'Stations'], ['publish', 'Publish']];

  const shared = { ...props, pack, patch, busy, setBusy, setError, setNote, finished, problems, blocking, latest };

  return (
    <div className="pad community editor">
      <div className="row editorhead">
        <button className="link grow" onClick={() => confirm('Close this draft? Unpublished changes are lost.') && props.onClose()}>← Close draft</button>
        <button disabled={!editor.undo.length} onClick={undo} title="Undo the last change">↶ Undo{editor.undo.length ? ` (${editor.undo.length})` : ''}</button>
      </div>
      <h2>
        {draft.name.trim() || (pack ? 'New city map' : 'New station map')}
        <span className="tag">{pack ? 'full city' : 'stations on the SF board'}</span>
      </h2>
      {editor.target.type === 'branch' && <p className="muted small">A branch of “{editor.target.parentName}”. It stays linked to it.</p>}
      {editor.target.type === 'version' && <p className="muted small">A new version of a map you published.</p>}

      <div className="seg wide flush tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={editor.tab === key ? 'on' : ''}
            onClick={() => onChange({ ...editor, tab: key, pending: null, selected: null, drawing: null, picking: false, picked: [], shapePts: null })}>
            {label}
          </button>
        ))}
      </div>

      {editor.tab === 'details' && <DetailsTab {...shared} />}
      {editor.tab === 'boundary' && pack && <BoundaryTab {...shared} pack={pack} />}
      {editor.tab === 'stations' && <StationsTab {...shared} />}
      {editor.tab === 'layers' && pack && <LayersTab {...shared} pack={pack} />}
      {editor.tab === 'voronoi' && pack && <VoronoiTab {...shared} pack={pack} />}
      {editor.tab === 'publish' && <PublishTab {...shared} />}

      {busy && <p className="small notice">{busy.text}</p>}
      {note && <p className="small notice">{note}</p>}
      {error && <p className="warntext">{error}</p>}
    </div>
  );
}

/** What the studio is working on, and which button started it — that one wears the spinner. */
type Busy = { text: string; tool?: string; since: number; progress?: number };

type TabProps = Props & {
  pack: PackMap | null;
  patch: (d: Partial<MapFile>, more?: Partial<EditorState>, stale?: boolean) => void;
  busy: Busy | null;
  setBusy: (s: string | null, tool?: string, progress?: number) => void;
  setError: (s: string | null) => void;
  setNote: (s: string | null) => void;
  finished: () => MapFile | null;
  problems: { blocking: boolean; text: string }[];
  blocking: boolean;
  latest: () => EditorState;
};

/**
 * Runs a network tool with a visible status, turning a failure into a
 * message rather than a silence. `tool` names the button that started it.
 */
async function runTool(p: TabProps, tool: string, label: string, work: (onWait: (s: number) => void) => Promise<void>) {
  p.setError(null);
  p.setNote(null);
  p.setBusy(`${label}…`, tool);
  try {
    await work((s) => p.setBusy(`${label}… OpenStreetMap is busy, retrying in ${s}s`, tool));
  } catch (e) {
    p.setError(e instanceof Error ? e.message : 'That did not work.');
  }
  p.setBusy(null);
}

/** Seconds since `since`, ticking. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="elapsed">{Math.max(0, Math.floor((now - since) / 1000))} s</span>;
}

/**
 * A button that starts a long tool. While its tool runs it shows a spinner,
 * what it is doing and either how far along (when the work can count its
 * steps) or how long it has been waiting (when it can't — an OpenStreetMap
 * request is one answer, not a stream of them). Every other tool button is
 * disabled meanwhile, as before.
 */
function ToolButton(props: {
  p: TabProps; tool: string; working: string; className?: string; disabled?: boolean;
  /** The work reports a fraction done, shown as a percentage, rather than only a clock. */
  counts?: boolean;
  onClick: () => void; children: ReactNode;
}) {
  const { busy } = props.p;
  const mine = busy?.tool === props.tool;
  const pct = mine && busy!.progress !== undefined ? Math.round(busy!.progress * 100) : null;
  return (
    // data-reserve sizes the button for its busy face too, so starting it does not reflow the row.
    <button className={`toolbtn ${props.className ?? ''}`} disabled={!!busy || props.disabled} aria-busy={mine || undefined}
      data-reserve={`${props.working} ${props.counts ? '100%' : '00 s'}`}
      onClick={props.onClick} style={pct !== null ? ({ '--progress': `${pct}%` } as CSSProperties) : undefined}>
      {mine ? (
        <span className="work">
          <span className="spinner" aria-hidden="true" />
          <span>{props.working}</span>
          {pct !== null ? <span className="elapsed">{pct}%</span> : <Elapsed since={busy!.since} />}
        </span>
      ) : <span>{props.children}</span>}
    </button>
  );
}

function FileButton(props: { label: string; onText: (text: string, name: string) => void; disabled?: boolean; className?: string; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={props.className} disabled={props.disabled} onClick={() => ref.current?.click()}>{props.label}</button>
      <input ref={ref} type="file" accept={props.accept ?? '.json,.geojson,application/json,application/geo+json'} hidden
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) props.onText(await f.text(), f.name); }} />
    </>
  );
}

// ------------------------------------------------------------------- selecting

/**
 * Select mode and the selection, for stations or for the places of one
 * category. `points` is every candidate, by id, with where it is.
 */
const SHAPES: [EditorState['shape'], string, string][] = [
  ['tap', 'Tap', 'Tap one at a time'],
  ['rect', '▭ Rectangle', 'Drag across the map to draw a rectangle'],
  ['lasso', '◯ Lasso', 'Draw around them, freehand'],
  ['polygon', '⬠ Polygon', 'Tap each corner, then Done'],
];

function PickBar(p: TabProps & { points: { id: string; at: LngLat }[]; noun: string; extra?: { label: string; ids: string[] }[]; zones?: boolean }) {
  const { editor, onChange } = p;
  const picked = new Set(editor.picked);
  const set = (ids: string[], picking = true) => onChange({ ...editor, picked: ids, picking, selected: null, pending: null });
  const inView = () => {
    const b = (window as any).__map?.getBounds?.();
    if (!b) return;
    const ids = p.points.filter(({ at: [lon, lat] }) => lon >= b.getWest() && lon <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth()).map((x) => x.id);
    set([...new Set([...editor.picked, ...ids])]);
  };
  return (
    <div className={`pickbar ${editor.picking ? 'on' : ''}`}>
      <div className="row">
        <button className={editor.picking ? 'on' : ''} aria-pressed={editor.picking}
          onClick={() => onChange({ ...editor, picking: !editor.picking, selected: null, pending: null })}>
          {editor.picking ? '✓ Selecting' : 'Select'}
        </button>
        <span className="grow small">
          {editor.picking
            ? <><b>{picked.size}</b> selected. {SHAPES.find((s) => s[0] === editor.shape)?.[2]}{editor.shape === 'tap' ? ` to select or deselect ${p.noun}` : ''}.</>
            : <span className="muted">Select several {p.noun} to delete or change them at once.</span>}
        </span>
      </div>
      {editor.picking && (
        <>
          <div className="row tight-gap shapes" role="group" aria-label="How to select">
            <div className="seg">
              {SHAPES.map(([key, label, hint]) => (
                <button key={key} className={editor.shape === key ? 'on' : ''} title={hint} aria-pressed={editor.shape === key}
                  onClick={() => onChange({ ...editor, shape: key, shapePts: null })}>{label}</button>
              ))}
            </div>
            {editor.shape !== 'tap' && (
              <div className="seg">
                <button className={editor.shapeMode === 'add' ? 'on' : ''} aria-pressed={editor.shapeMode === 'add'} onClick={() => onChange({ ...editor, shapeMode: 'add' })}>+ Add</button>
                <button className={editor.shapeMode === 'remove' ? 'on' : ''} aria-pressed={editor.shapeMode === 'remove'} onClick={() => onChange({ ...editor, shapeMode: 'remove' })}>− Remove</button>
              </div>
            )}
            {p.zones && editor.shape !== 'tap' && (
              <div className="seg" title="Inside the shape: the station itself, or any part of its hiding zone">
                <button className={editor.shapeMatch === 'points' ? 'on' : ''} aria-pressed={editor.shapeMatch === 'points'} onClick={() => onChange({ ...editor, shapeMatch: 'points' })}>Points</button>
                <button className={editor.shapeMatch === 'zones' ? 'on' : ''} aria-pressed={editor.shapeMatch === 'zones'} onClick={() => onChange({ ...editor, shapeMatch: 'zones' })}>Zones</button>
              </div>
            )}
          </div>
          {editor.shape === 'polygon' && (
            <div className="row tight-gap">
              <span className="small grow">{editor.shapePts?.length ? `${editor.shapePts.length} corner${editor.shapePts.length === 1 ? '' : 's'}` : 'Tap the first corner on the map.'}</span>
              <button className="small primary" disabled={(editor.shapePts?.length ?? 0) < 3} onClick={() => onChange(shapePick(editor, editor.shapePts!))}>Done</button>
              <button className="small" disabled={!editor.shapePts?.length} onClick={() => onChange({ ...editor, shapePts: null })}>Clear</button>
            </div>
          )}
        </>
      )}
      {editor.picking && (
        <div className="row tight-gap">
          <button className="small" onClick={() => set(p.points.map((x) => x.id))}>All</button>
          <button className="small" onClick={inView}>All in view</button>
          <button className="small" onClick={() => set(p.points.map((x) => x.id).filter((id) => !picked.has(id)))}>Invert</button>
          {p.extra?.map((x) => <button key={x.label} className="small" onClick={() => set(x.ids)}>{x.label}</button>)}
          <button className="small" disabled={!picked.size} onClick={() => set([])}>None</button>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- details

function DetailsTab(p: TabProps) {
  const { draft } = p.editor;
  const set = (d: Partial<MapFile>) => p.patch(d, {}, false);
  return (
    <>
      <label className="field">
        <span>Name</span>
        <input type="text" value={draft.name} maxLength={80} placeholder={p.pack ? 'e.g. Oakland, flatlands only' : 'e.g. Downtown only'} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {p.pack && (
        <label className="field">
          <span>City <span className="muted">(a short label people can search by)</span></span>
          <input type="text" value={draft.city} maxLength={24} placeholder="e.g. oakland" onChange={(e) => set({ city: e.target.value.toLowerCase() })} />
        </label>
      )}
      {p.pack && (
        <label className="field">
          <span>
            Country code <span className="muted">(two letters — for the flag beside the city)</span>
            {draft.country && <> · {flagOf(draft.country)} {countryName(draft.country) ?? 'not a country code'}</>}
          </span>
          <input type="text" className="countrycode" value={draft.country ?? ''} maxLength={2} placeholder="e.g. US" autoCapitalize="characters"
            onChange={(e) => set({ country: e.target.value.replace(/[^a-zA-Z]/g, '').toLowerCase() || undefined })} />
        </label>
      )}
      <label className="field">
        <span>Description</span>
        <textarea value={draft.description} maxLength={2000} rows={3} placeholder="Who is this map for? What makes it different?" onChange={(e) => set({ description: e.target.value })} />
      </label>

      <h3>House rules</h3>
      <div className="row">
        <span className="grow">Game size</span>
        <div className="seg">
          {(['small', 'medium', 'large'] as GameSize[]).map((size) => (
            <button key={size} className={draft.rules.gameSize === size ? 'on' : ''} onClick={() => set({ rules: { ...draft.rules, gameSize: size } })}>{size}</button>
          ))}
        </div>
      </div>
      {!p.pack && (
        <>
          <h3>Want to change more than the stations?</h3>
          <p className="muted small">
            A station map borrows San Francisco’s boundary, places and Voronoi cells. Turn it into a full
            city map to edit those too.
          </p>
          <button onClick={() => {
            const full = packFromBoard({ ...p.base, stations: draft.stations.map((s) => ({ ...s, nameLength: s.name.length })) }, draft.name, CITY, draft.rules);
            p.onChange({ ...p.editor, draft: { ...full, description: draft.description }, cellsStale: true });
          }}>
            Make it a full city map
          </button>
        </>
      )}
    </>
  );
}

// -------------------------------------------------------------------- boundary

function BoundaryTab(p: TabProps & { pack: PackMap }) {
  const { editor, pack } = p;
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const stats = useMemo(() => boundaryStats(pack.boundary), [pack.boundary]);

  const stray = useMemo(() => ({
    stations: pack.stations.length - keepInside(pack).length,
    places: LAYER_DEFS.reduce((n, d) => n + (pack.layers[d.key]?.length ?? 0) - clipToBoundary(pack.layers[d.key] ?? [], pack.boundary).kept.length, 0),
  }), [pack.boundary, pack.stations, pack.layers]);

  // One patch, not two: each starts from the draft as rendered, so a second
  // call in the same tap would undo the first.
  const use = (geometry: Polygon | MultiPolygon, what: string, country?: string) => {
    const land = largestLandmass(geometry);
    // The place says what country it is in; a map that already names one keeps it.
    const named = country && !editor.draft.country ? { country } : {};
    p.patch({ boundary: land.polygon, ...named } as Partial<PackMap>, { drawing: null });
    // Stations, places and lines all come from one request; start it now.
    prefetchBoard(land.polygon);
    p.setNote(`${what}: ${km2(land.km2)} km²${land.dropped ? `, keeping the largest piece and dropping ${land.dropped} smaller one${land.dropped === 1 ? '' : 's'} (islands, exclaves)` : ''}.`);
  };

  return (
    <>
      <p className="muted small">
        The edge of the game. Everything outside it is out of play, and every answer is cut to it.
      </p>
      <div className="boardnow">
        <strong>{km2(stats.km2)} km²</strong>
        <span className="muted small">{stats.vertices.toLocaleString()} points in the outline</span>
      </div>

      <h3>Find a place</h3>
      <div className="row">
        <input type="text" className="grow" value={query} placeholder="City, borough, island…" onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && runTool(p, 'search', 'Searching', async () => setPlaces(await searchPlaces(query)))} />
        <button disabled={!query.trim() || !!p.busy} onClick={() => runTool(p, 'search', 'Searching', async () => setPlaces(await searchPlaces(query)))}>Search</button>
      </div>
      {places && places.length === 0 && <p className="muted small">Nothing with an outline by that name.</p>}
      {places && places.length > 0 && (
        <ul className="list">
          {places.map((pl) => (
            <li key={pl.name}>
              <button className="link grow" onClick={() => p.onLookAt(pl.bbox)}>{pl.name}</button>
              <button onClick={() => { use(pl.geometry, 'Boundary set from OpenStreetMap', pl.country); setPlaces(null); }}>Use</button>
            </li>
          ))}
        </ul>
      )}

      <h3>Or draw it</h3>
      {editor.drawing ? (
        <div className="hint fact">
          <p className="small">Tap the map to place each corner, in order. {editor.drawing.length} so far.</p>
          <div className="row">
            <button className="primary" disabled={editor.drawing.length < 3}
              onClick={() => { const poly = polygonFromTaps(editor.drawing!); if (poly) use(poly, 'Boundary drawn'); }}>
              Finish
            </button>
            <button disabled={!editor.drawing.length} onClick={() => p.onChange({ ...editor, drawing: editor.drawing!.slice(0, -1) })}>Undo corner</button>
            <button onClick={() => p.onChange({ ...editor, drawing: null })}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => p.onChange({ ...editor, drawing: [] })}>Draw on the map</button>
          <FileButton label="Import a polygon (GeoJSON)" onText={(text) => {
            let geometry: Polygon | MultiPolygon | null = null;
            try { geometry = polygonIn(JSON.parse(text)); } catch { /* reported below */ }
            if (!geometry) { p.setError('That file has no polygon in it.'); return; }
            use(geometry, 'Boundary imported');
          }} />
        </div>
      )}

      <h3>Simplify</h3>
      <p className="muted small">
        A detailed outline is slow to cut every answer against and makes the map file large. A few metres of
        tolerance is invisible on a phone.
      </p>
      <div className="row">
        {[5, 20, 60].map((m) => (
          <button key={m} onClick={() => {
            const next = simplifyBoundary(pack.boundary, m);
            const after = boundaryStats(next).vertices;
            p.patch({ boundary: next } as Partial<PackMap>);
            p.setNote(`Simplified to within about ${m} m: ${stats.vertices.toLocaleString()} → ${after.toLocaleString()} points.`);
          }}>
            ~{m} m
          </button>
        ))}
      </div>

      {(stray.stations > 0 || stray.places > 0) && (
        <div className="hint warn">
          <p className="small">
            {stray.stations} station{stray.stations === 1 ? '' : 's'} and {stray.places} place{stray.places === 1 ? '' : 's'} now fall outside the boundary.
          </p>
          <button onClick={() => {
            const layers = Object.fromEntries(Object.entries(pack.layers).map(([k, f]) => [k, clipToBoundary(f, pack.boundary).kept]));
            p.patch({ stations: keepInside(pack), layers } as Partial<PackMap>);
          }}>
            Remove them
          </button>
        </div>
      )}
    </>
  );
}

function keepInside(pack: PackMap): MapStation[] {
  const asPoints: LayerFeature[] = pack.stations.map((s) => ({ type: 'Feature', id: s.id, properties: { id: s.id, name: s.name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }));
  const kept = new Set(clipToBoundary(asPoints, pack.boundary).kept.map((f) => f.properties.id));
  return pack.stations.filter((s) => kept.has(s.id));
}

// -------------------------------------------------------------------- stations

/** The kinds of file "Custom file" takes. Both read through `readMapText`, which tells them apart. */
const STATION_FILES: { label: string; hint: string; accept: string }[] = [
  {
    label: 'JetLeg map file',
    hint: 'A map downloaded from this studio (.json). Its stations come with their types and routes.',
    accept: '.json,application/json',
  },
  {
    label: 'GeoJSON points',
    hint: 'Points from QGIS, geojson.io or a converted GTFS feed (.geojson). The name comes from name, stop_name, station, title or label; types from modes if present, otherwise bus.',
    accept: '.geojson,.json,application/geo+json,application/json',
  },
];

function StationsTab(p: TabProps) {
  const { editor } = p;
  const { draft } = editor;
  const [name, setName] = useState('');
  const count = draft.stations.length;
  const selected = editor.selected?.type === 'station' ? draft.stations.find((s) => s.id === editor.selected!.id) ?? null : null;
  const changes = useMemo(() => describeDiff(diffStations(editor.original, draft.stations)), [editor.original, draft.stations]);
  const radius = radiusOf(draft);
  const [radiusText, setRadiusText] = useState(String(radius));
  // Follows the map's own value, which Undo can change underneath the box.
  useEffect(() => setRadiusText(String(radius)), [radius]);
  const [spacing, setSpacing] = useState<'none' | 'slight' | 'half'>('none');
  const [keepPicked, setKeepPicked] = useState(false);
  // The selection Simplify last proposed. While that is still what is selected,
  // "keep the selected" would mean "keep what it says to remove", so it is not offered.
  const [proposal, setProposal] = useState<string[] | null>(null);
  const ownSelection = editor.picked.length > 0 && editor.picked !== proposal;
  const picked = new Set(editor.picked);
  const pickedStations = draft.stations.filter((s) => picked.has(s.id));
  /** Pairs of zones that overlap at this radius. */
  const overlaps = useMemo(
    () => clashGraph(draft.stations, 2 * radius).reduce((n, nb, i) => n + nb.filter((j) => j > i).length, 0),
    [draft.stations, radius],
  );

  /** The map's hiding-zone radius. The default is left out of the file, so a map that never chose one is unchanged. */
  const setRadius = (m: number) => {
    const r = clampZoneRadius(m);
    setRadiusText(String(r));
    const { zoneRadiusM: _old, ...rules } = draft.rules;
    p.patch({ rules: r === ZONE_RADIUS_M ? rules : { ...rules, zoneRadiusM: r } }, {}, false);
  };

  const removePicked = () => {
    if (!pickedStations.length) return;
    if (pickedStations.length > 1 && !confirm(`Delete ${pickedStations.length} stations? Undo brings them back.`)) return;
    p.patch({ stations: draft.stations.filter((s) => !picked.has(s.id)) }, { picked: [], selected: null });
    p.setNote(`${pickedStations.length} station${pickedStations.length === 1 ? '' : 's'} deleted.`);
  };
  /** A transit type on every selected station — or, if they all have it already, off every one that has another. */
  const toggleMode = (m: Mode) => {
    const all = pickedStations.every((s) => s.modes.includes(m));
    p.patch({
      stations: draft.stations.map((s) => {
        if (!picked.has(s.id)) return s;
        const modes = all ? s.modes.filter((x) => x !== m) : [...new Set([...s.modes, m])];
        return modes.length ? { ...s, modes } : s;
      }),
    });
  };

  const simplify = () => {
    const minSpacingM = spacing === 'none' ? 2 * radius : spacing === 'slight' ? 1.5 * radius : radius;
    const res = simplifyStations(draft.stations, { minSpacingM, keep: keepPicked && ownSelection ? editor.picked : [] });
    // The selection becomes what to remove, so "keep the selected" no longer means the same thing.
    setKeepPicked(false);
    setProposal(res.remove);
    p.onChange({ ...editor, picking: true, picked: res.remove, selected: null, pending: null });
    p.setNote(res.remove.length
      ? `Removing the ${res.remove.length} selected would leave ${res.kept} of ${count} stations, with ${res.clashesAfter ? `${res.clashesAfter} overlapping pairs` : 'no zones overlapping'} (${res.clashesBefore} now). They are selected on the map: look them over, deselect any you want to keep, then delete.`
      : 'Nothing to remove: no two stations are that close.');
  };

  const add = () => {
    const clean = name.trim();
    if (!editor.pending || !clean) return;
    const used = new Set(draft.stations.map((s) => s.id));
    const base = slugId(clean);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}${n}`;
    const station: MapStation = { id, name: clean, lon: round6(editor.pending[0]), lat: round6(editor.pending[1]), modes: ['bus'], routes: [] };
    p.patch({ stations: [...draft.stations, station] }, { pending: null, selected: { type: 'station', id } });
    setName('');
  };
  const update = (change: Partial<MapStation>) =>
    selected && p.patch({ stations: draft.stations.map((s) => (s.id === selected.id ? { ...s, ...change } : s)) });

  const [fileOpen, setFileOpen] = useState(false);
  const fromFile = (text: string, file: string) => {
    const parsed = readMapText(text, draft.name || file.replace(/\.[^.]+$/, ''), draft.city || CITY);
    if (!parsed.ok) { p.setError(parsed.error); return; }
    replace(parsed.map.stations, 'from the file');
    setFileOpen(false);
  };
  // The station panel sits below the tools now; a tap on the map should bring it into view.
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [editor.selected?.id]);

  const replace = (all: MapStation[], how: string) => {
    // Over the cap, keep the most evenly spread ones rather than refuse.
    const stations = spaceOut(all, MAX_STATIONS);
    if (count && !confirm(`Replace the ${count} stations here with ${stations.length} ${how}?`)) return;
    p.patch({ stations }, { pending: null, selected: null });
    p.setNote(stations.length < all.length
      ? `${stations.length} stations ${how}: ${all.length} was over the limit of ${MAX_STATIONS}, so they were spaced out evenly across the board, rail, metro, tram and ferry first.`
      : `${stations.length} stations ${how}.`);
  };

  return (
    <>
      <p className="muted small">
        Each station is a hiding zone: the circle around it. Tap the map to add one; tap a station to
        rename, retype or remove it.{editor.original.length > 0 && <> So far: {changes}.</>}
      </p>

      <h3>Hiding zone size</h3>
      <div className="row radiusrow">
        <div className="seg">
          {[250, 400, 500, 800, 1000].map((m) => (
            <button key={m} className={radius === m ? 'on' : ''} onClick={() => setRadius(m)}>{m < 1000 ? `${m} m` : `${m / 1000} km`}</button>
          ))}
        </div>
        <label className="radiusin small">
          <input type="number" min={MIN_ZONE_RADIUS_M} max={MAX_ZONE_RADIUS_M} step={10} value={radiusText}
            onChange={(e) => setRadiusText(e.target.value)}
            onBlur={() => { const v = Number(radiusText); if (Number.isFinite(v) && v > 0) setRadius(v); else setRadiusText(String(radius)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          {' '}m from each station
        </label>
      </div>
      <p className="muted small">
        How far a hider may be from their station. {ZONE_RADIUS_M} m is {HOME_MAP_NAME}’s. Everyone playing this map
        plays at this size.
      </p>

      <h3>Import stations</h3>
      <div className="row">
        {p.pack && (
          <>
            <ToolButton p={p} tool="osm-rail" working="Fetching…" className="primary"
              onClick={() => runTool(p, 'osm-rail', 'Fetching rail, metro, tram and ferry stops', async (w) => {
                const got = await fetchStations(p.pack!.boundary, false, w);
                replace(got.stations, 'from OpenStreetMap');
              })}>
              OSM: Rail
            </ToolButton>
            <ToolButton p={p} tool="osm-bus" working="Fetching…" className="primary"
              onClick={() => runTool(p, 'osm-bus', 'Fetching every transit stop', async (w) => {
                const got = await fetchStations(p.pack!.boundary, true, w);
                replace(got.stations, 'from OpenStreetMap, bus stops included');
              })}>
              OSM: Rail + bus
            </ToolButton>
          </>
        )}
        <button aria-expanded={fileOpen} onClick={() => setFileOpen(!fileOpen)}>Custom file {fileOpen ? '▴' : '▾'}</button>
      </div>
      {p.pack && (
        <p className="muted small">
          From OpenStreetMap: rail, metro, tram and ferry stops, or those plus every bus stop. Same-named stops within
          150 m are folded into one. Check the result — OpenStreetMap’s tagging varies by city.
        </p>
      )}
      {fileOpen && (
        <div className="filetypes">
          {STATION_FILES.map((f) => (
            <div key={f.label} className="filetype">
              <div className="grow">
                <b>{f.label}</b>
                <div className="muted small">{f.hint}</div>
              </div>
              <FileButton label="Choose file" accept={f.accept} onText={fromFile} />
            </div>
          ))}
          <p className="muted small">Either replaces every station here. Undo brings them back.</p>
        </div>
      )}

      <div className="boardnow">
        <strong>{count} stations</strong>
        <span className="muted small">{overlaps ? `${overlaps} pair${overlaps === 1 ? '' : 's'} of zones overlap` : 'No zones overlap'}</span>
      </div>
      {p.problems.map((x) => (
        <p key={x.text} className={`hint ${x.blocking ? 'warn' : ''} small`}>{x.blocking ? 'Can’t be played: ' : 'Worth a look: '}{x.text}</p>
      ))}

      <h3>Simplify</h3>
      <p className="muted small">
        Overlapping zones put the same ground in two hiding zones at once. Simplify finds the fewest stations to
        remove so the rest don’t overlap, keeping rail and metro stations over bus stops when it has a choice.
        Nothing is deleted until you say so.
      </p>
      <div className="row">
        <select value={spacing} onChange={(e) => setSpacing(e.target.value as typeof spacing)} aria-label="How much overlap to allow">
          <option value="none">No overlap at all — stations at least {2 * radius} m apart</option>
          <option value="slight">A little overlap — at least {1.5 * radius} m apart</option>
          <option value="half">Up to half — at least {radius} m apart</option>
        </select>
      </div>
      {ownSelection && (
        <label className="check small">
          <input type="checkbox" checked={keepPicked} onChange={(e) => setKeepPicked(e.target.checked)} />
          <span>Keep the {editor.picked.length} selected stations, whatever they overlap</span>
        </label>
      )}
      <button className="primary" disabled={count < 2} onClick={simplify}>Find stations to remove</button>

      <h3>Select</h3>
      <PickBar {...p} noun="stations" zones
        points={draft.stations.map((s) => ({ id: s.id, at: [s.lon, s.lat] as LngLat }))}
        extra={[{ label: 'Bus-only', ids: draft.stations.filter((s) => s.modes.every((m) => m === 'bus')).map((s) => s.id) }]} />
      {editor.picking && pickedStations.length > 0 && (
        <div className="hint fact bulk">
          <div className="row">
            <b className="grow">{pickedStations.length} selected</b>
            <button className="danger" onClick={removePicked}>Delete {pickedStations.length}</button>
          </div>
          <div className="row tight-gap">
            <span className="small muted">Type:</span>
            {MODES.map((m) => {
              const n = pickedStations.filter((s) => s.modes.includes(m)).length;
              return (
                <button key={m} className={`small ${n === pickedStations.length ? 'on' : n ? 'some' : ''}`} onClick={() => toggleMode(m)}
                  title={n === pickedStations.length ? `Take ${m} off all of them` : `Make all of them ${m}`}>
                  {m}{n > 0 && n < pickedStations.length ? ` (${n})` : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {editor.pending && (
        <div className="hint fact">
          <p className="small">New station at {editor.pending[1].toFixed(5)}, {editor.pending[0].toFixed(5)}</p>
          <div className="row">
            <input type="text" className="grow" autoFocus value={name} maxLength={80} placeholder="Station name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className="primary" disabled={!name.trim() || count >= MAX_STATIONS} onClick={add}>Add</button>
            <button onClick={() => p.onChange({ ...editor, pending: null })}>Cancel</button>
          </div>
        </div>
      )}

      {selected && !editor.picking && (
        <div className="hint fact" ref={selectedRef}>
          <div className="row">
            <input type="text" className="grow" value={selected.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} />
            <button className="link danger" onClick={() => p.patch({ stations: draft.stations.filter((s) => s.id !== selected.id) }, { selected: null })}>Remove</button>
            <button onClick={() => p.onChange({ ...editor, selected: null })}>Done</button>
          </div>
          <div className="row modes">
            {MODES.map((m) => (
              <label key={m} className="check small">
                <input type="checkbox" checked={selected.modes.includes(m)}
                  onChange={(e) => {
                    const modes = e.target.checked ? [...selected.modes, m] : selected.modes.filter((x) => x !== m);
                    if (modes.length) update({ modes });
                  }} />
                <span>{m}</span>
              </label>
            ))}
          </div>
          {p.pack && <p className="muted small">Anything other than bus-only also puts it in the “Rail stations” layer.</p>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------- layers

function LayersTab(p: TabProps & { pack: PackMap }) {
  const { editor, pack } = p;
  const [name, setName] = useState('');
  const audit = useMemo(() => auditPack(pack).layers, [pack.layers, pack.voronoi, pack.boundary]);
  const def = LAYER_DEFS.find((d) => d.key === editor.layerKey) ?? null;
  const features = def ? pack.layers[def.key] ?? [] : [];
  const selected = editor.selected?.type === 'poi' && def ? features.find((f) => f.properties.id === editor.selected!.id) ?? null : null;

  const setLayer = (key: string, feats: LayerFeature[], said?: string) => {
    const layers = { ...pack.layers };
    if (feats.length) layers[key] = feats; else delete layers[key];
    p.patch({ layers } as Partial<PackMap>, { pending: null, selected: null, picked: [] });
    if (said) p.setNote(said);
  };

  const pickedSet = new Set(editor.picked);
  const pickedPlaces = features.filter((f) => pickedSet.has(f.properties.id));
  const pointDefs = LAYER_DEFS.filter((d) => d.kind === 'point' && d.key !== def?.key);
  const deletePicked = () => {
    if (!def || !pickedPlaces.length) return;
    if (pickedPlaces.length > 1 && !confirm(`Delete ${pickedPlaces.length} ${def.label.toLowerCase()}? Undo brings them back.`)) return;
    setLayer(def.key, features.filter((f) => !pickedSet.has(f.properties.id)), `${pickedPlaces.length} deleted.`);
  };
  /** A goat pen tagged as a zoo, say: into the right category, in one go. */
  const movePicked = (to: string) => {
    if (!def || !pickedPlaces.length) return;
    const target = LAYER_DEFS.find((d) => d.key === to);
    if (!target) return;
    const there = pack.layers[to] ?? [];
    const used = new Set(there.map((f) => f.properties.id));
    const moved = pickedPlaces.map((f) => {
      let id = f.properties.id;
      for (let n = 2; used.has(id); n++) id = `${f.properties.id}-${n}`;
      used.add(id);
      return { ...f, id, properties: { ...f.properties, id } };
    });
    const layers = { ...pack.layers, [to]: [...there, ...moved] };
    const left = features.filter((f) => !pickedSet.has(f.properties.id));
    if (left.length) layers[def.key] = left; else delete layers[def.key];
    p.patch({ layers } as Partial<PackMap>, { pending: null, selected: null, picked: [] });
    p.setNote(`${moved.length} moved to ${target.label}.`);
  };

  const fetchOne = async (key: string, onWait: (s: number) => void): Promise<string> => {
    if (key === 'transitLines') { const f = await fetchTransitLines(pack.boundary, onWait); return apply(key, f, `${f.length} transit lines`); }
    if (key === 'coastline') { const f = await fetchCoastline(pack.boundary, onWait); return apply(key, f, `${f.length} stretches of coastline`); }
    const got = await fetchPois(key, pack.boundary, onWait);
    const d = got.dropped;
    return apply(key, got.features, `${got.features.length} kept (dropped ${d.unnamed} unnamed, ${d.outside} outside the boundary, ${d.rejected} that the rules exclude, ${d.duplicates} duplicates)`);
  };
  // Collected and applied in one go by the caller, so a batch does not overwrite itself.
  const fetched: Record<string, LayerFeature[]> = {};
  const apply = (key: string, feats: LayerFeature[], said: string) => { fetched[key] = feats; return said; };
  const commit = (said: string) => {
    const layers = { ...pack.layers };
    for (const [k, f] of Object.entries(fetched)) { if (f.length) layers[k] = f; else delete layers[k]; }
    p.patch({ layers } as Partial<PackMap>, { pending: null, selected: null });
    p.setNote(said);
  };

  const fetchable = (key: string) => key in POI_DEFS || key === 'transitLines' || key === 'coastline';

  const addPlace = () => {
    const clean = name.trim();
    if (!def || !editor.pending || !clean) return;
    const id = `${def.key}-${slugId(clean)}-${Date.now().toString(36)}`;
    const f: LayerFeature = { type: 'Feature', id, properties: { id, name: clean }, geometry: { type: 'Point', coordinates: [round6(editor.pending[0]), round6(editor.pending[1])] } };
    setLayer(def.key, [...features, f]);
    setName('');
  };

  if (!def) {
    return (
      <>
        <p className="muted small">
          What the questions ask about: “is your nearest library the same as mine?” needs the libraries. A
          category with nothing in it is simply not in play on this map.
        </p>
        <ToolButton p={p} tool="osm-all" working="Fetching every category…" className="primary"
          onClick={() => runTool(p, 'osm-all', 'Fetching every category from OpenStreetMap', async (w) => {
            const all = await fetchAllPois(pack.boundary, w);
            const lines = Object.entries(all).map(([key, got]) => { apply(key, got.features, ''); return `${LAYER_DEFS.find((d) => d.key === key)?.label ?? key} ${got.features.length}`; });
            // Lines and coastline come out of the same one request (fetchBoard's cache). Left out,
            // a city's transit-line questions all answered null with nothing to say why.
            const transit = await fetchTransitLines(pack.boundary, w);
            apply('transitLines', transit, '');
            const coast = await fetchCoastline(pack.boundary, w);
            // An empty fetch must not undo "Use the boundary's edge": that coastline was chosen.
            if (coast.length || !pack.layers.coastline?.length) apply('coastline', coast, '');
            commit(`Fetched ${lines.length} categories, ${transit.length} transit lines and ${coast.length} stretches of coastline. ${lines.join(' · ')}`);
          })}>
          Fetch every category from OpenStreetMap
        </ToolButton>
        <p className="muted small">Every kind of place, plus transit lines and coastline: one request to a free, shared service, started when the boundary was set; a large city can take a minute. Review each list afterwards — the file you publish is the ruling.</p>
        <ul className="list layeraudit">
          {audit.map((a) => (
            <li key={a.key}>
              <button className="link grow" onClick={() => p.onChange({ ...editor, layerKey: a.key, showCells: false, pending: null, selected: null, picking: false, picked: [], shapePts: null })}>
                <b>{a.label}</b> <span className="muted">· {a.count}</span>
                <span className="muted small maprow">{a.verdict}{a.outside ? ` · ${a.outside} outside the boundary` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      <button className="link" onClick={() => p.onChange({ ...editor, layerKey: null, pending: null, selected: null, picking: false, picked: [], shapePts: null })}>← All categories</button>
      <h3>{def.label} <span className="muted">· {features.length}</span></h3>
      {def.key === 'railStations' && (
        <p className="muted small">Filled in automatically from the stations that are not bus-only. Import your own to override that.</p>
      )}
      {def.kind === 'point'
        ? <p className="muted small">Shown on the map. Tap the map to add one; tap one to rename or remove it.</p>
        : <p className="muted small">A line layer: distance is measured to the nearest point on the line. Lines can be fetched or imported, not drawn.</p>}

      {def.kind === 'point' && (
        <PickBar {...p} noun={def.label.toLowerCase()}
          points={features.flatMap((f) => (f.geometry.type === 'Point' ? [{ id: f.properties.id, at: f.geometry.coordinates as LngLat }] : []))} />
      )}
      {editor.picking && pickedPlaces.length > 0 && (
        <div className="hint fact bulk">
          <div className="row">
            <b className="grow">{pickedPlaces.length} selected</b>
            <button className="danger" onClick={deletePicked}>Delete {pickedPlaces.length}</button>
          </div>
          <div className="row">
            <select value="" onChange={(e) => e.target.value && movePicked(e.target.value)} aria-label="Move the selected to another category">
              <option value="">Move to another category…</option>
              {pointDefs.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </div>
        </div>
      )}

      {editor.pending && def.kind === 'point' && (
        <div className="hint fact">
          <div className="row">
            <input type="text" className="grow" autoFocus value={name} maxLength={80} placeholder={`Name of the ${def.label.toLowerCase().replace(/s$/, '')}`} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPlace()} />
            <button className="primary" disabled={!name.trim()} onClick={addPlace}>Add</button>
            <button onClick={() => p.onChange({ ...editor, pending: null })}>Cancel</button>
          </div>
        </div>
      )}
      {selected && !editor.picking && (
        <div className="hint fact">
          <div className="row">
            <input type="text" className="grow" value={selected.properties.name} maxLength={80}
              onChange={(e) => setLayer(def.key, features.map((f) => (f === selected ? { ...f, properties: { ...f.properties, name: e.target.value } } : f)))} />
            <button className="link danger" onClick={() => setLayer(def.key, features.filter((f) => f !== selected))}>Remove</button>
          </div>
          <p className="muted small">Removing is how a ruling is made: a goat pen tagged as a zoo comes off the list here, before the game.</p>
        </div>
      )}

      <div className="row">
        {fetchable(def.key) && (
          <ToolButton p={p} tool={`osm-${def.key}`} working="Fetching…"
            onClick={() => runTool(p, `osm-${def.key}`, `Fetching ${def.label.toLowerCase()}`, async (w) => commit(`${def.label}: ${await fetchOne(def.key, w)}.`))}>
            Fetch from OpenStreetMap
          </ToolButton>
        )}
        {def.key === 'coastline' && (
          <button onClick={() => setLayer('coastline', coastlineFromBoundary(pack.boundary), 'Coastline set to the boundary’s own edge — right for an island or a peninsula.')}>
            Use the boundary’s edge
          </button>
        )}
        <FileButton label="Import GeoJSON" onText={(text) => {
          let raw: unknown;
          try { raw = JSON.parse(text); } catch { p.setError('That file is not valid JSON.'); return; }
          const got = readLayer(def.key, def.kind, raw);
          if (!got.ok) { p.setError(`${def.label}: ${got.error}`); return; }
          const clipped = clipToBoundary(got.features, pack.boundary);
          setLayer(def.key, clipped.kept, `${clipped.kept.length} imported${clipped.outside ? `, ${clipped.outside} outside the boundary left out` : ''}.`);
        }} />
        {features.length > 0 && <button className="link danger" onClick={() => confirm(`Remove all ${features.length}?`) && setLayer(def.key, [])}>Clear</button>}
      </div>

      <ul className="list">
        {features.slice(0, 200).map((f) => (
          <li key={f.properties.id}>
            <button className="link grow" onClick={() => p.onChange({ ...editor, selected: { type: 'poi', key: def.key, id: f.properties.id }, pending: null })}>{f.properties.name}</button>
          </li>
        ))}
      </ul>
      {features.length > 200 && <p className="muted small">…and {features.length - 200} more, all on the map.</p>}
    </>
  );
}

// --------------------------------------------------------------------- voronoi

function VoronoiTab(p: TabProps & { pack: PackMap }) {
  const { editor, pack } = p;

  const rebuild = async () => {
    p.setError(null);
    p.setNote(null);
    const started = performance.now();
    // One category at a time, yielding between them, so the button can count.
    // Weighted by points, which is what a category's cells cost; rail stations
    // are derived from the stations during the build.
    const weight = (key: string) => 1 + (key === 'railStations' ? pack.stations.length : pack.layers[key]?.length ?? 0);
    const totalWeight = VORONOI_KEYS.reduce((n, k) => n + weight(k), 0);
    let doneWeight = 0;
    const done = await finalizePackStepwise(pack, (n, total, key) => {
      p.setBusy(`Building Voronoi cells: ${LAYER_DEFS.find((d) => d.key === key)?.label ?? key} (${n + 1} of ${total})…`, 'voronoi', doneWeight / totalWeight);
      doneWeight += weight(key);
    });
    p.setBusy(null);
    const now = p.latest();
    // The map stays usable while this runs; cells built from points since changed would be wrong.
    if (now.draft !== pack) { p.setNote('The map changed while the cells were being built, so they were not kept. Build again.'); return; }
    p.onChange({ ...now, draft: done.pack, cellsStale: false });
    const total = Object.values(done.pack.voronoi).reduce((n, c) => n + c.length, 0);
    p.setNote(`${total.toLocaleString()} cells across ${Object.keys(done.pack.voronoi).length} categories, in ${((performance.now() - started) / 1000).toFixed(1)} s.${done.notes.length ? ' ' + done.notes.join(' ') : ''}`);
  };

  const pointDefs = LAYER_DEFS.filter((d) => (VORONOI_KEYS as readonly string[]).includes(d.key));

  return (
    <>
      <p className="muted small">
        A matching question — “is your nearest park the same as mine?” — is a question about which Voronoi
        cell you are standing in. The cells are built from each category’s points and cut to the boundary,
        and the game answers from exactly the cells drawn here.
      </p>
      {editor.cellsStale && (
        <p className="hint warn small">Points, stations or the boundary have changed since these cells were built. They are rebuilt automatically when you publish, play or download — or now:</p>
      )}
      <ToolButton p={p} tool="voronoi" working="Building cells…" counts className="primary" onClick={rebuild}>Build all cells</ToolButton>

      <ul className="list layeraudit">
        {pointDefs.map((d) => {
          const points = pack.layers[d.key]?.length ?? 0;
          const cells = pack.voronoi[d.key]?.length ?? 0;
          const custom = pack.customVoronoi.includes(d.key);
          const showing = editor.layerKey === d.key && editor.showCells;
          return (
            <li key={d.key}>
              <div className="grow">
                <b>{d.label}</b> <span className="muted">· {points} point{points === 1 ? '' : 's'} · {cells} cell{cells === 1 ? '' : 's'}</span>
                {custom && <span className="tag warn">hand-made</span>}
                <div className="muted small">
                  {points < 2 ? 'Fewer than two points: no cells to draw.' : custom ? 'Yours — left exactly as imported.' : 'Built from the points.'}
                </div>
              </div>
              <button className="link" disabled={!cells}
                onClick={() => p.onChange({ ...editor, layerKey: showing ? null : d.key, showCells: !showing })}>
                {showing ? 'Hide' : 'Show'}
              </button>
              {custom ? (
                <button className="link" onClick={() => {
                  const voronoi = { ...pack.voronoi };
                  delete voronoi[d.key];
                  p.patch({ voronoi, customVoronoi: pack.customVoronoi.filter((k) => k !== d.key) } as Partial<PackMap>);
                }}>Automatic</button>
              ) : (
                <FileButton label="Import" disabled={points < 1} onText={(text) => {
                  let raw: unknown;
                  try { raw = JSON.parse(text); } catch { p.setError('That file is not valid JSON.'); return; }
                  const got = readCells(d.key, raw);
                  if (!got.ok) { p.setError(`${d.label}: ${got.error}`); return; }
                  const ids = new Set((pack.layers[d.key] ?? []).map((f) => f.properties.id));
                  const matched = got.cells.filter((c) => ids.has(c.properties.id)).length;
                  if (!matched) { p.setError(`${d.label}: none of those cells has an id matching a point in this category. A cell belongs to a point by its id.`); return; }
                  p.patch({ voronoi: { ...pack.voronoi, [d.key]: got.cells }, customVoronoi: [...new Set([...pack.customVoronoi, d.key])] } as Partial<PackMap>, { layerKey: d.key, showCells: true }, false);
                  p.setNote(`${got.cells.length} hand-made cells for ${d.label.toLowerCase()}; ${matched} match a point by id.`);
                }} />
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        To supply your own cells, import GeoJSON polygons whose <code>id</code> matches the point each belongs to.
        Download the map file first to see the ids and the shape expected.
      </p>
    </>
  );
}

// --------------------------------------------------------------------- publish

function PublishTab(p: TabProps) {
  const { editor, account } = p;
  const [message, setMessage] = useState('');
  const audit = useMemo(() => (p.pack ? auditPack(p.pack) : null), [p.pack]);
  const canPublish = account.state === 'signedIn' && !!account.displayName;
  const label = editor.target.type === 'version' ? 'Publish new version' : editor.target.type === 'branch' ? 'Publish branch' : 'Publish map';

  const publish = async () => {
    const map = p.finished();
    if (!map) return;
    p.setBusy('Publishing…');
    const t = editor.target;
    const res = t.type === 'version'
      ? await publishVersion(t.mapId, map, message).then((r) => (r.ok ? { ok: true as const, value: t.mapId } : r))
      : await publishMap(map, message, t.type === 'branch' ? t.parentVersionId : undefined);
    p.setBusy(null);
    if (res.ok) p.onPublished(res.value);
    else p.setError(res.error);
  };

  return (
    <>
      {p.problems.map((x) => (
        <p key={x.text} className={`hint ${x.blocking ? 'warn' : ''} small`}>{x.blocking ? 'Can’t be played: ' : 'Worth a look: '}{x.text}</p>
      ))}
      {editor.draft.stations.length < 2 && <p className="hint warn small">Can’t be played: a map needs at least two stations.</p>}

      {audit && (
        <>
          <h3>What is on this map</h3>
          <ul className="list layeraudit">
            <li><span className="grow"><b>Stations</b> <span className="muted">· {editor.draft.stations.length} hiding zones</span></span></li>
            {audit.layers.map((a) => (
              <li key={a.key}>
                <span className="grow">
                  <b>{a.label}</b> <span className="muted">· {a.count}</span>
                  <span className="muted small maprow">{a.verdict}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className={`small ${audit.tooBig ? 'warntext' : 'muted'}`}>
            File size about {(audit.bytes / 1e6).toFixed(2)} MB{audit.tooBig ? ' — too large to publish; simplify the boundary.' : '.'}
          </p>
        </>
      )}

      <h3>Publish</h3>
      {canPublish ? (
        <>
          <label className="field">
            <span>What changed <span className="muted">(optional)</span></span>
            <input type="text" value={message} maxLength={200} placeholder={editor.target.type === 'new' ? 'First version' : 'What is different'} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button className="primary big" disabled={!!p.busy || p.blocking || editor.draft.stations.length < 2} onClick={publish}>{label}</button>
          <p className="muted small">Published maps are public. Keep to the <a href="#/rules">community rules</a>: public places only, nobody's personal details.</p>
        </>
      ) : (
        <AccountBox account={account} reason="Publishing a map puts your name on it, so it needs you signed in." />
      )}
      <button className="big" disabled={!!p.busy || p.blocking || p.roundActive || editor.draft.stations.length < 2} onClick={() => { const m = p.finished(); if (m) p.onPlay(m); }}>
        Play on it without publishing
      </button>
      {p.roundActive && <p className="muted small">You have a round in progress; end it before changing boards.</p>}
      <button className="big" disabled={!!p.busy} onClick={() => { const m = p.finished(); if (m) downloadMap(m); }}>Download the map file</button>
    </>
  );
}
