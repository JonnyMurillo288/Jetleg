import { get as idbGet, set as idbSet } from 'idb-keyval';
import { supabase } from './client';

const PROFILE_KEY = 'sync/profile';
const TEAM_KEY = 'sync/team';

export type LocalProfile = { id: string; displayName: string };
export type LocalTeam = { id: string; joinCode: string };

/**
 * A device identity with no visible sign-in: Supabase anonymous auth gives a
 * real `auth.uid()` for RLS to gate on, with none of the email/password flow
 * "not login yet" was meant to avoid. `displayName` is the only thing the
 * player actually enters.
 */
export async function getOrCreateProfile(displayName: string): Promise<LocalProfile | null> {
  if (!supabase) return null;

  const cached = await idbGet<LocalProfile>(PROFILE_KEY);
  if (cached) return cached;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) return null;

  const profile: LocalProfile = { id: data.user.id, displayName };
  const { error: upsertError } = await supabase
    .from('profiles')
    .upsert({ id: profile.id, display_name: displayName });
  if (upsertError) return null;

  await idbSet(PROFILE_KEY, profile);
  return profile;
}

function randomJoinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

/**
 * Joins an existing team by code, or creates a new one when no code is
 * given. Every device on the same outing enters the same code once.
 */
export async function joinOrCreateTeam(profile: LocalProfile, joinCode?: string): Promise<LocalTeam | null> {
  if (!supabase) return null;

  const cached = await idbGet<LocalTeam>(TEAM_KEY);
  if (cached && (!joinCode || cached.joinCode === joinCode.toUpperCase())) return cached;

  let team: LocalTeam;
  if (joinCode) {
    const { data, error } = await supabase
      .from('teams')
      .select('id, join_code')
      .eq('join_code', joinCode.toUpperCase())
      .single();
    if (error || !data) return null;
    team = { id: data.id, joinCode: data.join_code };
  } else {
    const code = randomJoinCode();
    const { data, error } = await supabase
      .from('teams')
      .insert({ join_code: code })
      .select('id, join_code')
      .single();
    if (error || !data) return null;
    team = { id: data.id, joinCode: data.join_code };
  }

  const { error: memberError } = await supabase
    .from('team_members')
    .upsert({ team_id: team.id, profile_id: profile.id });
  if (memberError) return null;

  await idbSet(TEAM_KEY, team);
  return team;
}
