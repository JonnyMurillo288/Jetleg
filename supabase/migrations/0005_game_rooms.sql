-- Game rooms, and live seeker-location sharing inside one.
--
-- A game (0004) becomes something a device can actually enter: it gets a
-- short join code -- the "game token" every player types once -- and teams
-- get a name. Membership of a game lives in its own table, written only by
-- the security-definer functions below, never directly by a client.
--
-- Why not reuse team_members: its insert policy is "join as self" with any
-- team_id, and `teams` is readable by every signed-in device. Good enough
-- for after-the-fact history, not for a live position -- anyone holding the
-- anon key could list teams, add themselves to one, and watch a stranger's
-- seekers move. Knowing the game code is the only way into game_members.
--
-- The live positions themselves are never stored. They travel as Realtime
-- *Broadcast* messages on a private channel, `game:<game id>`: Realtime
-- relays a broadcast to whoever is subscribed at that instant and keeps
-- nothing. There is deliberately no table for them in this migration. The
-- two policies on realtime.messages at the bottom are authorization only --
-- Realtime evaluates them when a device joins the channel; a client
-- broadcast never becomes a row there.
--
-- The fairness rule (ROADMAP.md): a hider's position must never reach a
-- seeker. Two layers. The app has no code path that sends as a hider. And
-- here, independently: a member's role is recorded on game_members,
-- defaulting to 'hider', and only a 'seeker' passes the broadcast policy --
-- so a hider's device is refused by Realtime even if the app were wrong.

-- ---------------------------------------------------------------------
-- Part 1: the game token, and team names.
-- ---------------------------------------------------------------------

-- Six characters from an alphabet with no 0/O/1/I, the same one
-- identity.ts uses for team codes. Drawn from gen_random_uuid() rather than
-- random(): the code is the only thing standing between a stranger and a
-- game's live positions, so it should not come from a guessable generator.
-- Bytes 0-5 of a v4 uuid are all random (the version and variant bits live
-- in bytes 6 and 8), and 256 is a multiple of 32, so there is no modulo bias.
create function random_join_code() returns text
  language sql volatile
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 32), 1), '')
  from (select uuid_send(gen_random_uuid()) as b) r, generate_series(0, 5) as i
$$;

alter table games add column join_code text;
update games set join_code = random_join_code();
alter table games alter column join_code set not null;
alter table games alter column join_code set default random_join_code();
alter table games add constraint games_join_code_key unique (join_code);
alter table games add column created_by uuid references auth.users (id) on delete set null;

alter table teams add column name text;
alter table teams alter column join_code set default random_join_code();

-- ---------------------------------------------------------------------
-- Part 2: who is in a game.
-- ---------------------------------------------------------------------

create table game_members (
  game_id uuid not null references games (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  -- Fails closed: a device may broadcast nothing until it has said it is
  -- seeking.
  role text not null default 'hider' check (role in ('seeker', 'hider')),
  primary key (game_id, profile_id)
);
create index game_members_profile_id_idx on game_members (profile_id);

alter table game_members enable row level security;

-- Same recursion trap as my_team_ids() in 0001: a policy on game_members
-- cannot query game_members itself.
create function my_game_ids() returns setof uuid
  language sql security definer stable
  set search_path = public
as $$
  select game_id from game_members where profile_id = auth.uid()
$$;

create function my_seeking_game_ids() returns setof uuid
  language sql security definer stable
  set search_path = public
as $$
  select game_id from game_members where profile_id = auth.uid() and role = 'seeker'
$$;

-- Read-only, and only for games you are in. No insert/update/delete policy
-- at all: every write goes through the functions below.
create policy "game_members: same game, read only" on game_members
  for select using (game_id in (select my_game_ids()));

-- ---------------------------------------------------------------------
-- Part 3: creating, finding, joining and leaving a game.
-- ---------------------------------------------------------------------

create function clean_name_(raw text, what text) returns text
  language plpgsql immutable
as $$
declare
  cleaned text := left(btrim(coalesce(raw, '')), 40);
begin
  if cleaned = '' then
    raise exception '% is required', what;
  end if;
  return cleaned;
end;
$$;

-- Shared tail of create_game/join_game: the profile row, both membership
-- rows, and the shape the app caches. team_members is kept in step so the
-- end-of-round history sync (0001) lands on the same team with no second
-- code to type.
create function enter_game_(game_ games, team_ teams, display_name text) returns jsonb
  language plpgsql security definer
  set search_path = public
as $$
begin
  insert into profiles (id, display_name) values (auth.uid(), display_name)
    on conflict (id) do update set display_name = excluded.display_name;

  insert into team_members (team_id, profile_id) values (team_.id, auth.uid())
    on conflict do nothing;

  -- Changing team inside a game keeps the role already declared.
  insert into game_members (game_id, profile_id, team_id) values (game_.id, auth.uid(), team_.id)
    on conflict (game_id, profile_id) do update set team_id = excluded.team_id;

  return jsonb_build_object(
    'game_id', game_.id,
    'join_code', game_.join_code,
    'team_id', team_.id,
    'team_name', team_.name,
    'team_join_code', team_.join_code,
    'profile_id', auth.uid()
  );
end;
$$;
revoke execute on function enter_game_(games, teams, text) from public, anon, authenticated;

create function create_game(display_name text, team_name text) returns jsonb
  language plpgsql security definer
  set search_path = public
as $$
declare
  game_ games;
  team_ teams;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  display_name := clean_name_(display_name, 'Your name');
  team_name := clean_name_(team_name, 'A team name');

  insert into games (created_by) values (auth.uid()) returning * into game_;
  insert into teams (game_id, name) values (game_.id, team_name) returning * into team_;
  return enter_game_(game_, team_, display_name);
end;
$$;

-- What a device sees after typing a code and before joining: the teams it
-- could join. Null when the code matches nothing.
create function lookup_game(code text) returns jsonb
  language plpgsql security definer stable
  set search_path = public
as $$
declare
  game_ games;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  select * into game_ from games where join_code = upper(btrim(code));
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'game_id', game_.id,
    'join_code', game_.join_code,
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'name', coalesce(t.name, 'Team ' || t.join_code),
        'members', (select count(*) from game_members m where m.team_id = t.id and m.game_id = game_.id)
      ) order by t.created_on, t.name)
      from teams t where t.game_id = game_.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Join an existing team (team_id) or start a new one in the game (team_name).
create function join_game(code text, display_name text, team_id uuid default null, team_name text default null)
  returns jsonb
  language plpgsql security definer
  set search_path = public
as $$
declare
  game_ games;
  team_ teams;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  display_name := clean_name_(display_name, 'Your name');

  select * into game_ from games where join_code = upper(btrim(code));
  if not found then
    raise exception 'No game with that code';
  end if;

  if team_id is not null then
    select * into team_ from teams where teams.id = join_game.team_id and teams.game_id = game_.id;
    if not found then
      raise exception 'That team is not in this game';
    end if;
  else
    team_name := clean_name_(team_name, 'A team name');
    insert into teams (game_id, name) values (game_.id, team_name) returning * into team_;
  end if;

  return enter_game_(game_, team_, display_name);
end;
$$;

-- Declares which side this device is on. The app calls it before every
-- (re)subscription to the game's channel, because Realtime evaluates the
-- broadcast policy below at join time.
create function set_game_role(game uuid, new_role text) returns void
  language plpgsql security definer
  set search_path = public
as $$
begin
  update game_members set role = new_role
    where game_id = game and profile_id = auth.uid();
  if not found then
    raise exception 'not a member of this game';
  end if;
end;
$$;

create function leave_game(game uuid) returns void
  language plpgsql security definer
  set search_path = public
as $$
begin
  delete from team_members
    where profile_id = auth.uid()
      and team_id in (select id from teams where game_id = game);
  delete from game_members where game_id = game and profile_id = auth.uid();
end;
$$;

-- Names and teams of everyone in a game, for its members only. `profiles`
-- stays own-row-only; this is the one place another player's display name
-- is readable, and only by someone who holds the same game code.
create function game_roster(game uuid) returns table (
  profile_id uuid, display_name text, team_id uuid, team_name text, role text
) language sql security definer stable
  set search_path = public
as $$
  select m.profile_id, p.display_name, t.id, coalesce(t.name, 'Team ' || t.join_code), m.role
  from game_members m
  join profiles p on p.id = m.profile_id
  join teams t on t.id = m.team_id
  where m.game_id = game
    and game in (select my_game_ids())
  order by t.created_on, t.name, p.display_name
$$;

-- A pass granted with a game attached (grant-entitlement.ts) already names
-- the game its holder belongs in. This hands that game's code back so the
-- app can offer it instead of making them type one.
create function entitled_game_code() returns text
  language sql security definer stable
  set search_path = public
as $$
  select g.join_code
  from entitlements e
  join games g on g.id = e.game_id
  where e.device_id = auth.uid()
  order by e.purchased_at desc
  limit 1
$$;

-- ---------------------------------------------------------------------
-- Part 4: who may use a game's live channel.
-- ---------------------------------------------------------------------

-- Receive: anyone in the game, hider included -- seeing the seekers is the
-- point.
create policy "game members receive live locations" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() in (select 'game:' || g from my_game_ids() g)
  );

-- Send: seekers only. A hider's device has no write access to the channel.
create policy "seekers broadcast live locations" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() in (select 'game:' || g from my_seeking_game_ids() g)
  );
