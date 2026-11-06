import { supabase } from '../sync/client';
import { parseMapFile, type MapFile } from './format';
import { nameOrAuthor, searchTerm } from './search';

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
  /** ISO 3166-1 alpha-2, lowercase; null when the map does not say. */
  country: string | null;
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
  /**
   * Set when the map is hidden (0016): after reports, or by a moderator. Only
   * its author and moderators can see a hidden map at all.
   */
  hiddenAt: string | null;
  hiddenReason: string | null;
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
  upCount: number;
  downCount: number;
  /** Up minus down: what the discussion is ordered by. */
  score: number;
  /** Hidden (0016). Seen only by its author and moderators. */
  hiddenAt: string | null;
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
  /** This user's own vote on each comment they voted on: 1 or -1. */
  myVotes: Record<string, number>;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type Sort = 'top' | 'new';

const NOT_CONFIGURED = 'This build has no server configured, so there are no community maps.';
const fail = (error: string): Result<never> => ({ ok: false, error });
const explain = (message: string | undefined) =>
  !message || /fetch|network/i.test(message) ? 'Could not reach the server. Check your connection.' : message;

const MAP_COLUMNS =
  'id, name, description, author_id, author_name, kind, city, country, parent_map_id, parent_version_id, parent_map_name, head_version_id, ' +
  'station_count, version_count, like_count, dislike_count, comment_count, branch_count, created_at, updated_at, hidden_at, hidden_reason';

type MapRow = Record<string, any>;
const toSummary = (r: MapRow): MapSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  authorId: r.author_id,
  authorName: r.author_name,
  kind: r.kind,
  city: r.city,
  country: r.country ?? null,
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
  hiddenAt: r.hidden_at ?? null,
  hiddenReason: r.hidden_reason ?? null,
});

/**
 * Published maps; with `city`, only the ones filed under that city label;
 * with `authorId`, only that person's.
 */
export async function listMaps(sort: Sort, city?: string, authorId?: string): Promise<Result<MapSummary[]>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  let query = supabase.from('community_maps').select(MAP_COLUMNS);
  if (city) query = query.eq('city', city);
  if (authorId) query = query.eq('author_id', authorId);
  query = sort === 'top'
    ? query.order('like_count', { ascending: false }).order('updated_at', { ascending: false })
    : query.order('updated_at', { ascending: false });
  const { data, error } = await query.limit(100);
  if (error) return fail(explain(error.message));
  return { ok: true, value: (data as MapRow[]).map(toSummary) };
}

export type SearchHits = {
  /** Maps whose name or author matches. */
  maps: MapSummary[];
  /** People with published maps whose name matches, best known first. */
  people: { authorId: string; authorName: string; mapCount: number }[];
};

/**
 * Maps whose name or author matches, best liked first, and the people whose
 * name matches. `limit` is small for the search box's drop-down and larger
 * for the list under it.
 */
export async function searchMaps(q: string, limit = 6): Promise<Result<SearchHits>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const term = searchTerm(q);
  if (term.length < 2) return { ok: true, value: { maps: [], people: [] } };
  const [byAny, byAuthor] = await Promise.all([
    supabase.from('community_maps').select(MAP_COLUMNS).or(nameOrAuthor(term))
      .order('like_count', { ascending: false }).order('updated_at', { ascending: false }).limit(limit),
    supabase.from('community_maps').select('author_id, author_name').ilike('author_name', `%${term}%`).limit(200),
  ]);
  const broke = byAny.error ?? byAuthor.error;
  if (broke) return fail(explain(broke.message));
  const people = new Map<string, { authorId: string; authorName: string; mapCount: number }>();
  for (const r of (byAuthor.data ?? []) as MapRow[]) {
    const had = people.get(r.author_id);
    if (had) had.mapCount++;
    else people.set(r.author_id, { authorId: r.author_id, authorName: r.author_name, mapCount: 1 });
  }
  return {
    ok: true,
    value: {
      maps: ((byAny.data ?? []) as MapRow[]).map(toSummary),
      people: [...people.values()].sort((a, b) => b.mapCount - a.mapCount).slice(0, 4),
    },
  };
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

  const [versions, branches, comments, parent, reaction, votes] = await Promise.all([
    client.from('community_map_versions').select('id, seq, message, station_count, created_at').eq('map_id', id).order('seq', { ascending: false }),
    client.from('community_maps').select(MAP_COLUMNS).eq('parent_map_id', id).order('like_count', { ascending: false }).limit(50),
    // Best first; among equals, the conversation's own order.
    client.from('community_comments').select('id, parent_id, author_id, author_name, body, created_at, up_count, down_count, score, hidden_at')
      .eq('map_id', id).order('score', { ascending: false }).order('created_at', { ascending: true }).limit(500),
    map.parentMapId
      ? client.from('community_maps').select('id, name, author_name').eq('id', map.parentMapId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    userId
      ? client.from('community_reactions').select('value').eq('map_id', id).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    userId
      ? client.from('community_comment_votes').select('comment_id, value').eq('map_id', id).eq('user_id', userId)
      : Promise.resolve({ data: [] as { comment_id: string; value: number }[], error: null }),
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
      comments: (comments.data ?? []).map((c) => ({
        id: c.id, parentId: c.parent_id, authorId: c.author_id, authorName: c.author_name, body: c.body, createdAt: c.created_at,
        upCount: c.up_count, downCount: c.down_count, score: c.score, hiddenAt: c.hidden_at ?? null,
      })),
      myReaction: reaction.data?.value ?? 0,
      myVotes: Object.fromEntries((votes.data ?? []).map((v) => [v.comment_id, v.value])),
    },
  };
}

export type CityRow = { city: string; country: string | null; mapCount: number };

/**
 * Every city that has a published map, with its number of main maps (not
 * branches). The count arrives already capped — see 0011_city_directory.sql.
 */
export async function listCities(): Promise<Result<CityRow[]>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.from('community_cities').select('city, country, map_count').limit(2000);
  if (error) return fail(explain(error.message));
  return {
    ok: true,
    value: (data as MapRow[]).map((r) => ({ city: r.city, country: r.country ?? null, mapCount: r.map_count ?? 0 })),
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

/** One version's map and the published map it belongs to — to put a round's board back. */
export async function getVersion(versionId: string): Promise<Result<{ mapId: string; map: MapFile }>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.from('community_map_versions').select('map_id, content').eq('id', versionId).maybeSingle();
  if (error) return fail(explain(error.message));
  if (!data) return fail('That version of the map no longer exists.');
  const parsed = parseMapFile(data.content);
  return parsed.ok ? { ok: true, value: { mapId: data.map_id, map: parsed.map } } : fail(parsed.error);
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

export async function voteOnComment(commentId: string, value: 1 | -1 | 0): Promise<Result<true>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { error } = await supabase.rpc('vote_on_comment', { comment: commentId, new_value: value });
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

// ------------------------------------------------------------------ moderation (0016)

/**
 * Report a map, or one comment on it. Once per person per thing; three
 * different people hide it until a moderator looks. Says whether it is now
 * hidden.
 */
export async function report(mapId: string, reason: string, commentId?: string): Promise<Result<{ hidden: boolean }>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.rpc('report_content', { map: mapId, reason, ...(commentId ? { comment: commentId } : {}) });
  if (error) return fail(/Sign in/i.test(error.message) ? 'Sign in with your email to report something.' : explain(error.message));
  return { ok: true, value: { hidden: !!(data as { hidden?: boolean } | null)?.hidden } };
}

/** Is the signed-in person a moderator? False on any doubt. */
export async function amModerator(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('is_moderator');
  return !error && data === true;
}

export type QueueItem = {
  mapId: string;
  /** Null when the item is the map itself. */
  commentId: string | null;
  mapName: string;
  authorName: string;
  /** The comment, or the map's description. */
  body: string;
  hiddenAt: string | null;
  hiddenReason: string | null;
  openReports: number;
  reasons: string[];
  lastReportedAt: string | null;
};

/** Everything with an open report, and everything hidden. Moderators only. */
export async function moderationQueue(): Promise<Result<QueueItem[]>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { data, error } = await supabase.rpc('moderation_queue');
  if (error) return fail(/Moderators only/.test(error.message) ? 'This page is for moderators.' : explain(error.message));
  return {
    ok: true,
    value: ((data ?? []) as MapRow[]).map((r) => ({
      mapId: r.map_id, commentId: r.comment_id, mapName: r.map_name, authorName: r.author_name, body: r.body ?? '',
      hiddenAt: r.hidden_at, hiddenReason: r.hidden_reason, openReports: r.open_reports, reasons: r.reasons ?? [], lastReportedAt: r.last_reported_at,
    })),
  };
}

/** Hide or restore a map (no comment) or a comment, closing its reports. Moderators only. */
export async function moderate(mapId: string, hide: boolean, commentId?: string): Promise<Result<true>> {
  if (!supabase) return fail(NOT_CONFIGURED);
  const { error } = await supabase.rpc('moderate', { map: mapId, hide, ...(commentId ? { comment: commentId } : {}) });
  if (error) return fail(explain(error.message));
  return { ok: true, value: true };
}
