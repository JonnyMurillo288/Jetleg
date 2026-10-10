-- Community maps: publish a map, branch someone else's, like and discuss.
--
-- Shaped like a small git host, because that is the behaviour asked for:
--
--   community_maps           a repository -- one author, one line of history
--   community_map_versions   its commits  -- immutable, each naming its parent
--   parent_map_id / parent_version_id on a map
--                            a branch     -- a new map started from one exact
--                                            version of another, which stays
--                                            linked to where it came from
--
-- A map's content is the `*.jetleg-map.json` document (app/src/community/
-- format.ts), stored whole as jsonb. `kind` is 'stations' today; 'pack' -- a
-- full city board -- is already a legal value of the column so that adding
-- it later migrates nothing, but publish_map() refuses it for now. A pack
-- will be megabytes and belongs in Storage, which is why `content` is the
-- only place a version's payload is assumed to live.
--
-- Who may do what:
--   read      everyone, signed in or not -- browsing and playing is open
--   write     only a *signed-in* user: one with a verified email, not the
--             anonymous device identity every phone gets (0001). Enforced by
--             is_signed_in() below, inside the database.
--
-- Nothing here touches a game in progress. No position, no round, no ask.

-- ---------------------------------------------------------------------
-- Part 1: what "logged in" means.
-- ---------------------------------------------------------------------

-- Anonymous auth hands every device a real auth.uid(), so `auth.uid() is
-- not null` says nothing about whether a person signed in. The JWT does:
-- is_anonymous flips to false, and an email claim appears, only once an
-- emailed code or link has been confirmed.
create function is_signed_in() returns boolean
  language sql stable
as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is false
    and coalesce(auth.jwt() ->> 'email', '') <> ''
$$;

create function require_author_name_() returns text
  language plpgsql security definer stable
  set search_path = public
as $$
declare
  name_ text;
begin
  if not is_signed_in() then
    raise exception 'Sign in with your email to do that';
  end if;
  select display_name into name_ from profiles where id = auth.uid();
  if name_ is null or btrim(name_) = '' then
    raise exception 'Choose a display name first';
  end if;
  return left(btrim(name_), 40);
end;
$$;
revoke execute on function require_author_name_() from public, anon;

-- ---------------------------------------------------------------------
-- Part 2: tables.
-- ---------------------------------------------------------------------

create table community_maps (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users (id) on delete cascade,
  -- Copied at publish time. `profiles` stays own-row-only (0001); this is
  -- the name the author chose to publish under, and the only thing about
  -- them that is public.
  author_name text not null,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  kind text not null check (kind in ('stations', 'pack')),
  city text not null check (char_length(city) between 1 and 24),
  -- A branch remembers where it came from. `set null` rather than cascade:
  -- deleting a map must not delete the maps other people grew out of it.
  parent_map_id uuid references community_maps (id) on delete set null,
  parent_version_id uuid,
  -- Kept as text so a branch can still say what it grew out of after the
  -- original is gone and both ids above have gone null.
  parent_map_name text,
  head_version_id uuid,
  station_count int not null default 0,
  version_count int not null default 0,
  like_count int not null default 0,
  dislike_count int not null default 0,
  comment_count int not null default 0,
  branch_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table community_map_versions (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references community_maps (id) on delete cascade,
  seq int not null,
  -- The previous version of this map, or for a branch's first version, the
  -- version of the other map it was started from.
  parent_version_id uuid references community_map_versions (id) on delete set null,
  message text not null default '' check (char_length(message) <= 200),
  content jsonb not null,
  station_count int not null,
  created_at timestamptz not null default now(),
  unique (map_id, seq)
);

alter table community_maps
  add constraint community_maps_parent_version_fkey
    foreign key (parent_version_id) references community_map_versions (id) on delete set null,
  add constraint community_maps_head_version_fkey
    foreign key (head_version_id) references community_map_versions (id) on delete set null;

create table community_reactions (
  map_id uuid not null references community_maps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (map_id, user_id)
);

create table community_comments (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references community_maps (id) on delete cascade,
  -- A reply. Threads are one level deep; see the trigger below.
  parent_id uuid references community_comments (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  author_name text not null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index community_maps_city_likes_idx on community_maps (city, like_count desc);
create index community_maps_parent_idx on community_maps (parent_map_id);
create index community_maps_author_idx on community_maps (author_id);
create index community_map_versions_map_idx on community_map_versions (map_id, seq desc);
create index community_comments_map_idx on community_comments (map_id, created_at);

-- ---------------------------------------------------------------------
-- Part 3: row-level security.
-- ---------------------------------------------------------------------

alter table community_maps enable row level security;
alter table community_map_versions enable row level security;
alter table community_reactions enable row level security;
alter table community_comments enable row level security;

-- Maps and versions: readable by all; written only by publish_map() and
-- publish_map_version(), which validate the content. No insert or update
-- policy exists, so a version cannot be edited after the fact by anyone --
-- history is what it says it is. An author may delete their own map.
create policy "community_maps: public read" on community_maps
  for select using (true);
create policy "community_maps: author deletes" on community_maps
  for delete using (is_signed_in() and author_id = auth.uid());

create policy "community_map_versions: public read" on community_map_versions
  for select using (true);

-- Reactions: who liked what is nobody else's business. A user reads only
-- their own; everyone reads the totals on the map row. Written by
-- react_to_map().
create policy "community_reactions: own, read only" on community_reactions
  for select using (user_id = auth.uid());

create policy "community_comments: public read" on community_comments
  for select using (true);
create policy "community_comments: signed-in users post as themselves" on community_comments
  for insert with check (is_signed_in() and author_id = auth.uid());
create policy "community_comments: author deletes" on community_comments
  for delete using (is_signed_in() and author_id = auth.uid());

-- ---------------------------------------------------------------------
-- Part 4: validating a map before it is stored.
-- ---------------------------------------------------------------------

-- The app runs the full validator (format.ts) before publishing; this is the
-- floor underneath it, for a caller that is not the app. It checks shape and
-- size, not geography -- whether a station sits inside a city's boundary is
-- the app's question, asked again by every device that loads the map.
create function validate_map_content_(content jsonb) returns void
  language plpgsql immutable
as $$
declare
  n int;
begin
  if jsonb_typeof(content) <> 'object' or content ->> 'format' <> 'jetleg-map' then
    raise exception 'Not a JetLeg map';
  end if;
  if (content ->> 'formatVersion') is distinct from '1' then
    raise exception 'Unsupported map format version';
  end if;
  if content ->> 'kind' = 'pack' then
    raise exception 'City packs are not accepted yet';
  end if;
  if content ->> 'kind' is distinct from 'stations' then
    raise exception 'Unknown map kind';
  end if;
  if octet_length(content::text) > 400000 then
    raise exception 'Map is too large';
  end if;
  if char_length(btrim(coalesce(content ->> 'name', ''))) not between 1 and 80 then
    raise exception 'A map needs a name of 1 to 80 characters';
  end if;
  if char_length(coalesce(content ->> 'description', '')) > 2000 then
    raise exception 'Description is too long';
  end if;
  if char_length(btrim(coalesce(content ->> 'city', ''))) not between 1 and 24 then
    raise exception 'A map must name its city';
  end if;
  if jsonb_typeof(content -> 'stations') is distinct from 'array' then
    raise exception 'A map needs a station list';
  end if;
  n := jsonb_array_length(content -> 'stations');
  if n < 2 or n > 600 then
    raise exception 'A map needs between 2 and 600 stations';
  end if;
  if exists (
    select 1 from jsonb_array_elements(content -> 'stations') s
    where jsonb_typeof(s) <> 'object'
      or jsonb_typeof(s -> 'id') is distinct from 'string'
      or jsonb_typeof(s -> 'name') is distinct from 'string'
      or btrim(s ->> 'name') = ''
      or jsonb_typeof(s -> 'lon') is distinct from 'number'
      or jsonb_typeof(s -> 'lat') is distinct from 'number'
      or abs((s ->> 'lon')::numeric) > 180
      or abs((s ->> 'lat')::numeric) > 90
  ) then
    raise exception 'Every station needs an id, a name and a position';
  end if;
  if (select count(distinct s ->> 'id') from jsonb_array_elements(content -> 'stations') s) <> n then
    raise exception 'Station ids must be unique';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 5: publishing.
-- ---------------------------------------------------------------------

-- A new map. With `parent_version`, a branch of the map that version
-- belongs to.
create function publish_map(content jsonb, message text default '', parent_version uuid default null)
  returns uuid
  language plpgsql security definer
  set search_path = public
as $$
declare
  author_name_ text := require_author_name_();
  parent_ community_map_versions;
  map_id_ uuid;
  version_id_ uuid;
  n int;
begin
  perform validate_map_content_(content);
  n := jsonb_array_length(content -> 'stations');

  if parent_version is not null then
    select * into parent_ from community_map_versions where id = parent_version;
    if not found then
      raise exception 'The map version being branched no longer exists';
    end if;
  end if;

  insert into community_maps (author_id, author_name, name, description, kind, city, parent_map_id, parent_version_id, parent_map_name, station_count, version_count)
    values (auth.uid(), author_name_, btrim(content ->> 'name'), coalesce(content ->> 'description', ''),
            content ->> 'kind', lower(btrim(content ->> 'city')), parent_.map_id, parent_.id,
            (select m.name from community_maps m where m.id = parent_.map_id), n, 1)
    returning id into map_id_;

  insert into community_map_versions (map_id, seq, parent_version_id, message, content, station_count)
    values (map_id_, 1, parent_.id, left(coalesce(message, ''), 200), content, n)
    returning id into version_id_;

  update community_maps set head_version_id = version_id_ where id = map_id_;
  if parent_.map_id is not null then
    update community_maps set branch_count = branch_count + 1 where id = parent_.map_id;
  end if;
  return map_id_;
end;
$$;

-- A new version of a map you already published. The map's name and
-- description follow its newest version.
create function publish_map_version(map uuid, content jsonb, message text default '')
  returns uuid
  language plpgsql security definer
  set search_path = public
as $$
declare
  author_name_ text := require_author_name_();
  map_ community_maps;
  version_id_ uuid;
  n int;
begin
  select * into map_ from community_maps where id = map for update;
  if not found then
    raise exception 'That map no longer exists';
  end if;
  if map_.author_id <> auth.uid() then
    raise exception 'Only a map''s author can publish a new version of it. Branch it instead.';
  end if;
  perform validate_map_content_(content);
  if content ->> 'kind' <> map_.kind or lower(btrim(content ->> 'city')) <> map_.city then
    raise exception 'A new version cannot change a map''s kind or city';
  end if;
  n := jsonb_array_length(content -> 'stations');

  insert into community_map_versions (map_id, seq, parent_version_id, message, content, station_count)
    values (map_.id, map_.version_count + 1, map_.head_version_id, left(coalesce(message, ''), 200), content, n)
    returning id into version_id_;

  update community_maps set
      head_version_id = version_id_,
      version_count = version_count + 1,
      station_count = n,
      name = btrim(content ->> 'name'),
      description = coalesce(content ->> 'description', ''),
      author_name = author_name_,
      updated_at = now()
    where id = map_.id;
  return version_id_;
end;
$$;

-- When a branch is deleted, its parent has one fewer.
create function community_map_deleted_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
begin
  if old.parent_map_id is not null then
    update community_maps set branch_count = greatest(branch_count - 1, 0) where id = old.parent_map_id;
  end if;
  return old;
end;
$$;
create trigger community_map_deleted after delete on community_maps
  for each row execute function community_map_deleted_();

-- ---------------------------------------------------------------------
-- Part 6: likes and dislikes.
-- ---------------------------------------------------------------------

-- 1 likes, -1 dislikes, 0 takes it back. One reaction per user per map.
create function react_to_map(map uuid, new_value int) returns void
  language plpgsql security definer
  set search_path = public
as $$
begin
  if not is_signed_in() then
    raise exception 'Sign in with your email to do that';
  end if;
  if new_value = 0 then
    delete from community_reactions where map_id = map and user_id = auth.uid();
  elsif new_value in (-1, 1) then
    insert into community_reactions (map_id, user_id, value) values (map, auth.uid(), new_value)
      on conflict (map_id, user_id) do update set value = excluded.value;
  else
    raise exception 'A reaction is 1, -1 or 0';
  end if;
end;
$$;

-- Totals are recounted from the rows rather than incremented. The lock comes
-- first and is its own statement on purpose: two people liking at the same
-- moment each see only their own uncommitted row, each count "1", and the
-- later write wins. Holding a per-map lock makes the second wait for the
-- first to commit, and the count that follows then starts a fresh snapshot
-- that includes it. (Found by seeding likes in parallel: three showed as one.)
--
-- An advisory lock, not `select ... for update` on the map row: inserting a
-- reaction already holds a key-share lock on that row through its foreign
-- key, so several inserters each asking for the row lock deadlock, and
-- Postgres resolves that by throwing likes away.
create function community_reaction_changed_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
declare
  map_id_ uuid := coalesce(new.map_id, old.map_id);
begin
  perform pg_advisory_xact_lock(hashtextextended(map_id_::text, 0));
  update community_maps set
      like_count = (select count(*) from community_reactions r where r.map_id = map_id_ and r.value = 1),
      dislike_count = (select count(*) from community_reactions r where r.map_id = map_id_ and r.value = -1)
    where id = map_id_;
  return null;
end;
$$;
create trigger community_reaction_changed after insert or update or delete on community_reactions
  for each row execute function community_reaction_changed_();

-- ---------------------------------------------------------------------
-- Part 7: comments.
-- ---------------------------------------------------------------------

-- The author's name is taken from their profile, never from the request,
-- and a reply to a reply is filed under the original comment: threads are
-- one level deep, which is as much as a phone screen can show.
create function community_comment_inserting_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
declare
  parent_ community_comments;
begin
  new.author_name := require_author_name_();
  new.author_id := auth.uid();
  new.body := btrim(new.body);
  new.created_at := now();
  if new.parent_id is not null then
    select * into parent_ from community_comments where id = new.parent_id;
    if not found or parent_.map_id <> new.map_id then
      raise exception 'That comment is not on this map';
    end if;
    new.parent_id := coalesce(parent_.parent_id, parent_.id);
  end if;
  return new;
end;
$$;
create trigger community_comment_inserting before insert on community_comments
  for each row execute function community_comment_inserting_();

create function community_comment_changed_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
declare
  map_id_ uuid := coalesce(new.map_id, old.map_id);
begin
  -- Same lock-then-count as reactions, for the same reasons.
  perform pg_advisory_xact_lock(hashtextextended(map_id_::text, 0));
  update community_maps set
      comment_count = (select count(*) from community_comments c where c.map_id = map_id_)
    where id = map_id_;
  return null;
end;
$$;
create trigger community_comment_changed after insert or delete on community_comments
  for each row execute function community_comment_changed_();
