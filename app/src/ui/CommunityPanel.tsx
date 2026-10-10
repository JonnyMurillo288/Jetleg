import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../sync/client';
import type { Account } from '../community/account';
import type { ActiveMap } from '../community/active';
import {
  deleteComment,
  deleteMap,
  getMap,
  getVersionContent,
  listMaps,
  postComment,
  react,
  type Comment,
  type MapDetail,
  type MapSummary,
  type Sort,
  type VersionSummary,
} from '../community/api';
import { CITY } from '../community/board';
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
};

const when = (iso: string) => new Date(iso).toLocaleDateString();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Community maps: browse what others have published, look at one on the
 * map, play on it, branch it into your own, and say what you think of it.
 */
export function CommunityPanel(props: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
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
        onOpen={setOpenId}
        onBack={() => { props.onPreview(null); setOpenId(null); }}
        onEdit={props.onEdit}
      />
    );
  }
  return <Browse {...props} onOpen={setOpenId} />;
}

function Browse(props: Props & { onOpen: (id: string) => void }) {
  const { active, roundActive } = props;
  const [sort, setSort] = useState<Sort>('top');
  const [maps, setMaps] = useState<MapSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setMaps(null);
    setError(null);
    listMaps(sort).then((res) => {
      if (cancelled) return;
      if (res.ok) setMaps(res.value);
      else setError(res.error);
    });
    return () => { cancelled = true; };
  }, [sort]);

  const openFile = async (f: File) => {
    const parsed = readMapText(await f.text(), f.name.replace(/(\.jetleg-map)?\.[^.]+$/, ''), CITY);
    if (!parsed.ok) { setError(parsed.error); return; }
    props.onEdit(parsed.map, { type: 'new' });
  };

  return (
    <div className="pad community">
      <h2>Community maps</h2>
      <p className="muted">
        Play on a map someone else made, branch it into your own, or build one from scratch — a new
        set of stations for San Francisco, or a whole other city.
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

      <h3>Make a map</h3>
      <div className="row">
        <button className="primary" onClick={() => props.onNew('city')}>New city</button>
        <button onClick={() => props.onNew('stations')}>New stations for San Francisco</button>
        <button onClick={() => props.onNew('sf-pack')}>Open the San Francisco board</button>
        <button onClick={() => fileRef.current?.click()}>Open a map file</button>
        <input ref={fileRef} type="file" accept=".json,.geojson,application/json,application/geo+json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openFile(f); }} />
      </div>
      <p className="muted small">
        “New city” gives you the tools the San Francisco board was built with: set a boundary, pull
        stations and places from OpenStreetMap or your own files, and build the Voronoi cells.
      </p>

      {!supabase ? (
        <p className="muted small">
          This build has no server configured, so there is nothing to browse — but you can still
          make a map, save it as a file and play on it.
        </p>
      ) : (
        <>
          <div className="row listhead">
            <h3 className="grow">Published</h3>
            <div className="seg">
              <button className={sort === 'top' ? 'on' : ''} onClick={() => setSort('top')}>Top</button>
              <button className={sort === 'new' ? 'on' : ''} onClick={() => setSort('new')}>New</button>
            </div>
          </div>
          {error && <p className="warntext">{error}</p>}
          {!maps && !error && <p className="muted small">Loading…</p>}
          {maps?.length === 0 && <p className="muted">Nothing published yet. Yours could be the first.</p>}
          <ul className="list maps">
            {maps?.map((m) => (
              <li key={m.id}>
                <button className="link grow" onClick={() => props.onOpen(m.id)}>
                  <b>{m.name}</b>
                  {active?.mapId === m.id && <span className="tag good">playing</span>}
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

      <Thread mapId={map.id} comments={detail.comments} account={account} signedIn={signedIn} onChanged={load} />
    </div>
  );
}

function Thread(props: { mapId: string; comments: Comment[]; account: Account; signedIn: boolean; onChanged: () => Promise<void> }) {
  const { comments, account, signedIn } = props;
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const myId = account.state === 'signedIn' ? account.userId : null;

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

  const roots = comments.filter((c) => !c.parentId);
  const repliesTo = (id: string) => comments.filter((c) => c.parentId === id);

  const one = (c: Comment, isReply: boolean) => (
    <div key={c.id} className={`comment ${isReply ? 'reply' : ''}`}>
      <div className="small">
        <b>{c.authorName}</b> <span className="muted">· {when(c.createdAt)}</span>
      </div>
      <p>{c.body}</p>
      <div className="small">
        {signedIn && !isReply && <button className="link" onClick={() => { setReplyTo(c.id); setReplyBody(''); }}>Reply</button>}
        {myId === c.authorId && <button className="link danger" onClick={() => remove(c)}>Delete</button>}
      </div>
    </div>
  );

  return (
    <>
      <h3>Discussion <span className="muted">· {comments.length}</span></h3>
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
        </div>
      ) : null}
      {error && <p className="warntext">{error}</p>}
      <AccountBox account={account} reason="Sign in to like, dislike or comment." />
    </>
  );
}
