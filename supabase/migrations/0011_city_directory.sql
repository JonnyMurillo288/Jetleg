-- A directory of cities, for "Start a game": type a city, see its flag and
-- how many maps it has.
--
-- Two things were missing. A map did not say what country it is in, so there
-- was no flag to show; and counting a city's maps meant fetching every row.
--
--   country              ISO 3166-1 alpha-2, lowercase ('us', 'jp'). Read
--                        from the map file when it is published, the same
--                        way `city` is. Optional: a map without one is
--                        listed without a flag, not refused.
--   community_cities     one row per city label: its country and its number
--                        of *main* maps.
--
-- "Main" means not a branch. `parent_map_id` goes null when the map it grew
-- out of is deleted, but `parent_map_name` is kept for exactly that case, so
-- it is the one that still says "this was a branch".
--
-- The count stops at 11. Nothing limits how many maps a city may have; the
-- directory only ever shows "10+", so that is as much as it is told. 11
-- rather than 10 so that a city with exactly ten maps can still say "10".

alter table community_maps
  add column country text check (country ~ '^[a-z]{2}$');

-- The board the app ships is San Francisco, and every station map plays on it.
update community_maps set country = 'us' where city = 'sf';

create index community_maps_city_idx on community_maps (city);

-- A map file's country, or null. A station map is for the shipped board.
create function map_country_(content jsonb) returns text
  language sql immutable
as $$
  select case
    when lower(btrim(coalesce(content ->> 'country', ''))) ~ '^[a-z]{2}$' then lower(btrim(content ->> 'country'))
    when lower(btrim(content ->> 'city')) = 'sf' then 'us'
    else null
  end
$$;

-- Maps published before this migration: their newest version may already
-- name a country (a file made by a newer app, published through an older
-- database), and if so it should count.
update community_maps m
  set country = map_country_(v.content)
  from community_map_versions v
  where v.id = m.head_version_id and m.country is null;

-- publish_map() and publish_map_version(), as in 0006, each now also
-- recording the country. A new version may correct a map's country -- unlike
-- its city, which is what the map is filed under and cannot change.
create or replace function publish_map(content jsonb, message text default '', parent_version uuid default null)
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

  insert into community_maps (author_id, author_name, name, description, kind, city, country, parent_map_id, parent_version_id, parent_map_name, station_count, version_count)
    values (auth.uid(), author_name_, btrim(content ->> 'name'), coalesce(content ->> 'description', ''),
            content ->> 'kind', lower(btrim(content ->> 'city')), map_country_(content), parent_.map_id, parent_.id,
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

create or replace function publish_map_version(map uuid, content jsonb, message text default '')
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
      country = coalesce(map_country_(content), community_maps.country),
      author_name = author_name_,
      updated_at = now()
    where id = map_.id;
  return version_id_;
end;
$$;

-- One row per city. `security_invoker` so the view reads community_maps as
-- whoever is asking -- which is everyone, since maps are public (0006), but
-- it must stay that table's decision and not become this view's.
--
-- A city's maps can disagree about its country (two authors, one label);
-- the directory shows the one most of them name.
create view community_cities with (security_invoker = true) as
  select
    city,
    mode() within group (order by country) as country,
    least(count(*) filter (where parent_map_name is null), 11)::int as map_count
  from community_maps
  group by city;

grant select on community_cities to anon, authenticated;
