import { useMemo, useRef, useState } from 'react';
import type { GameData } from '../data/load';
import type { GameSize, LngLat } from '../engine/types';
import { CITY, checkMap } from '../community/board';
import {
  MAP_FILE_SUFFIX,
  MAX_STATIONS,
  MIN_STATIONS,
  describeDiff,
  diffStations,
  parseMapFile,
  readMapText,
  serializeMap,
  slugId,
  type MapFile,
  type MapStation,
} from '../community/format';
import { publishMap, publishVersion } from '../community/api';
import type { Account } from '../community/account';
import { AccountBox } from './AccountBox';

/**
 * What the draft will become when published: a map of its own, the next
 * version of one the author already has, or a branch of someone else's.
 */
export type EditorTarget =
  | { type: 'new' }
  | { type: 'version'; mapId: string }
  | { type: 'branch'; parentVersionId: string; parentName: string };

export type EditorState = {
  draft: MapFile;
  /** What the draft started from, to say what changed. */
  original: MapStation[];
  target: EditorTarget;
  /** A map tap waiting for a name before it becomes a station. */
  pending: LngLat | null;
  selectedId: string | null;
};

/** A tap on empty map proposes a station there; a tap on a station selects it. */
export function editorTap(editor: EditorState, ll: LngLat, stationId?: string): EditorState {
  return stationId
    ? { ...editor, selectedId: stationId, pending: null }
    : { ...editor, pending: ll, selectedId: null };
}

export function downloadMap(map: MapFile): void {
  const blob = new Blob([serializeMap(map)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slugId(map.name)}${MAP_FILE_SUFFIX}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * The map editor. The draft *is* the board while this is open — every change
 * redraws the real zones on the real map, so what is published is exactly
 * what was on screen.
 */
export function MapEditor(props: {
  editor: EditorState;
  onChange: (e: EditorState) => void;
  /** Leave the editor, discarding the draft. */
  onClose: () => void;
  /** Play on the draft as it stands, without publishing it. */
  onPlay: (map: MapFile) => void;
  onPublished: (mapId: string) => void;
  base: GameData;
  account: Account;
}) {
  const { editor, onChange, base, account } = props;
  const { draft } = editor;
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingName, setPendingName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<MapFile>) => onChange({ ...editor, draft: { ...draft, ...patch } });
  const problems = useMemo(() => checkMap(draft, base.boundary), [draft, base.boundary]);
  const blocking = problems.some((p) => p.blocking);
  const changes = useMemo(() => describeDiff(diffStations(editor.original, draft.stations)), [editor.original, draft.stations]);
  const selected = draft.stations.find((s) => s.id === editor.selectedId) ?? null;

  const addPending = () => {
    const name = pendingName.trim();
    if (!editor.pending || !name) return;
    const used = new Set(draft.stations.map((s) => s.id));
    const baseId = slugId(name);
    let id = baseId;
    for (let n = 2; used.has(id); n++) id = `${baseId}${n}`;
    const station: MapStation = {
      id, name,
      lon: Math.round(editor.pending[0] * 1e6) / 1e6,
      lat: Math.round(editor.pending[1] * 1e6) / 1e6,
      modes: ['bus'], routes: [],
    };
    onChange({ ...editor, draft: { ...draft, stations: [...draft.stations, station] }, pending: null, selectedId: id });
    setPendingName('');
  };

  const rename = (name: string) => {
    if (!selected) return;
    onChange({ ...editor, draft: { ...draft, stations: draft.stations.map((s) => (s.id === selected.id ? { ...s, name } : s)) } });
  };
  const remove = () => {
    if (!selected) return;
    onChange({ ...editor, draft: { ...draft, stations: draft.stations.filter((s) => s.id !== selected.id) }, selectedId: null });
  };

  const importFile = async (f: File) => {
    setError(null);
    const parsed = readMapText(await f.text(), draft.name || f.name.replace(/\.[^.]+$/, ''), CITY);
    if (!parsed.ok) { setError(parsed.error); return; }
    // The file supplies the stations; the name, description and rules being
    // edited stay, unless the draft has none yet.
    onChange({
      ...editor,
      draft: {
        ...draft,
        name: draft.name || parsed.map.name,
        description: draft.description || parsed.map.description,
        rules: { ...parsed.map.rules, ...draft.rules },
        stations: parsed.map.stations,
      },
      pending: null,
      selectedId: null,
    });
  };

  // One last pass through the same validator every reader uses, so nothing
  // can be published that would not load.
  const finished = (): MapFile | null => {
    const parsed = parseMapFile(JSON.parse(serializeMap(draft)));
    if (!parsed.ok) { setError(parsed.error); return null; }
    if (blocking) { setError('Fix the problems above first.'); return null; }
    return parsed.map;
  };

  const publish = async () => {
    const map = finished();
    if (!map) return;
    setBusy(true);
    setError(null);
    const t = editor.target;
    const res = t.type === 'version'
      ? await publishVersion(t.mapId, map, message).then((r) => (r.ok ? { ok: true as const, value: t.mapId } : r))
      : await publishMap(map, message, t.type === 'branch' ? t.parentVersionId : undefined);
    setBusy(false);
    if (res.ok) props.onPublished(res.value);
    else setError(res.error);
  };

  const count = draft.stations.length;
  const publishLabel = editor.target.type === 'version' ? 'Publish new version'
    : editor.target.type === 'branch' ? 'Publish branch' : 'Publish map';
  const canPublish = account.state === 'signedIn' && !!account.displayName;

  return (
    <div className="pad community editor">
      <button className="link" onClick={() => confirm('Discard this draft?') && props.onClose()}>← Discard draft</button>
      <h2>
        {editor.target.type === 'version' ? 'New version' : editor.target.type === 'branch' ? 'New branch' : 'New map'}
      </h2>
      {editor.target.type === 'branch' && (
        <p className="muted small">Branching from “{editor.target.parentName}”. Your branch stays linked to it.</p>
      )}

      <label className="field">
        <span>Name</span>
        <input type="text" value={draft.name} maxLength={80} placeholder="e.g. Downtown only" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea value={draft.description} maxLength={2000} rows={3} placeholder="Who is this map for? What makes it different?" onChange={(e) => set({ description: e.target.value })} />
      </label>

      <h3>House rules</h3>
      <div className="row">
        <span className="grow">Game size</span>
        <div className="seg">
          {(['small', 'medium', 'large'] as GameSize[]).map((size) => (
            <button key={size} className={draft.rules.gameSize === size ? 'on' : ''} onClick={() => set({ rules: { ...draft.rules, gameSize: size } })}>
              {size}
            </button>
          ))}
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={!!draft.rules.supervisorDistrictsAsAdmin4}
          onChange={(e) => set({ rules: { ...draft.rules, supervisorDistrictsAsAdmin4: e.target.checked } })}
        />
        <span>Supervisor districts count as the 4th administrative division</span>
      </label>

      <h3>Stations <span className="muted">· {count}</span></h3>
      <p className="muted small">
        Tap the map to add a station; tap a station to rename or remove it. Each one is a hiding zone.
        {editor.original.length > 0 && <> So far: {changes}.</>}
      </p>

      {editor.pending && (
        <div className="hint fact">
          <p className="small">New station at {editor.pending[1].toFixed(5)}, {editor.pending[0].toFixed(5)}</p>
          <div className="row">
            <input type="text" className="grow" autoFocus value={pendingName} maxLength={80} placeholder="Station name" onChange={(e) => setPendingName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPending()} />
            <button className="primary" disabled={!pendingName.trim() || count >= MAX_STATIONS} onClick={addPending}>Add</button>
            <button onClick={() => onChange({ ...editor, pending: null })}>Cancel</button>
          </div>
        </div>
      )}

      {selected && (
        <div className="hint fact">
          <div className="row">
            <input type="text" className="grow" value={selected.name} maxLength={80} onChange={(e) => rename(e.target.value)} />
            <button className="link danger" disabled={count <= MIN_STATIONS} onClick={remove}>Remove</button>
            <button onClick={() => onChange({ ...editor, selectedId: null })}>Done</button>
          </div>
        </div>
      )}

      {problems.map((p) => (
        <p key={p.text} className={`hint ${p.blocking ? 'warn' : ''} small`}>{p.blocking ? 'Can’t be played: ' : 'Worth a look: '}{p.text}</p>
      ))}

      <div className="row">
        <button onClick={() => fileRef.current?.click()}>Replace stations from a file</button>
        <button onClick={() => { const m = finished(); if (m) downloadMap(m); }}>Download file</button>
        <input ref={fileRef} type="file" accept=".json,.geojson,application/json,application/geo+json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />
      </div>
      <p className="muted small">A file can be a JetLeg map, or plain GeoJSON points from QGIS or geojson.io.</p>

      <h3>Publish</h3>
      {canPublish ? (
        <>
          <label className="field">
            <span>What changed <span className="muted">(optional)</span></span>
            <input type="text" value={message} maxLength={200} placeholder={editor.target.type === 'new' ? 'First version' : changes} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button className="primary big" disabled={busy || blocking || !draft.name.trim()} onClick={publish}>
            {busy ? 'Publishing…' : publishLabel}
          </button>
        </>
      ) : (
        <AccountBox account={account} reason="Publishing a map puts your name on it, so it needs you signed in." />
      )}
      <button className="big" disabled={blocking || !draft.name.trim()} onClick={() => { const m = finished(); if (m) props.onPlay(m); }}>
        Play on it without publishing
      </button>
      {error && <p className="warntext">{error}</p>}
    </div>
  );
}
