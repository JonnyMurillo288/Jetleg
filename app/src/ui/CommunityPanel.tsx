import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { supabase } from '../sync/client';
import type { Account } from '../community/account';
import type { ActiveMap } from '../community/active';
import {
  amModerator,
  deleteComment,
  deleteMap,
  getMap,
  getVersionContent,
  listMaps,
  moderate,
  postComment,
  react,
  report,
  searchMaps,
  voteOnComment,
  type Comment,
  type MapDetail,
  type MapSummary,
  type Result,
  type SearchHits,
  type Sort,
  type VersionSummary,
} from '../community/api';
import { CITY } from '../community/board';
import { searchTerm } from '../community/search';
import { describeDiff, diffStations, readMapText, type MapFile } from '../community/format';
import { downloadMap, type EditorTarget } from '../studio/Editor';
import { AccountBox } from './AccountBox';

/** What a new map starts from. */
export type NewMapKind = 'stations' | 'city' | 'sf-pack';

type Props = {
  account: Account;
  active: ActiveMap | null;
  /** Stations on the board in play, for the "playing on" line. */
  activeStations: number;
  /** Choose a board and go and play on it. Resolves to an error message, if any. */
  onPlay: (a: ActiveMap) => Promise<string | null>;
  onBuiltIn: () => void;
  onNew: (kind: NewMapKind) => void;
  onEdit: (draft: MapFile, target: EditorTarget) => void;
  /** Show a map on the studio's map while its page is open; null puts the default back. */
  onPreview: (map: MapFile | null) => void;
  /** A round in progress pins the board: changing it mid-round would re-score it. */
  roundActive: boolean;
  /** The map whose page is open, from the address; null for the list. */
  openId: string | null;
  /** Open a map's page, or (null) go back to the list. */
  onOpen: (id: string | null) => void;
  /** Lead with the tools for making a map, rather than with what is published. */
  create: boolean;
};

const when = (iso: string) => new Date(iso).toLocaleDateString();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Community maps: browse what others have published, look at one on the
 * map, play on it, branch it into your own, and say what you think of it.
 */
export function CommunityPanel(props: Props) {
  const { openId } = props;
  if (openId) {
    return (
      <MapPage
        key={openId}
        id={openId}
        account={props.account}
        active={props.active}
        roundActive={props.roundActive}
        onPlay={props.onPlay}
        onPreview={props.onPreview}
        onOpen={props.onOpen}
        onBack={() => props.onOpen(null)}
        onEdit={props.onEdit}
      />
    );
  }
  return <Browse {...props} />;
}

type View = Sort | 'search';
type Person = { authorId: string; authorName: string };

function Browse(props: Props) {
  const { active, roundActive } = props;
  const [view, setView] = useState<View>('top');
  const [maps, setMaps] = useState<MapSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // Search: what has been searched for (Enter), or the person picked from the drop-down.
  const [searched, setSearched] = useState('');
  const [person, setPerson] = useState<Person | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [isMod, setIsMod] = useState(false);
  const who = props.account.state === 'signedIn' ? props.account.userId : props.account.state;
  useEffect(() => {
    let cancelled = false;
    if (props.account.state === 'signedIn') amModerator().then((m) => { if (!cancelled) setIsMod(m); });
    else setIsMod(false);
    return () => { cancelled = true; };
  }, [who]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setMaps(null);
    setError(null);
    const load: Promise<Result<MapSummary[]>> | null =
      view !== 'search' ? listMaps(view)
      : person ? listMaps('top', undefined, person.authorId)
      : searchTerm(searched).length >= 2 ? searchMaps(searched, 50).then((r) => (r.ok ? { ok: true as const, value: r.value.maps } : r))
      : null;
    if (!load) { setMaps([]); return; }
    load.then((res) => {
      if (cancelled) return;
      if (res.ok) setMaps(res.value);
      else setError(res.error);
    });
    return () => { cancelled = true; };
  }, [view, searched, person]);

  const openFile = async (f: File) => {
    const parsed = readMapText(await f.text(), f.name.replace(/(\.jetleg-map)?\.[^.]+$/, ''), CITY);
    if (!parsed.ok) { setError(parsed.error); return; }
    props.onEdit(parsed.map, { type: 'new' });
  };

  // The create page shows every way to start; the community page leads with
  // the two most people want and keeps the San Francisco ones a tap away.
  const sfStarts = (
    <>
      <button onClick={() => props.onNew('stations')}>New stations for San Francisco</button>
      <button onClick={() => props.onNew('sf-pack')}>Open the San Francisco board</button>
    </>
  );

  return (
    <div className="pad community">
      <h2>{props.create ? 'Create a map' : 'Community maps'}</h2>
      {isMod && !props.create && <p className="small"><a href="#/moderation">Moderation queue →</a></p>}
      <p className="muted">
        {props.create
          ? 'Build a board from scratch — a new set of stations for San Francisco, or a whole other city — then play on it, save it as a file, or publish it.'
          : 'Play on a map someone else made, branch it into your own, or build one from scratch.'}
      </p>

      <div className="boardnow">
        <span className="muted small">Playing on</span>
        <strong>{active ? active.map.name : 'Built-in San Francisco board'}</strong>
        <span className="muted small">
          {plural(props.activeStations, 'station')}
          {active && !active.mapId && ' · not published'}
        </span>
        {active && (
          <button className="link" disabled={roundActive} onClick={props.onBuiltIn}>
            Back to the built-in board
          </button>
        )}
        {roundActive && <span className="muted small">End your round to change boards.</span>}
      </div>

      <div className="row makerow">
        <button className="primary" onClick={() => props.onNew('city')}>New city</button>
        <button onClick={() => fileRef.current?.click()}>Import map file</button>
        {props.create ? sfStarts : (
          <button className="link" aria-expanded={more} onClick={() => setMore(!more)}>More {more ? '▴' : '▾'}</button>
        )}
        <input ref={fileRef} type="file" accept=".json,.geojson,application/json,application/geo+json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openFile(f); }} />
      </div>
      {more && !props.create && <div className="row">{sfStarts}</div>}
      <p className="muted small">
        “New city” sets a boundary, pulls stations and places from OpenStreetMap or your own files, and builds
        the Voronoi cells. “Import map file” opens a map someone sent you, or GeoJSON points.
      </p>

      {props.create ? (
        <p className="small"><a href="#/maps">Explore the maps other people have published →</a></p>
      ) : !supabase ? (
        <p className="muted small">
          This build has no server configured, so there is nothing to browse — but you can still
          make a map, save it as a file and play on it.
        </p>
      ) : (
        <>
          <div className="row listhead">
            <h3 className="grow">Published</h3>
            <div className="seg">
              {(['top', 'new', 'search'] as View[]).map((v) => (
                <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
                  {v === 'top' ? 'Top' : v === 'new' ? 'New' : 'Search'}
                </button>
              ))}
            </div>
          </div>
          {view === 'search' && (
            <SearchBox
              initial={searched}
              onOpen={props.onOpen}
              onSearch={(q) => { setPerson(null); setSearched(q); }}
              onPerson={(p) => { setPerson(p); setSearched(''); }}
            />
          )}
          {view === 'search' && person && (
            <p className="small">
              Maps by <b>{person.authorName}</b>{' '}
              <button className="link" onClick={() => setPerson(null)}>✕ Clear</button>
            </p>
          )}
          {error && <p className="warntext">{error}</p>}
          {!maps && !error && <p className="muted small">Loading…</p>}
          {maps?.length === 0 && (
            <p className="muted">
              {view !== 'search' ? 'Nothing published yet. Yours could be the first.'
                : person || searchTerm(searched).length >= 2 ? 'No maps match that.'
                : 'Type a map’s name or the name of the person who made it.'}
            </p>
          )}
          <ul className="list maps">
            {maps?.map((m) => (
              <li key={m.id}>
                <button className="link grow" onClick={() => props.onOpen(m.id)}>
                  <b>{m.name}</b>
                  {active?.mapId === m.id && <span className="tag good">playing</span>}
                  {m.hiddenAt && <span className="tag warn">hidden</span>}
                  <span className="muted small maprow">
                    by {m.authorName} · {m.kind === 'pack' ? `${m.city} · full city` : 'San Francisco'} · {plural(m.stationCount, 'station')}
                    {m.parentMapName && ' · a branch'}
                  </span>
                  <span className="muted small maprow">
                    ▲ {m.likeCount} · ▼ {m.dislikeCount} · {plural(m.commentCount, 'comment')} · {plural(m.branchCount, 'branch', 'branches')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <AccountBox account={props.account} reason="Sign in to publish maps, like them and join the discussion." />
        </>
      )}
    </div>
  );
}

/**
 * The search box: suggestions drop down as you type — maps (by their name or
 * their author's) and people. Picking a map opens it; picking a person lists
 * their maps; Enter lists every match. Arrow keys and Escape work as in any
 * combobox.
 */
function SearchBox(props: {
  initial: string;
  onOpen: (id: string) => void;
  onSearch: (q: string) => void;
  onPerson: (p: Person) => void;
}) {
  const [q, setQ] = useState(props.initial);
  const [hits, setHits] = useState<SearchHits | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(-1);
  const seq = useRef(0);

  // Debounced, and only the newest answer is shown: a slow reply to "pa"
  // must not replace the one for "park".
  useEffect(() => {
    const term = searchTerm(q);
    if (term.length < 2) { setHits(null); setLoading(false); return; }
    setLoading(true);
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const res = await searchMaps(term);
      if (mine !== seq.current) return;
      setLoading(false);
      setHits(res.ok ? res.value : { maps: [], people: [] });
      setHi(-1);
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  type Option = { key: string; pick: () => void; body: ReactNode };
  const options: Option[] = [
    ...(hits?.maps ?? []).map((m): Option => ({
      key: `m-${m.id}`,
      pick: () => props.onOpen(m.id),
      body: <><b>{m.name}</b><span className="muted small"> by {m.authorName} · {m.kind === 'pack' ? m.city : 'San Francisco'}</span></>,
    })),
    ...(hits?.people ?? []).map((p): Option => ({
      key: `p-${p.authorId}`,
      pick: () => { props.onPerson(p); setOpen(false); },
      body: <><span className="who" aria-hidden="true">👤</span><b>{p.authorName}</b><span className="muted small"> · {plural(p.mapCount, 'map')}</span></>,
    })),
  ];
  const nMaps = hits?.maps.length ?? 0;
  const showing = open && searchTerm(q).length >= 2;

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(options.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
    else if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (showing && hi >= 0 && options[hi]) options[hi].pick();
      else { props.onSearch(q); setOpen(false); }
    }
  };

  return (
    <div className="searchbox">
      <input type="search" value={q} autoFocus placeholder="Search maps or people" aria-label="Search maps or people"
        role="combobox" aria-expanded={showing} aria-controls="search-options" aria-autocomplete="list"
        aria-activedescendant={showing && hi >= 0 ? `opt-${options[hi]?.key}` : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        // Late enough for a tap on an option to land first.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey} />
      {showing && (
        <ul className="dropdown" id="search-options" role="listbox">
          {loading && !hits && <li className="muted small dropnote">Searching…</li>}
          {hits && options.length === 0 && <li className="muted small dropnote">No maps or people match “{searchTerm(q)}”.</li>}
          {options.map((o, i) => (
            <li key={o.key}>
              {i === 0 && nMaps > 0 && <div className="drophead">Maps</div>}
              {i === nMaps && <div className="drophead">People</div>}
              <button id={`opt-${o.key}`} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''}
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={o.pick}>
                {o.body}
              </button>
            </li>
          ))}
          {hits && nMaps > 0 && (
            <li><button className="dropall" onMouseDown={(e) => e.preventDefault()} onClick={() => { props.onSearch(q); setOpen(false); }}>
              See every match for “{searchTerm(q)}”
            </button></li>
          )}
        </ul>
      )}
    </div>
  );
}

function MapPage(props: {
  id: string;
  account: Account;
  active: ActiveMap | null;
  roundActive: boolean;
  onPlay: Props['onPlay'];
  onPreview: Props['onPreview'];
  onOpen: (id: string) => void;
  onBack: () => void;
  onEdit: (draft: MapFile, target: EditorTarget) => void;
}) {
  const { id, account, active, roundActive } = props;
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await getMap(id);
    if (res.ok) { setDetail(res.value); setError(null); } else setError(res.error);
  }, [id]);
  // Reloaded when the account changes: "my reaction" and the author-only
  // controls depend on who is asking.
  const who = account.state === 'signedIn' ? account.userId : account.state;
  useEffect(() => { load(); }, [load, who]);
  const [isMod, setIsMod] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (account.state === 'signedIn') amModerator().then((m) => { if (!cancelled) setIsMod(m); });
    else setIsMod(false);
    return () => { cancelled = true; };
  }, [who]); // eslint-disable-line react-hooks/exhaustive-deps

  // Put the map itself on the studio's map — a page of text about a board
  // is a poor way to judge it.
  const headVersionId = detail?.map.headVersionId ?? null;
  const { onPreview } = props;
  useEffect(() => {
    if (!headVersionId) return;
    let cancelled = false;
    getVersionContent(headVersionId).then((res) => { if (!cancelled && res.ok) onPreview(res.value); });
    return () => { cancelled = true; };
  }, [headVersionId, onPreview]);

  if (error && !detail) {
    return (
      <div className="pad community">
        <button className="link" onClick={props.onBack}>← All maps</button>
        <p className="warntext">{error}</p>
      </div>
    );
  }
  if (!detail) return <div className="pad community"><p className="muted small">Loading…</p></div>;

  const { map } = detail;
  const signedIn = account.state === 'signedIn' && !!account.displayName;
  const mine = account.state === 'signedIn' && account.userId === map.authorId;
  const playing = active?.mapId === map.id;

  /** Runs one action against a version's content, reporting failure in place. */
  const withContent = async (versionId: string | null, then: (m: MapFile) => void | Promise<void>) => {
    if (!versionId) { setNote('This map has no version to load.'); return; }
    setBusy(true);
    setNote(null);
    const res = await getVersionContent(versionId);
    setBusy(false);
    if (!res.ok) { setNote(res.error); return; }
    await then(res.value);
  };

  const play = (v: { id: string } | null) =>
    withContent(v?.id ?? map.headVersionId, async (m) => {
      const err = await props.onPlay({ mapId: map.id, versionId: v?.id ?? map.headVersionId, map: m });
      if (err) setNote(err);
    });

  const branch = (v: VersionSummary | null) =>
    withContent(v?.id ?? map.headVersionId, (m) =>
      props.onEdit({ ...m, name: `${m.name} (branch)` }, { type: 'branch', parentVersionId: (v?.id ?? map.headVersionId)!, parentName: map.name }));

  const setReaction = async (value: 1 | -1) => {
    const res = await react(map.id, detail.myReaction === value ? 0 : value);
    if (!res.ok) setNote(res.error);
    await load();
  };

  /** What a version changed, against the one before it — or, for a branch's first, against what it branched from. */
  const showChanges = async (v: VersionSummary) => {
    const previous = detail.versions.find((x) => x.seq === v.seq - 1)?.id ?? (v.seq === 1 ? map.parentVersionId : null);
    if (!previous) { setDiffs((d) => ({ ...d, [v.id]: `${plural(v.stationCount, 'station')} to start with` })); return; }
    const [now, before] = await Promise.all([getVersionContent(v.id), getVersionContent(previous)]);
    setDiffs((d) => ({
      ...d,
      [v.id]: now.ok && before.ok ? describeDiff(diffStations(before.value.stations, now.value.stations)) : 'Could not load the comparison.',
    }));
  };

  return (
    <div className="pad community">
      <button className="link" onClick={props.onBack}>← All maps</button>
      <h2>{map.name}</h2>
      <p className="muted small">
        by {map.authorName} · {map.kind === 'pack' ? `${map.city} · full city` : 'San Francisco stations'} · {plural(map.stationCount, 'station')} · updated {when(map.updatedAt)}
        {playing && <span className="tag good">playing</span>}
      </p>
      {map.parentMapName && (
        <p className="small">
          Branched from{' '}
          {detail.parent
            ? <button className="link" onClick={() => props.onOpen(detail.parent!.id)}>{detail.parent.name} by {detail.parent.authorName}</button>
            : `“${map.parentMapName}”, which has since been deleted`}
        </p>
      )}
      {map.description && <p className="description">{map.description}</p>}
      {map.kind === 'pack' && (
        <p className="muted small">
          Places, stops and lines from{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>,
          under the Open Database License, as chosen and edited by {map.authorName}.
        </p>
      )}
      {map.hiddenAt && (
        <p className="hint warn small">
          Hidden from everyone else: {map.hiddenReason ?? 'by a moderator.'}{' '}
          {mine ? 'You can still see it, play it and download it.' : 'Only its author and moderators can see it.'}
        </p>
      )}

      <div className="row reactions">
        <button className={detail.myReaction === 1 ? 'on' : ''} disabled={!signedIn} aria-pressed={detail.myReaction === 1} onClick={() => setReaction(1)}>
          ▲ Like · {map.likeCount}
        </button>
        <button className={detail.myReaction === -1 ? 'on' : ''} disabled={!signedIn} aria-pressed={detail.myReaction === -1} onClick={() => setReaction(-1)}>
          ▼ Dislike · {map.dislikeCount}
        </button>
      </div>

      <button className="primary big" disabled={busy || roundActive} onClick={() => play(null)}>
        {playing && active?.versionId === map.headVersionId ? 'Playing on this map' : 'Play on this map'}
      </button>
      {roundActive && <p className="muted small">End your round to change boards.</p>}
      <div className="row">
        <button disabled={busy} onClick={() => branch(null)}>Branch it</button>
        <button disabled={busy} onClick={() => withContent(map.headVersionId, downloadMap)}>Download file</button>
        {mine && (
          <button disabled={busy} onClick={() => withContent(map.headVersionId, (m) => props.onEdit(m, { type: 'version', mapId: map.id }))}>
            New version
          </button>
        )}
        {mine && (
          <button
            className="link danger"
            onClick={async () => {
              if (!confirm(`Delete “${map.name}” and its discussion? Branches of it stay.`)) return;
              const res = await deleteMap(map.id);
              if (res.ok) props.onBack(); else setNote(res.error);
            }}
          >
            Delete
          </button>
        )}
        {signedIn && !mine && !map.hiddenAt && (
          <button className="link" onClick={async () => {
            const reason = prompt('What is wrong with this map? A moderator will read this. Maps reported by three people are hidden until a moderator looks.');
            if (!reason?.trim()) return;
            const res = await report(map.id, reason);
            setNote(res.ok ? (res.value.hidden ? 'Thanks. The map is hidden until a moderator looks at it.' : 'Thanks — a moderator will look at it.') : res.error);
            if (res.ok && res.value.hidden) await load();
          }}>Report</button>
        )}
        {isMod && (
          <button className="link danger" onClick={async () => {
            const res = await moderate(map.id, !map.hiddenAt);
            setNote(res.ok ? (map.hiddenAt ? 'Restored: everyone can see it again.' : 'Hidden from everyone but its author.') : res.error);
            await load();
          }}>{map.hiddenAt ? 'Restore (moderator)' : 'Hide (moderator)'}</button>
        )}
      </div>
      {note && <p className="small notice">{note}</p>}

      <h3>History <span className="muted">· {plural(detail.versions.length, 'version')}</span></h3>
      <ul className="list versions">
        {detail.versions.map((v) => (
          <li key={v.id}>
            <div className="grow">
              <div>
                <b>v{v.seq}</b> {v.message || <span className="muted">No note</span>}
                {active?.versionId === v.id && <span className="tag good">playing</span>}
              </div>
              <div className="muted small">
                {when(v.createdAt)} · {plural(v.stationCount, 'station')}
                {diffs[v.id] && <> · {diffs[v.id]}</>}
              </div>
            </div>
            {!diffs[v.id] && <button className="link" onClick={() => showChanges(v)}>Changes</button>}
            {v.id !== map.headVersionId && (
              <>
                <button className="link" disabled={busy || roundActive} onClick={() => play(v)}>Play</button>
                <button className="link" disabled={busy} onClick={() => branch(v)}>Branch</button>
              </>
            )}
          </li>
        ))}
      </ul>

      <h3>Branches <span className="muted">· {detail.branches.length}</span></h3>
      {detail.branches.length === 0 ? (
        <p className="muted small">Nobody has branched this map yet.</p>
      ) : (
        <ul className="list maps">
          {detail.branches.map((b) => (
            <li key={b.id}>
              <button className="link grow" onClick={() => props.onOpen(b.id)}>
                <b>{b.name}</b>
                <span className="muted small maprow">by {b.authorName} · {plural(b.stationCount, 'station')} · ▲ {b.likeCount}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Thread mapId={map.id} comments={detail.comments} myVotes={detail.myVotes} account={account} signedIn={signedIn} isMod={isMod} onChanged={load} />
    </div>
  );
}

function Thread(props: {
  mapId: string; comments: Comment[]; myVotes: Record<string, number>; account: Account; signedIn: boolean; isMod: boolean; onChanged: () => Promise<void>;
}) {
  const { comments, account, signedIn } = props;
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A vote shows at once; this holds it until the reload that confirms it.
  const [pending, setPending] = useState<Record<string, number>>({});
  const myId = account.state === 'signedIn' ? account.userId : null;

  // Comments arrive best first. That order is taken when the set of comments
  // changes, not when a score does, so a comment does not slide out from
  // under the finger that just voted on it. The next visit sees the new order.
  const idKey = comments.map((c) => c.id).sort().join();
  const order = useMemo(() => new Map(comments.map((c, i) => [c.id, i])), [idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const byOrder = (a: Comment, b: Comment) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);

  const post = async (text: string, parentId?: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const res = await postComment(props.mapId, text, parentId);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    if (parentId) { setReplyTo(null); setReplyBody(''); } else setBody('');
    await props.onChanged();
  };

  const remove = async (c: Comment) => {
    if (!confirm('Delete this comment?')) return;
    const res = await deleteComment(c.id);
    if (!res.ok) setError(res.error);
    await props.onChanged();
  };

  const flag = async (c: Comment) => {
    const reason = prompt(`What is wrong with ${c.authorName}’s comment? A moderator will read this.`);
    if (!reason?.trim()) return;
    const res = await report(props.mapId, reason, c.id);
    setError(res.ok ? (res.value.hidden ? 'Thanks. The comment is hidden until a moderator looks at it.' : 'Thanks — a moderator will look at it.') : res.error);
    if (res.ok && res.value.hidden) await props.onChanged();
  };
  const toggleHidden = async (c: Comment) => {
    const res = await moderate(props.mapId, !c.hiddenAt, c.id);
    if (!res.ok) setError(res.error);
    await props.onChanged();
  };

  const myVote = (c: Comment) => pending[c.id] ?? props.myVotes[c.id] ?? 0;
  const vote = async (c: Comment, value: 1 | -1) => {
    const next = myVote(c) === value ? 0 : value;
    setError(null);
    setPending((p) => ({ ...p, [c.id]: next }));
    const res = await voteOnComment(c.id, next);
    if (!res.ok) setError(res.error);
    await props.onChanged();
    setPending((p) => { const { [c.id]: _done, ...rest } = p; return rest; });
  };

  const roots = comments.filter((c) => !c.parentId).sort(byOrder);
  const repliesTo = (id: string) => comments.filter((c) => c.parentId === id).sort(byOrder);

  const one = (c: Comment, isReply: boolean) => {
    const mine = myId === c.authorId;
    const v = myVote(c);
    // The server's score already counts my saved vote; swap it for the pending one.
    const score = c.score - (props.myVotes[c.id] ?? 0) + v;
    const why = !signedIn ? 'Sign in to vote' : mine ? 'You can’t vote on your own comment' : undefined;
    return (
      <div key={c.id} className={`comment ${isReply ? 'reply' : ''}`}>
        <div className="votes" title={why}>
          <button className={`vote up ${v === 1 ? 'on' : ''}`} disabled={!signedIn || mine} aria-pressed={v === 1}
            aria-label={`Vote up${v === 1 ? ' (voted)' : ''}`} onClick={() => vote(c, 1)}>▲</button>
          <span className="score" aria-label={`Score ${score}`}>{score}</span>
          <button className={`vote down ${v === -1 ? 'on' : ''}`} disabled={!signedIn || mine} aria-pressed={v === -1}
            aria-label={`Vote down${v === -1 ? ' (voted)' : ''}`} onClick={() => vote(c, -1)}>▼</button>
        </div>
        <div className="grow">
          <div className="small">
            <b>{c.authorName}</b> <span className="muted">· {when(c.createdAt)}</span>
          </div>
          <p>{c.body}</p>
          {c.hiddenAt && <p className="muted small">Hidden from everyone but {mine ? 'you' : 'its author'} and moderators.</p>}
          <div className="small">
            {signedIn && !isReply && <button className="link" onClick={() => { setReplyTo(c.id); setReplyBody(''); }}>Reply</button>}
            {mine && <button className="link danger" onClick={() => remove(c)}>Delete</button>}
            {signedIn && !mine && !c.hiddenAt && <button className="link" onClick={() => flag(c)}>Report</button>}
            {props.isMod && <button className="link danger" onClick={() => toggleHidden(c)}>{c.hiddenAt ? 'Restore' : 'Hide'}</button>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <h3>Discussion <span className="muted">· {comments.length}</span></h3>
      {roots.length > 1 && <p className="muted small">Most up-voted first.</p>}
      {roots.length === 0 && <p className="muted small">No comments yet. What do you like or dislike about this map?</p>}
      {roots.map((c) => (
        <div key={c.id} className="threaditem">
          {one(c, false)}
          {repliesTo(c.id).map((r) => one(r, true))}
          {replyTo === c.id && (
            <div className="row comment reply">
              <input type="text" className="grow" autoFocus value={replyBody} maxLength={2000} placeholder={`Reply to ${c.authorName}`} onChange={(e) => setReplyBody(e.target.value)} />
              <button className="primary" disabled={busy || !replyBody.trim()} onClick={() => post(replyBody, c.id)}>Reply</button>
              <button className="link" onClick={() => setReplyTo(null)}>Cancel</button>
            </div>
          )}
        </div>
      ))}

      {signedIn ? (
        <div className="compose">
          <textarea value={body} maxLength={2000} rows={3} placeholder="What do you like or dislike about this map?" onChange={(e) => setBody(e.target.value)} />
          <button className="primary" disabled={busy || !body.trim()} onClick={() => post(body)}>{busy ? 'Posting…' : 'Comment'}</button>
          <p className="muted small">Comments are public. Keep to the <a href="#/rules">community rules</a>.</p>
        </div>
      ) : null}
      {error && <p className="warntext">{error}</p>}
      <AccountBox account={account} reason="Sign in to like, dislike, vote or comment." />
    </>
  );
}
