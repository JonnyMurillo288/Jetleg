-- Full city maps.
--
-- 0006 reserved `kind = 'pack'` in the column's check and refused it in
-- publish_map(). The app can now build and play one -- a board for any city:
-- its boundary, stations, every POI layer and their Voronoi cells, in the
-- same *.jetleg-map.json document (app/src/community/format.ts). So the
-- validator stops refusing it and learns what one must contain.
--
-- A pack is large -- a full San Francisco is about 1.6 MB -- so the size
-- limit depends on the kind. It still lives in `content jsonb`: Postgres
-- compresses and stores it out of line, the list queries never select it,
-- and one fetch of a few megabytes per map chosen is what loading the
-- shipped board already costs. Storage would buy nothing yet.
--
-- As before this checks shape and size, not geography. Whether a station is
-- inside the boundary, whether the cells match the points -- the app decides
-- those, with the same code, on every device that loads the map.

create or replace function validate_map_content_(content jsonb) returns void
  language plpgsql immutable
as $$
declare
  n int;
  kind_ text;
  layer_ record;
begin
  if jsonb_typeof(content) <> 'object' or content ->> 'format' <> 'jetleg-map' then
    raise exception 'Not a JetLeg map';
  end if;
  if (content ->> 'formatVersion') is distinct from '1' then
    raise exception 'Unsupported map format version';
  end if;
  kind_ := content ->> 'kind';
  if kind_ is null or kind_ not in ('stations', 'pack') then
    raise exception 'Unknown map kind';
  end if;
  if kind_ = 'pack' and octet_length(content::text) > 4500000 then
    raise exception 'Map is too large';
  end if;
  if kind_ = 'stations' and octet_length(content::text) > 400000 then
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

  if kind_ = 'stations' then
    return;
  end if;

  -- A pack: one boundary polygon, and layers and cells keyed by name.
  if content #>> '{boundary,type}' is distinct from 'Polygon'
     or jsonb_typeof(content #> '{boundary,coordinates}') is distinct from 'array'
     or jsonb_array_length(content #> '{boundary,coordinates}') < 1
     or jsonb_typeof(content #> '{boundary,coordinates,0}') is distinct from 'array'
     or jsonb_array_length(content #> '{boundary,coordinates,0}') < 4 then
    raise exception 'A city map needs a boundary polygon';
  end if;
  if jsonb_typeof(content -> 'layers') is distinct from 'object'
     or jsonb_typeof(content -> 'voronoi') is distinct from 'object' then
    raise exception 'A city map needs its layers and Voronoi cells';
  end if;
  for layer_ in
    select key, value from jsonb_each(content -> 'layers')
    union all
    select key, value from jsonb_each(content -> 'voronoi')
  loop
    if jsonb_typeof(layer_.value) <> 'array' or jsonb_array_length(layer_.value) > 3000 then
      raise exception 'Layer "%" must be a list of at most 3000 features', layer_.key;
    end if;
    if exists (
      select 1 from jsonb_array_elements(layer_.value) f
      where f ->> 'type' is distinct from 'Feature'
        or jsonb_typeof(f -> 'geometry') is distinct from 'object'
        or jsonb_typeof(f #> '{properties,id}') is distinct from 'string'
    ) then
      raise exception 'Every feature in layer "%" needs a geometry and an id', layer_.key;
    end if;
  end loop;
end;
$$;
