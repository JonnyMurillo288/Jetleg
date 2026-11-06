-- Game room passes: what is sold is a room, not a device.
--
-- Before this, every phone bought its own pass (0002). Now one person buys a
-- game room -- $5 for two days, $10 for a week -- and gets its code. Up to
-- eight accounts may join it with that code, and every one of them can start
-- as many rounds as they like until the room's time runs out.
--
-- Eight *accounts*, held as places (room_seats). Joining takes a place, and a
-- place is never given back: leaving the room keeps it, and deleting the
-- account keeps it counted (device_id goes null, the row stays). Otherwise
-- the eighth place could be passed round a whole party one phone at a time.
-- A player who never signs in plays on the anonymous account their phone was
-- given, which lives in that phone's browser storage and nowhere else -- so
-- their place is that phone's.
--
-- Like the pass it replaces, the clock does not start at purchase. It starts
-- when anyone holding a place starts the room's first round
-- (check_and_activate_entitlement(start_clock => true)), so a room can be
-- bought the night before.
--
-- Money is still verified in one place only: stripe-checkout creates the
-- room 'unpaid', and only stripe-webhook (service role, after Stripe's
-- signature) marks it 'paid'. No client policy writes games or room_seats.
--
-- Rooms made by a developer (create_game) or before this migration have no
-- pass (pass_status null): they still work for live positions and chat, they
-- hold eight places like any room, and they let nobody play who could not
-- already. Per-device passes already bought or granted (entitlements) keep
-- working until they lapse; nothing sells them any more.

-- ---------------------------------------------------------------------
-- Part 1: a room's pass, and its places.
-- ---------------------------------------------------------------------

alter table games
  add column pass_status text check (pass_status in ('unpaid', 'paid')),
  add column pass_product text check (pass_product in ('room_2day', 'room_week')),
  add column duration_s int,
  add column max_seats int not null default 8 check (max_seats > 0),
  add column started_at timestamptz,
  add column expires_at timestamptz,
  add column stripe_session_id text unique,
  add column buyer_email text,
  add constraint games_pass_complete check (
    pass_status is null or (pass_product is not null and duration_s is not null)
  );

create table room_seats (
  id bigint generated always as identity primary key,
  game_id uuid not null references games (id) on delete cascade,
  -- set null, not cascade: a deleted account's place stays taken.
  device_id uuid references auth.users (id) on delete set null,
  seated_at timestamptz not null default now(),
  unique (game_id, device_id)
);
create index room_seats_device_id_idx on room_seats (device_id);

-- RLS on, no policies: read and written only by the definer functions below.
alter table room_seats enable row level security;

-- Everyone already in a room holds a place in it.
insert into room_seats (game_id, device_id)
  select game_id, profile_id from game_members
  on conflict do nothing;

-- Takes the caller's place in a room, or finds the one it already has.
-- The row lock on the room serialises two phones joining at once, so the
-- eighth place cannot be taken twice. `for no key update`, not `for update`:
-- join_game has usually just inserted a team, whose foreign key holds a key
-- share on this same room, and two joins each holding that share and each
-- asking for `for update` deadlock (found by joining eight phones at once).
-- A no-key-update lock does not conflict with a key share.
create function take_seat_(game uuid) returns void
  language plpgsql security definer
  set search_path = public
as $$
declare
  room_ games;
  used int;
begin
  if exists (select 1 from room_seats s where s.game_id = game and s.device_id = auth.uid()) then
    return;
  end if;

  select * into room_ from games g where g.id = game for no key update;
  if room_.pass_status = 'unpaid' then
    raise exception 'This game room has not been paid for yet. If it was just bought, try again in a minute.';
  end if;
  if room_.pass_status = 'paid' and room_.expires_at is not null and room_.expires_at <= now() then
    raise exception 'This game room''s time is up.';
  end if;

  select count(*) into used from room_seats s where s.game_id = game;
  if used >= room_.max_seats then
    raise exception 'This game room is full: all % places are taken.', room_.max_seats;
  end if;

  insert into room_seats (game_id, device_id) values (game, auth.uid());
end;
$$;
revoke execute on function take_seat_(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Part 2: entering a room takes a place.
-- ---------------------------------------------------------------------

-- As 0005, with the place taken first. join_game creates a new team before
-- calling this; a full room raises here and the whole call rolls back.
create or replace function enter_game_(game_ games, team_ teams, display_name text) returns jsonb
  language plpgsql security definer
  set search_path = public
as $$
begin
  perform take_seat_(game_.id);

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

-- Rooms are bought now (stripe-checkout). Making one for nothing is for
-- developers, whose rooms carry no pass.
create or replace function create_game(display_name text, team_name text) returns jsonb
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
  if not is_developer() then
    raise exception 'Game rooms are bought: buy one, or join one with its code.';
  end if;
  display_name := clean_name_(display_name, 'Your name');
  team_name := clean_name_(team_name, 'A team name');

  insert into games (created_by) values (auth.uid()) returning * into game_;
  insert into teams (game_id, name) values (game_.id, team_name) returning * into team_;
  return enter_game_(game_, team_, display_name);
end;
$$;

-- As 0005, plus the room's pass and places, so a phone can see "3 of 8
-- places taken" and how long is left before joining, and again once in.
create or replace function lookup_game(code text) returns jsonb
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
    ), '[]'::jsonb),
    'pass_status', game_.pass_status,
    'pass_product', game_.pass_product,
    'duration_s', game_.duration_s,
    'expires_at', game_.expires_at,
    'max_seats', game_.max_seats,
    'seats_taken', (select count(*) from room_seats s where s.game_id = game_.id),
    'seated', exists (select 1 from room_seats s where s.game_id = game_.id and s.device_id = auth.uid())
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Part 3: a place in a paid room is a pass.
-- ---------------------------------------------------------------------

-- Same return shape as 0007; one new argument, so the old one goes first.
-- In order: a developer; a running room or per-device pass; a room whose
-- clock has not started (started now if start_clock, otherwise reported
-- eligible with no expiry yet); a per-device pass not yet activated (which,
-- as before, starts on this first check).
--
-- `#variable_conflict use_column`: the OUT parameters share names with
-- columns of both tables (expires_at, product, game_id) -- the trap 0002
-- hit -- and every reference here is meant as the column.
drop function check_and_activate_entitlement();
create function check_and_activate_entitlement(start_clock boolean default false) returns table (
  eligible boolean, product text, expires_at timestamptz, game_id uuid
) language plpgsql security definer
  set search_path = public
as $$
#variable_conflict use_column
declare
  row_ entitlements;
  room_ games;
begin
  if is_developer() then
    return query select true, 'developer'::text, now() + interval '30 days', null::uuid;
    return;
  end if;

  select g.* into room_ from games g join room_seats s on s.game_id = g.id
    where s.device_id = auth.uid() and g.pass_status = 'paid' and g.expires_at > now()
    order by g.expires_at desc limit 1;
  if found then
    return query select true, room_.pass_product, room_.expires_at, room_.id;
    return;
  end if;

  select * into row_ from entitlements
    where entitlements.device_id = auth.uid()
      and entitlements.status = 'activated'
      and entitlements.expires_at > now()
    order by entitlements.expires_at desc limit 1;
  if found then
    return query select true, row_.product, row_.expires_at, row_.game_id;
    return;
  end if;

  select g.* into room_ from games g join room_seats s on s.game_id = g.id
    where s.device_id = auth.uid() and g.pass_status = 'paid' and g.started_at is null
    order by s.seated_at desc limit 1;
  if found then
    if start_clock then
      -- coalesce: another phone in the room may have started it a moment ago.
      update games set
          started_at = coalesce(games.started_at, now()),
          expires_at = coalesce(games.expires_at, now() + (games.duration_s || ' seconds')::interval)
        where games.id = room_.id
        returning * into room_;
    end if;
    return query select true, room_.pass_product, room_.expires_at, room_.id;
    return;
  end if;

  select * into row_ from entitlements
    where entitlements.device_id = auth.uid() and entitlements.status = 'pending'
    order by entitlements.purchased_at asc limit 1;
  if found then
    update entitlements set status = 'activated', activated_at = now(),
      expires_at = now() + (row_.duration_s || ' seconds')::interval
      where entitlements.id = row_.id returning * into row_;
    return query select true, row_.product, row_.expires_at, row_.game_id;
    return;
  end if;

  return query select false, null::text, null::timestamptz, null::uuid;
end;
$$;

-- The code to offer on the Game tab: a room this device bought that still
-- has time (paid or still being paid for), else, as in 0005, the game a
-- granted per-device pass named.
create or replace function entitled_game_code() returns text
  language sql security definer stable
  set search_path = public
as $$
  select code from (
    select g.join_code as code, 0 as rank, g.created_on as at
    from games g
    where g.created_by = auth.uid()
      and g.pass_status is not null
      and (g.expires_at is null or g.expires_at > now())
    union all
    select g.join_code, 1, e.purchased_at
    from entitlements e
    join games g on g.id = e.game_id
    where e.device_id = auth.uid()
  ) c
  order by rank, at desc
  limit 1
$$;
