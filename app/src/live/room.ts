import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { supabase } from '../sync/client';
import { rememberIdentity } from '../sync/identity';
import type { Role } from '../engine/types';

/**
 * The game room: which game this device is in, and on which team.
 *
 * Every write goes through a security-definer function in
 * supabase/migrations/0005_game_rooms.sql — the app never inserts a
 * membership row itself, so knowing the game code is the only way in.
 * What is cached here is membership only (ids, names, the code). No
 * position ever passes through this file.
 */

const GAME_KEY = 'live/game';

export type LocalGame = {
  gameId: string;
  /** The game token — what every player types to get in. */
  joinCode: string;
  teamId: string;
  teamName: string;
  profileId: string;
  displayName: string;
};

export type GameLookup = {
  gameId: string;
  joinCode: string;
  teams: { id: string; name: string; members: number }[];
};

export type RosterEntry = {
  profileId: string;
  displayName: string;
  teamId: string;
  teamName: string;
  role: Role;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const NOT_CONFIGURED = 'This build has no backend configured, so there are no shared games.';
const fail = (error: string): Result<never> => ({ ok: false, error });

async function ensureSignedIn(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  if (data.session?.user) return true;
  const { data: signedIn, error } = await supabase.auth.signInAnonymously();
  return !error && !!signedIn.user;
}

/** supabase-js reports an unreachable server as a bare fetch failure. */
const explain = (message: string | undefined) =>
  !message || /fetch|network/i.test(message) ? 'Could not reach the game server. Check your connection.' : message;

type Entered = {
  game_id: string;
  join_code: string;
  team_id: string;
  team_name: string;
  team_join_code: string;
  profile_id: string;
};

async function remember(entered: Entered, displayName: string): Promise<LocalGame> {
  const game: LocalGame = {
    gameId: entered.game_id,
    joinCode: entered.join_code,
    teamId: entered.team_id,
    teamName: entered.team_name,
    profileId: entered.profile_id,
    displayName,
  };
  await idbSet(GAME_KEY, game);
  // The same team is where this device's finished rounds sync to.
  await rememberIdentity(
    { id: entered.profile_id, displayName },
    { id: entered.team_id, joinCode: entered.team_join_code },
  );
  return game;
}

export async function loadGame(): Promise<LocalGame | null> {
  if (!supabase) return null;
  return (await idbGet<LocalGame>(GAME_KEY)) ?? null;
}

export async function createGame(displayName: string, teamName: string): Promise<Result<LocalGame>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  if (!(await ensureSignedIn())) return fail(explain(undefined));
  const { data, error } = await supabase.rpc('create_game', { display_name: displayName, team_name: teamName });
  if (error || !data) return fail(explain(error?.message));
  return { ok: true, value: await remember(data as Entered, displayName.trim()) };
}

export async function lookupGame(code: string): Promise<Result<GameLookup>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  if (!(await ensureSignedIn())) return fail(explain(undefined));
  const { data, error } = await supabase.rpc('lookup_game', { code });
  if (error) return fail(explain(error.message));
  if (!data) return fail('No game with that code.');
  const found = data as { game_id: string; join_code: string; teams: GameLookup['teams'] };
  return { ok: true, value: { gameId: found.game_id, joinCode: found.join_code, teams: found.teams } };
}

/** Join an existing team by id, or start a new one in the game by name. */
export async function joinGame(
  code: string,
  displayName: string,
  team: { id: string } | { name: string },
): Promise<Result<LocalGame>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  if (!(await ensureSignedIn())) return fail(explain(undefined));
  const { data, error } = await supabase.rpc('join_game', {
    code,
    display_name: displayName,
    ...('id' in team ? { team_id: team.id } : { team_name: team.name }),
  });
  if (error || !data) return fail(explain(error?.message));
  return { ok: true, value: await remember(data as Entered, displayName.trim()) };
}

/**
 * Forgets the game on this device first, so sharing stops even when the
 * server cannot be reached to hear about it.
 */
export async function leaveGame(game: LocalGame): Promise<void> {
  await idbDel(GAME_KEY);
  if (!supabase) return;
  await supabase.rpc('leave_game', { game: game.gameId }).then(() => {}, () => {});
}

/** Throws on failure: the caller must not open the channel on a role the server never heard. */
export async function setGameRole(gameId: string, role: Role): Promise<void> {
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.rpc('set_game_role', { game: gameId, new_role: role });
  if (error) throw new Error(explain(error.message));
}

export async function gameRoster(gameId: string): Promise<RosterEntry[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('game_roster', { game: gameId });
  if (error || !data) return null;
  return (data as { profile_id: string; display_name: string; team_id: string; team_name: string; role: Role }[]).map(
    (r) => ({
      profileId: r.profile_id,
      displayName: r.display_name,
      teamId: r.team_id,
      teamName: r.team_name,
      role: r.role,
    }),
  );
}

/** The code of the game this device's pass was granted for, if it was granted for one. */
export async function entitledGameCode(): Promise<string | null> {
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) return null;
  const { data, error } = await supabase.rpc('entitled_game_code');
  return error || typeof data !== 'string' ? null : data;
}
