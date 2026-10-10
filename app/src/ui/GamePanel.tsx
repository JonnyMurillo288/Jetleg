import { useEffect, useState } from 'react';
import { get as idbGet } from 'idb-keyval';
import { supabase } from '../sync/client';
import { useGame } from '../store/game';
import {
  createGame,
  entitledGameCode,
  gameRoster,
  joinGame,
  leaveGame,
  lookupGame,
  type GameLookup,
  type LocalGame,
  type RosterEntry,
} from '../live/room';
import type { LiveStatus } from '../live/useLiveLocations';
import type { Peer } from '../live/share';

/**
 * The game room: create a game or join one with its code, pick a team, and
 * see who is in it. Being in a game is what turns on live location sharing —
 * seekers send, the hider only watches.
 */
export function GamePanel(props: {
  game: LocalGame | null;
  onGame: (g: LocalGame | null) => void;
  peers: Peer[];
  status: LiveStatus;
  /** Whether this device currently has a position it could share. */
  hasPosition: boolean;
}) {
  if (!supabase) {
    return (
      <div className="pad">
        <h2>Game</h2>
        <p className="muted">
          This build has no game server configured, so there are no shared games. Everything else
          works as before, on this device alone.
        </p>
      </div>
    );
  }
  return props.game
    ? <Room {...props} game={props.game} />
    : <Lobby onGame={props.onGame} />;
}

function Lobby(props: { onGame: (g: LocalGame) => void }) {
  const [name, setName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [code, setCode] = useState('');
  const [fromPass, setFromPass] = useState<string | null>(null);
  const [found, setFound] = useState<GameLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The name this device last played under, if any.
    idbGet<{ displayName?: string }>('sync/profile').then((p) => {
      if (!cancelled && p?.displayName) setName((n) => n || p.displayName!);
    });
    entitledGameCode().then((c) => {
      if (cancelled || !c) return;
      setFromPass(c);
      setCode((cur) => cur || c);
    });
    return () => { cancelled = true; };
  }, []);

  const run = async (work: () => Promise<{ ok: true; value: LocalGame } | { ok: false; error: string }>) => {
    setBusy(true);
    setError(null);
    const res = await work();
    setBusy(false);
    if (res.ok) props.onGame(res.value);
    else setError(res.error);
  };

  const find = async () => {
    setBusy(true);
    setError(null);
    setFound(null);
    const res = await lookupGame(code);
    setBusy(false);
    if (res.ok) setFound(res.value);
    else setError(res.error);
  };

  const named = name.trim().length > 0;
  const teamNamed = teamName.trim().length > 0;

  return (
    <div className="pad gameroom">
      <h2>Game</h2>
      <p className="muted">
        Put every player's phone in the same game and the seekers' live positions show on
        everyone's map. The hider's position is never sent.
      </p>

      <label className="field">
        <span>Your name</span>
        <input type="text" value={name} maxLength={40} placeholder="Shown next to your dot" onChange={(e) => setName(e.target.value)} />
      </label>

      <h3>Join a game</h3>
      <div className="row">
        <input
          type="text"
          className="code"
          value={code}
          maxLength={6}
          placeholder="Game code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setFound(null); }}
        />
        <button disabled={busy || code.trim().length < 6} onClick={find}>Find game</button>
      </div>
      {fromPass && code === fromPass && !found && (
        <p className="muted small">Your pass was issued for game {fromPass}.</p>
      )}

      {found && (
        <div className="hint fact">
          <p className="small">Game {found.joinCode} — pick your team.</p>
          {!named && <p className="warntext">Enter your name above first.</p>}
          <ul className="list">
            {found.teams.map((t) => (
              <li key={t.id}>
                <span className="grow">
                  {t.name} <span className="muted small">· {t.members} player{t.members === 1 ? '' : 's'}</span>
                </span>
                <button disabled={busy || !named} onClick={() => run(() => joinGame(found.joinCode, name, { id: t.id }))}>
                  Join
                </button>
              </li>
            ))}
            <li>
              <input type="text" className="grow" value={teamName} maxLength={40} placeholder="Or a new team's name" onChange={(e) => setTeamName(e.target.value)} />
              <button disabled={busy || !named || !teamNamed} onClick={() => run(() => joinGame(found.joinCode, name, { name: teamName }))}>
                Add team
              </button>
            </li>
          </ul>
        </div>
      )}

      {!found && (
        <>
          <h3>Or start a new one</h3>
          <div className="row">
            <input type="text" className="grow" value={teamName} maxLength={40} placeholder="Your team's name" onChange={(e) => setTeamName(e.target.value)} />
            <button className="primary" disabled={busy || !named || !teamNamed} onClick={() => run(() => createGame(name, teamName))}>
              Create game
            </button>
          </div>
          <p className="muted small">You get a code to send to everyone else playing.</p>
        </>
      )}

      {error && <p className="warntext">{error}</p>}
    </div>
  );
}

function Room(props: {
  game: LocalGame;
  onGame: (g: LocalGame | null) => void;
  peers: Peer[];
  status: LiveStatus;
  hasPosition: boolean;
}) {
  const { game, peers, status, hasPosition } = props;
  const role = useGame((s) => s.role);
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);

  // Who is in the game changes rarely and is not worth a subscription; a slow
  // poll while the panel is open is plenty. Roles ride along, so a role
  // change on this device is in the key.
  useEffect(() => {
    let cancelled = false;
    const load = () => gameRoster(game.gameId).then((r) => { if (!cancelled && r) setRoster(r); });
    load();
    const t = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [game.gameId, role]);

  const leave = async () => {
    if (!confirm('Leave this game? Your location stops being shared and you stop seeing the seekers.')) return;
    await leaveGame(game);
    props.onGame(null);
  };

  const teams = new Map<string, { name: string; members: RosterEntry[] }>();
  for (const m of roster ?? []) {
    if (!teams.has(m.teamId)) teams.set(m.teamId, { name: m.teamName, members: [] });
    teams.get(m.teamId)!.members.push(m);
  }
  const livePeer = new Map(peers.map((p) => [p.id, p]));

  return (
    <div className="pad gameroom">
      <h2>Game</h2>
      <div className="gamecode">
        <span className="muted small">Game code</span>
        <strong>{game.joinCode}</strong>
        <span className="muted small">Everyone playing enters this on the Game tab.</span>
      </div>

      <p className={`hint ${sharingTone(role, status, hasPosition)}`}>
        {sharingLine(role, status, hasPosition)}
      </p>

      <h3>Players</h3>
      {roster === null ? (
        <p className="muted small">Loading…</p>
      ) : (
        [...teams.entries()].map(([id, t]) => (
          <div key={id} className="team">
            <div className="teamname">
              {t.name}{id === game.teamId && <span className="tag">your team</span>}
            </div>
            <ul className="list">
              {t.members.map((m) => {
                const me = m.profileId === game.profileId;
                const peer = livePeer.get(m.profileId);
                return (
                  <li key={m.profileId}>
                    <span className="grow">{m.displayName}{me && <span className="muted"> (you)</span>}</span>
                    {m.role === 'hider' ? (
                      <span className="tag">hiding</span>
                    ) : me ? (
                      <span className={`tag ${status === 'live' && hasPosition ? 'good' : ''}`}>
                        {status === 'live' && hasPosition ? 'sharing' : 'seeking'}
                      </span>
                    ) : peer ? (
                      <span className={`tag ${peer.stale ? 'warn' : 'good'}`}>
                        {peer.stale ? 'last seen a while ago' : peer.manual ? 'on map · hand-placed' : 'on map'}
                      </span>
                    ) : (
                      <span className="tag">seeking · no position yet</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      <p className="muted small">
        Positions are relayed live between the phones in this game and are not saved anywhere —
        not on a server, and not on the phones that receive them.
      </p>
      <button className="link danger" onClick={leave}>Leave game</button>
    </div>
  );
}

function sharingLine(role: 'seeker' | 'hider', status: LiveStatus, hasPosition: boolean): string {
  if (status === 'error') return 'Can’t reach the game right now — retrying. Nothing is being shared or received.';
  if (status !== 'live') return 'Connecting to the game…';
  if (role === 'hider') return 'You’re hiding: this phone sends nothing. The seekers’ positions appear on your map.';
  if (!hasPosition) return 'You’re seeking, but this phone has no position yet, so there is nothing to share.';
  return 'You’re seeking: your live position is shown to everyone in this game.';
}

function sharingTone(role: 'seeker' | 'hider', status: LiveStatus, hasPosition: boolean): string {
  if (status !== 'live') return 'warn';
  return role === 'seeker' && !hasPosition ? 'warn' : 'fact';
}
