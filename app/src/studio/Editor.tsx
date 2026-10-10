import { useMemo, useRef, useState } from 'react';
import type { MultiPolygon, Polygon } from 'geojson';
import type { GameData } from '../data/load';
import { LAYER_DEFS, VORONOI_KEYS } from '../data/layers';
import type { GameSize, LngLat, Mode } from '../engine/types';
import type { Account } from '../community/account';
import { publishMap, publishVersion } from '../community/api';
import { CITY, checkMap } from '../community/board';
import {
  MAP_FILE_SUFFIX,
  MAX_STATIONS,
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
  searchPlaces,
  type Place,
} from '../community/osm';
import {
  auditPack,
  boundaryStats,
  clipToBoundary,
  coastlineFromBoundary,
  finalizePack,
  largestLandmass,
  packFromBoard,
  polygonFromTaps,
  simplifyBoundary,
} from '../community/pack';
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
});

const isPointLayer = (key: string | null) => !!key && LAYER_DEFS.some((d) => d.key === key && d.kind === 'point');

/**
 * Where a tap on the studio's map goes. One decision, made here, so the
 * tools cannot disagree about who owns a tap.
 */
export function editorTap(e: EditorState, ll: LngLat, hit?: Selection): EditorState {
  if (e.drawing) return { ...e, drawing: [...e.drawing, ll] };
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Any edit that moves a point, a station or the boundary leaves the cells behind. */
  const patch = (d: Partial<MapFile>, more: Partial<EditorState> = {}, stale = true) =>
    onChange({ ...editor, draft: { ...draft, ...d } as MapFile, cellsStale: editor.cellsStale || (stale && !!pack), ...more });

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

  const shared = { ...props, pack, patch, busy, setBusy, setError, setNote, finished, problems, blocking };

  return (
    <div className="pad community editor">
      <button className="link" onClick={() => confirm('Close this draft? Unpublished changes are lost.') && props.onClose()}>← Close draft</button>
      <h2>
        {draft.name.trim() || (pack ? 'New city map' : 'New station map')}
        <span className="tag">{pack ? 'full city' : 'stations on the SF board'}</span>
      </h2>
      {editor.target.type === 'branch' && <p className="muted small">A branch of “{editor.target.parentName}”. It stays linked to it.</p>}
      {editor.target.type === 'version' && <p className="muted small">A new version of a map you published.</p>}

      <div className="seg wide flush tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={editor.tab === key ? 'on' : ''}
            onClick={() => onChange({ ...editor, tab: key, pending: null, selected: null, drawing: null })}>
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

      {busy && <p className="small notice">{busy}</p>}
      {note && <p className="small notice">{note}</p>}
      {error && <p className="warntext">{error}</p>}
    </div>
  );
}

type TabProps = Props & {
  pack: PackMap | null;
  patch: (d: Partial<MapFile>, more?: Partial<EditorState>, stale?: boolean) => void;
  busy: string | null;
  setBusy: (s: string | null) => void;
  setError: (s: string | null) => void;
  setNote: (s: string | null) => void;
  finished: () => MapFile | null;
  problems: { blocking: boolean; text: string }[];
  blocking: boolean;
};

/** Runs a network tool with a visible status, turning a failure into a message rather than a silence. */
async function runTool(p: TabProps, label: string, work: (onWait: (s: number) => void) => Promise<void>) {
  p.setError(null);
  p.setNote(null);
  p.setBusy(`${label}…`);
  try {
    await work((s) => p.setBusy(`${label}… OpenStreetMap is busy, retrying in ${s}s`));
  } catch (e) {
    p.setError(e instanceof Error ? e.message : 'That did not work.');
  }
  p.setBusy(null);
}

function FileButton(props: { label: string; onText: (text: string, name: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button disabled={props.disabled} onClick={() => ref.current?.click()}>{props.label}</button>
      <input ref={ref} type="file" accept=".json,.geojson,application/json,application/geo+json" hidden
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) props.onText(await f.text(), f.name); }} />
    </>
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
        <label className="check">
          <input type="checkbox" checked={!!draft.rules.supervisorDistrictsAsAdmin4}
            onChange={(e) => set({ rules: { ...draft.rules, supervisorDistrictsAsAdmin4: e.target.checked } })} />
          <span>Supervisor districts count as the 4th administrative division</span>
        </label>
      )}

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

  const use = (geometry: Polygon | MultiPolygon, what: string) => {
    const land = largestLandmass(geometry);
    p.patch({ boundary: land.polygon } as Partial<PackMap>, { drawing: null });
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
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && runTool(p, 'Searching', async () => setPlaces(await searchPlaces(query)))} />
        <button disabled={!query.trim() || !!p.busy} onClick={() => runTool(p, 'Searching', async () => setPlaces(await searchPlaces(query)))}>Search</button>
      </div>
      {places && places.length === 0 && <p className="muted small">Nothing with an outline by that name.</p>}
      {places && places.length > 0 && (
        <ul className="list">
          {places.map((pl) => (
            <li key={pl.name}>
              <button className="link grow" onClick={() => p.onLookAt(pl.bbox)}>{pl.name}</button>
              <button onClick={() => { use(pl.geometry, 'Boundary set from OpenStreetMap'); setPlaces(null); }}>Use</button>
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

function StationsTab(p: TabProps) {
  const { editor } = p;
  const { draft } = editor;
  const [name, setName] = useState('');
  const count = draft.stations.length;
  const selected = editor.selected?.type === 'station' ? draft.stations.find((s) => s.id === editor.selected!.id) ?? null : null;
  const changes = useMemo(() => describeDiff(diffStations(editor.original, draft.stations)), [editor.original, draft.stations]);

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

  const replace = (stations: MapStation[], how: string) => {
    if (stations.length > MAX_STATIONS) {
      p.setError(`That gives ${stations.length} stations; a map can have at most ${MAX_STATIONS}. Leave out bus stops, or use a smaller boundary.`);
      return;
    }
    if (count && !confirm(`Replace the ${count} stations here with ${stations.length} ${how}?`)) return;
    p.patch({ stations }, { pending: null, selected: null });
    p.setNote(`${stations.length} stations ${how}.`);
  };

  return (
    <>
      <p className="muted small">
        Each station is a hiding zone: a 500 m circle around it. Tap the map to add one; tap a station to
        rename, retype or remove it.{editor.original.length > 0 && <> So far: {changes}.</>}
      </p>
      <div className="boardnow"><strong>{count} stations</strong></div>

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

      {selected && (
        <div className="hint fact">
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

      {p.problems.map((x) => (
        <p key={x.text} className={`hint ${x.blocking ? 'warn' : ''} small`}>{x.blocking ? 'Can’t be played: ' : 'Worth a look: '}{x.text}</p>
      ))}

      {p.pack && (
        <>
          <h3>From OpenStreetMap</h3>
          <div className="row">
            <button disabled={!!p.busy} onClick={() => runTool(p, 'Fetching rail, metro, tram and ferry stops', async (w) => {
              const got = await fetchStations(p.pack!.boundary, false, undefined, w);
              replace(got.stations, 'from OpenStreetMap');
            })}>Rail, metro, tram and ferry stops</button>
            <button disabled={!!p.busy} onClick={() => runTool(p, 'Fetching every transit stop', async (w) => {
              const got = await fetchStations(p.pack!.boundary, true, undefined, w);
              replace(got.stations, 'from OpenStreetMap, bus stops included');
            })}>…and bus stops</button>
          </div>
          <p className="muted small">Same-named stops within 150 m are folded into one. Check the result — OpenStreetMap’s tagging varies by city.</p>
        </>
      )}

      <h3>From a file</h3>
      <div className="row">
        <FileButton label="Replace stations from a file" onText={(text, file) => {
          const parsed = readMapText(text, draft.name || file.replace(/\.[^.]+$/, ''), draft.city || CITY);
          if (!parsed.ok) { p.setError(parsed.error); return; }
          replace(parsed.map.stations, 'from the file');
        }} />
      </div>
      <p className="muted small">A JetLeg map, or plain GeoJSON points from QGIS, geojson.io or a GTFS export.</p>
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
    p.patch({ layers } as Partial<PackMap>, { pending: null, selected: null });
    if (said) p.setNote(said);
  };

  const fetchOne = async (key: string, onWait: (s: number) => void): Promise<string> => {
    if (key === 'transitLines') { const f = await fetchTransitLines(pack.boundary, undefined, onWait); return apply(key, f, `${f.length} transit lines`); }
    if (key === 'coastline') { const f = await fetchCoastline(pack.boundary, undefined, onWait); return apply(key, f, `${f.length} stretches of coastline`); }
    const got = await fetchPois(key, pack.boundary, undefined, onWait);
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
        <button className="primary" disabled={!!p.busy} onClick={() => runTool(p, 'Fetching every category from OpenStreetMap', async (w) => {
          const all = await fetchAllPois(pack.boundary, undefined, w);
          const lines = Object.entries(all).map(([key, got]) => { apply(key, got.features, ''); return `${LAYER_DEFS.find((d) => d.key === key)?.label ?? key} ${got.features.length}`; });
          commit(`Fetched ${lines.length} categories. ${lines.join(' · ')}`);
        })}>
          Fetch every category from OpenStreetMap
        </button>
        <p className="muted small">One request to a free, shared service; a large city can take a minute. Review each list afterwards — the file you publish is the ruling.</p>
        <ul className="list layeraudit">
          {audit.map((a) => (
            <li key={a.key}>
              <button className="link grow" onClick={() => p.onChange({ ...editor, layerKey: a.key, showCells: false, pending: null, selected: null })}>
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
      <button className="link" onClick={() => p.onChange({ ...editor, layerKey: null, pending: null, selected: null })}>← All categories</button>
      <h3>{def.label} <span className="muted">· {features.length}</span></h3>
      {def.key === 'railStations' && (
        <p className="muted small">Filled in automatically from the stations that are not bus-only. Import your own to override that.</p>
      )}
      {def.kind === 'point'
        ? <p className="muted small">Shown on the map. Tap the map to add one; tap one to rename or remove it.</p>
        : <p className="muted small">A line layer: distance is measured to the nearest point on the line. Lines can be fetched or imported, not drawn.</p>}

      {editor.pending && def.kind === 'point' && (
        <div className="hint fact">
          <div className="row">
            <input type="text" className="grow" autoFocus value={name} maxLength={80} placeholder={`Name of the ${def.label.toLowerCase().replace(/s$/, '')}`} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPlace()} />
            <button className="primary" disabled={!name.trim()} onClick={addPlace}>Add</button>
            <button onClick={() => p.onChange({ ...editor, pending: null })}>Cancel</button>
          </div>
        </div>
      )}
      {selected && (
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
          <button disabled={!!p.busy} onClick={() => runTool(p, `Fetching ${def.label.toLowerCase()}`, async (w) => commit(`${def.label}: ${await fetchOne(def.key, w)}.`))}>
            Fetch from OpenStreetMap
          </button>
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

  const rebuild = () => {
    p.setError(null);
    p.setBusy('Building Voronoi cells…');
    // Deferred a frame so the status paints before the work blocks the thread.
    setTimeout(() => {
      const started = performance.now();
      const done = finalizePack(pack);
      p.onChange({ ...editor, draft: done.pack, cellsStale: false });
      const total = Object.values(done.pack.voronoi).reduce((n, c) => n + c.length, 0);
      p.setNote(`${total.toLocaleString()} cells across ${Object.keys(done.pack.voronoi).length} categories, in ${((performance.now() - started) / 1000).toFixed(1)} s.${done.notes.length ? ' ' + done.notes.join(' ') : ''}`);
      p.setBusy(null);
    }, 30);
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
      <button className="primary" disabled={!!p.busy} onClick={rebuild}>Build all cells</button>

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
