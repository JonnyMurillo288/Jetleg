import { supabase } from '../sync/client';
import { parseMapFile, type MapFile } from './format';

/**
 * Reads and writes for community maps. Reads go straight to the tables,
 * which are public; every write goes through a function in
 * 0006_community.sql that checks the caller is signed in and the content is
 * a real map — this file decides nothing about who may do what.
 */

export type MapSummary = {
  id: string;
  name: string;
  description: string;
  authorId: string;
  authorName: string;
  kind: string;
  city: string;
  parentMapId: string | null;
  parentVersionId: string | null;
  /** Name of the map this was branched from, kept even after that map is deleted. */
  parentMapName: string | null;
  headVersionId: string | null;
  stationCount: number;
  versionCount: number;
  likeCount: number;
  dislikeCount: number;
  commentCount: number;
  branchCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VersionSummary = {
  id: string;
  seq: number;
  message: string;
  stationCount: number;
  createdAt: string;
};

export type Comment = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type MapDetail = {
  map: MapSummary;
  /** The map this one was branched from, if it still exists. */
  parent: { id: string; name: string; authorName: string } | null;
  versions: VersionSummary[];
  branches: MapSummary[];
  comments: Comment[];
  /** This user's own reaction: 1, -1 or 0. */
  myReaction: number;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type Sort = 'top' | 'new';

const NOT_CONFIGURED = 'This build has no server configured, so there are no community maps.';
const fail = (error: string): Result<never> => ({ ok: false, error });
const explain = (message: string | undefined) =>
  !message || /fetch|network/i.test(message) ? 'Could not reach the server. Check your connection.' : message;

const MAP_COLUMNS =
  'id, name, description, author_id, author_name, kind, city, parent_map_id, parent_version_id, parent_map_name, head_version_id, ' +
  'station_count, version_count, like_count, dislike_count, comment_count, branch_count, created_at, updated_at';

type MapRow = Record<string, any>;
const toSummary = (r: MapRow): MapSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  authorId: r.author_id,
  authorName: r.author_name,
  kind: r.kind,
  city: r.city,
  parentMapId: r.parent_map_id,
  parentVersionId: r.parent_version_id,
  parentMapName: r.parent_map_name,
  headVersionId: r.head_version_id,
  stationCount: r.station_count,
  versionCount: r.version_count,
  likeCount: r.like_count,
  dislikeCount: r.dislike_count,
  commentCount: r.comment_count,
  branchCount: r.branch_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listMaps(sort: Sort): Promise<Result<MapSummary[]>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  let query = supabase.from('community_maps').select(MAP_COLUMNS);
  query = sort === 'top'
    ? query.order('like_count', { ascending: false }).order('updated_at', { ascending: false })
    : query.order('updated_at', { ascending: false });
  const { data, error } = await query.limit(100);
  if (error) return fail(explain(error.message));
  return { ok: true, value: (data as MapRow[]).map(toSummary) };
}

export async function getMap(id: string): Promise<Result<MapDetail>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const client = supabase;
  const { data: row, error } = await client.from('community_maps').select(MAP_COLUMNS).eq('id', id).maybeSingle();
  if (error) return fail(explain(error.message));
  if (!row) return fail('That map no longer exists.');
  const map = toSummary(row as MapRow);

  const { data: session } = await client.auth.getSession();
  const userId = session.session?.user?.id;

  const [versions, branches, comments, parent, reaction] = await Promise.all([
    client.from('community_map_versions').select('id, seq, message, station_count, created_at').eq('map_id', id).order('seq', { ascending: false }),
    client.from('community_maps').select(MAP_COLUMNS).eq('parent_map_id', id).order('like_count', { ascending: false }).limit(50),
    client.from('community_comments').select('id, parent_id, author_id, author_name, body, created_at').eq('map_id', id).order('created_at', { ascending: true }).limit(500),
    map.parentMapId
      ? client.from('community_maps').select('id, name, author_name').eq('id', map.parentMapId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    userId
      ? client.from('community_reactions').select('value').eq('map_id', id).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const broke = versions.error ?? branches.error ?? comments.error;
  if (broke) return fail(explain(broke.message));

  return {
    ok: true,
    value: {
      map,
      parent: parent.data ? { id: parent.data.id, name: parent.data.name, authorName: parent.data.author_name } : null,
      versions: (versions.data ?? []).map((v) => ({ id: v.id, seq: v.seq, message: v.message, stationCount: v.station_count, createdAt: v.created_at })),
      branches: ((branches.data ?? []) as MapRow[]).map(toSummary),
      comments: (comments.data ?? []).map((c) => ({ id: c.id, parentId: c.parent_id, authorId: c.author_id, authorName: c.author_name, body: c.body, createdAt: c.created_at })),
      myReaction: reaction.data?.value ?? 0,
    },
  };
}

/** One version's map, run through the same validator as a file off disk. */
export async function getVersionContent(versionId: string): Promise<Result<MapFile>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.from('community_map_versions').select('content').eq('id', versionId).maybeSingle();
  if (error) return fail(explain(error.message));
  if (!data) return fail('That version no longer exists.');
  const parsed = parseMapFile(data.content);
  return parsed.ok ? { ok: true, value: parsed.map } : fail(parsed.error);
}

/** A new map; with `parentVersionId`, a branch of the map that version belongs to. */
export async function publishMap(map: MapFile, message: string, parentVersionId?: string): Promise<Result<string>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.rpc('publish_map', {
    content: map,
    message,
    ...(parentVersionId ? { parent_version: parentVersionId } : {}),
  });
  if (error || !data) return fail(explain(error?.message));
  return { ok: true, value: data as string };
}

export async function publishVersion(mapId: string, map: MapFile, message: string): Promise<Result<string>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.rpc('publish_map_version', { map: mapId, content: map, message });
  if (error || !data) return fail(explain(error?.message));
  return { ok: true, value: data as string };
}

export async function deleteMap(mapId: string): Promise<Result<true>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  // RLS turns "not yours" into zero rows rather than an error; ask for the row back to tell.
  const { data, error } = await supabase.from('community_maps').delete().eq('id', mapId).select('id');
  if (error) return fail(explain(error.message));
  if (!data?.length) return fail('Only a map’s author can delete it.');
  return { ok: true, value: true };
}

export async function react(mapId: string, value: 1 | -1 | 0): Promise<Result<true>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { error } = await supabase.rpc('react_to_map', { map: mapId, new_value: value });
  return error ? fail(explain(error.message)) : { ok: true, value: true };
}

export async function postComment(mapId: string, body: string, parentId?: string): Promise<Result<true>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user?.id;
  if (!userId) return fail('Sign in with your email to do that');
  const { error } = await supabase.from('community_comments').insert({
    map_id: mapId,
    body,
    author_id: userId,
    // Overwritten by the server from the author's profile; the column is
    // not null, so something must be sent.
    author_name: '',
    ...(parentId ? { parent_id: parentId } : {}),
  });
  if (error) {
    return fail(/row-level security/i.test(error.message) ? 'Sign in with your email to do that' : explain(error.message));
  }
  return { ok: true, value: true };
}

export async function deleteComment(commentId: string): Promise<Result<true>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.from('community_comments').delete().eq('id', commentId).select('id');
  if (error) return fail(explain(error.message));
  if (!data?.length) return fail('Only a comment’s author can delete it.');
  return { ok: true, value: true };
}
