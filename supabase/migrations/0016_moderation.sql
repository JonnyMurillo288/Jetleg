-- Moderation: reporting maps and comments, and hiding them.
--
-- Community maps and comments are public (0006). Before the site is
-- promoted to strangers there has to be a way to take something down that
-- is not "the author deletes it": a map named to harass someone, a comment
-- with a person's home address, a board whose zones are on private land.
--
-- Three parts:
--
-- 1. Anyone signed in can report a map or a comment, once, with a reason.
-- 2. When three different people have reported the same thing, it is
--    hidden at once, pending review. One person cannot hide anything; a
--    small group acting together can only hide it until a moderator looks.
-- 3. Moderators -- a short list of email addresses, kept like developers
--    (0007): data, not committed, managed with grant-moderator.ts -- see
--    the open reports, and hide or restore anything.
--
-- Hidden is not deleted. The row stays, its author still sees it (and is
-- told it is hidden), moderators see it, and everyone else sees nothing:
-- not in lists, not in search, not in the city directory's counts, not its
-- versions or its discussion. Restoring it puts all of that back.

-- ---------------------------------------------------------------------
-- Part 1: who moderates.
-- ---------------------------------------------------------------------

create table moderators (
  email text primary key check (email = lower(btrim(email)) and email <> ''),
  note text,
  added_at timestamptz not null default now()
);

-- RLS on, no policies: only the service role and is_moderator() read it.
alter table moderators enable row level security;

create function is_moderator() returns boolean
  language sql security definer stable
  set search_path = public
as $$
  select is_signed_in()
    and exists (select 1 from moderators m where m.email = lower(auth.jwt() ->> 'email'))
$$;

-- ---------------------------------------------------------------------
-- Part 2: hidden maps and comments.
-- ---------------------------------------------------------------------

alter table community_maps
  add column hidden_at timestamptz,
  add column hidden_reason text;
alter table community_comments
  add column hidden_at timestamptz,
  add column hidden_reason text;

drop policy "community_maps: public read" on community_maps;
create policy "community_maps: public read, unless hidden" on community_maps
  for select using (hidden_at is null or author_id = auth.uid() or is_moderator());

-- A version is readable when its map is. The subquery reads community_maps
-- under that table's own policy, so a hidden map's versions -- its actual
-- content, the thing a player would load -- go with it.
drop policy "community_map_versions: public read" on community_map_versions;
create policy "community_map_versions: readable with their map" on community_map_versions
  for select using (exists (select 1 from community_maps m where m.id = map_id));

drop policy "community_comments: public read" on community_comments;
create policy "community_comments: public read, unless hidden" on community_comments
  for select using (
    (hidden_at is null or author_id = auth.uid() or is_moderator())
    and exists (select 1 from community_maps m where m.id = map_id)
  );

-- The count on the map row is what lists show; a hidden comment is not one
-- anybody else can read, so it is not counted.
create or replace function community_comment_changed_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
declare
  map_id_ uuid := coalesce(new.map_id, old.map_id);
begin
  -- Same lock-then-count as reactions, for the same reasons.
  perform pg_advisory_xact_lock(hashtextextended(map_id_::text, 0));
  update community_maps set
      comment_count = (select count(*) from community_comments c where c.map_id = map_id_ and c.hidden_at is null)
    where id = map_id_;
  return null;
end;
$$;
drop trigger community_comment_changed on community_comments;
create trigger community_comment_changed after insert or delete or update of hidden_at on community_comments
  for each row execute function community_comment_changed_();

-- ---------------------------------------------------------------------
-- Part 3: reports.
-- ---------------------------------------------------------------------

create table community_reports (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references community_maps (id) on delete cascade,
  -- Null for a report about the map itself.
  comment_id uuid references community_comments (id) on delete cascade,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  -- Set when a moderator has acted on the thing reported, either way.
  resolved_at timestamptz
);
-- One report per person per thing. A second press of Report changes nothing.
create unique index community_reports_once
  on community_reports (reporter_id, map_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index community_reports_open on community_reports (map_id, comment_id) where resolved_at is null;

-- RLS on, no policies: who reported what is not readable by any client.
-- Written by report_content(), read by moderation_queue().
alter table community_reports enable row level security;

-- How many different people it takes to hide something before a moderator
-- has looked. Low enough that a few players can take down something nasty
-- at night; high enough that one angry person cannot.
create function report_threshold_() returns int
  language sql immutable
as $$ select 3 $$;

create function report_content(map uuid, reason text, comment uuid default null) returns jsonb
  language plpgsql security definer
  set search_path = public
as $$
declare
  map_ community_maps;
  comment_ community_comments;
  reporters_ int;
  hidden_ boolean;
begin
  if not is_signed_in() then
    raise exception 'Sign in to report something';
  end if;
  if reason is null or char_length(btrim(reason)) = 0 then
    raise exception 'Say what is wrong with it';
  end if;

  select * into map_ from community_maps m where m.id = map;
  if not found then raise exception 'That map no longer exists'; end if;
  if comment is null then
    if map_.author_id = auth.uid() then raise exception 'That is your own map'; end if;
    hidden_ := map_.hidden_at is not null;
  else
    select * into comment_ from community_comments c where c.id = comment and c.map_id = map;
    if not found then raise exception 'That comment no longer exists'; end if;
    if comment_.author_id = auth.uid() then raise exception 'That is your own comment'; end if;
    hidden_ := comment_.hidden_at is not null;
  end if;

  insert into community_reports (map_id, comment_id, reporter_id, reason)
    values (map, comment, auth.uid(), left(btrim(reason), 500))
    on conflict do nothing;

  select count(distinct r.reporter_id) into reporters_ from community_reports r
    where r.map_id = map and r.comment_id is not distinct from comment and r.resolved_at is null;

  if not hidden_ and reporters_ >= report_threshold_() then
    if comment is null then
      update community_maps set hidden_at = now(), hidden_reason = 'Reported by several players; waiting for a moderator.'
        where id = map;
    else
      update community_comments set hidden_at = now(), hidden_reason = 'Reported by several players; waiting for a moderator.'
        where id = comment;
    end if;
    hidden_ := true;
  end if;

  return jsonb_build_object('hidden', hidden_);
end;
$$;

-- Everything with an open report, and everything hidden, newest first.
create function moderation_queue() returns table (
  map_id uuid,
  comment_id uuid,
  map_name text,
  author_name text,
  body text,
  hidden_at timestamptz,
  hidden_reason text,
  open_reports int,
  reasons text[],
  last_reported_at timestamptz
)
  language plpgsql security definer stable
  set search_path = public
as $$
begin
  if not is_moderator() then
    raise exception 'Moderators only';
  end if;
  return query
  with targets as (
    select r.map_id as m_id, r.comment_id as c_id from community_reports r where r.resolved_at is null
    union
    select m.id, null::uuid from community_maps m where m.hidden_at is not null
    union
    select c.map_id, c.id from community_comments c where c.hidden_at is not null
  )
  select
    t.m_id,
    t.c_id,
    m.name,
    coalesce(c.author_name, m.author_name),
    coalesce(c.body, m.description),
    coalesce(c.hidden_at, case when t.c_id is null then m.hidden_at end),
    coalesce(c.hidden_reason, case when t.c_id is null then m.hidden_reason end),
    (select count(*)::int from community_reports r where r.map_id = t.m_id and r.comment_id is not distinct from t.c_id and r.resolved_at is null),
    array(select r.reason from community_reports r where r.map_id = t.m_id and r.comment_id is not distinct from t.c_id and r.resolved_at is null order by r.created_at),
    (select max(r.created_at) from community_reports r where r.map_id = t.m_id and r.comment_id is not distinct from t.c_id)
  from targets t
  join community_maps m on m.id = t.m_id
  left join community_comments c on c.id = t.c_id
  order by 10 desc nulls last;
end;
$$;

-- Hide or restore a map (comment null) or a comment, and close its reports.
create function moderate(map uuid, hide boolean, comment uuid default null) returns void
  language plpgsql security definer
  set search_path = public
as $$
begin
  if not is_moderator() then
    raise exception 'Moderators only';
  end if;
  if comment is null then
    update community_maps set
        hidden_at = case when hide then coalesce(hidden_at, now()) end,
        hidden_reason = case when hide then 'Hidden by a moderator.' end
      where id = map;
  else
    update community_comments set
        hidden_at = case when hide then coalesce(hidden_at, now()) end,
        hidden_reason = case when hide then 'Hidden by a moderator.' end
      where id = comment and map_id = map;
  end if;
  if not found then raise exception 'Nothing to moderate there'; end if;
  update community_reports set resolved_at = now()
    where map_id = map and comment_id is not distinct from comment and resolved_at is null;
end;
$$;

revoke execute on function report_content(uuid, text, uuid) from public, anon;
revoke execute on function moderation_queue() from public, anon;
revoke execute on function moderate(uuid, boolean, uuid) from public, anon;
grant execute on function report_content(uuid, text, uuid) to authenticated;
grant execute on function moderation_queue() to authenticated;
grant execute on function moderate(uuid, boolean, uuid) to authenticated;
grant execute on function is_moderator() to authenticated;
