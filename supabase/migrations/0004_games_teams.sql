-- Introduces the real top-level "game" concept: multiple teams (opponents)
-- belonging to one game, each team holding multiple players (team_members,
-- unchanged). An entitlement can now be scoped to a game, so an admin can
-- grant several tokens that all belong together.
--
-- This forces a rename: `games` already meant something else here -- one
-- team's *synced history* of an already-completed round (raw_state,
-- team_id, played_on), from 0001_game_history.sql. That's a different
-- concept from "a container of opponents," and both can't be called
-- `games`. Renamed to `sessions`. Nothing is deployed to a real cloud
-- project yet, so this rename is free right now.

-- ---------------------------------------------------------------------
-- Part 1: games -> sessions, and every reference to it.
-- ---------------------------------------------------------------------

alter table games rename to sessions;
alter index games_team_id_idx rename to sessions_team_id_idx;
alter policy "games: team member" on sessions rename to "sessions: team member";

alter table rounds rename column game_id to session_id;
alter index rounds_game_id_idx rename to rounds_session_id_idx;

-- ALTER POLICY can rename a policy but not rewrite its USING/CHECK
-- expression, and both of these embed `games`/`game_id` in their body --
-- dropped and recreated verbatim against the renamed table/column.
drop policy "rounds: team member" on rounds;
create policy "rounds: team member" on rounds
  for all using (
    session_id in (select id from sessions where team_id in (select my_team_ids()))
  ) with check (
    session_id in (select id from sessions where team_id in (select my_team_ids()))
  );

drop policy "asks: team member" on asks;
create policy "asks: team member" on asks
  for all using (
    round_id in (
      select r.id from rounds r
      join sessions s on s.id = r.session_id
      where s.team_id in (select my_team_ids())
    )
  ) with check (
    round_id in (
      select r.id from rounds r
      join sessions s on s.id = r.session_id
      where s.team_id in (select my_team_ids())
    )
  );

-- ---------------------------------------------------------------------
-- Part 2: the new top-level `games` table, and the two FKs onto it.
-- ---------------------------------------------------------------------

-- Multiple teams (opponents) belong to one game. RLS enabled, no policies
-- at all -- closed to every non-service-role caller for now. Nothing worth
-- exposing lives on this row yet (id + created_on only); open it up once
-- there's an actual field to read.
--
-- A free capability this already unlocks with zero new policy: `teams`
-- already has `for all using (auth.uid() is not null)` -- any signed-in
-- device can already read any team row, unrestricted by membership (needed
-- today so a join-code lookup works before you're a member). So the moment
-- `teams.game_id` exists, "which teams are in my game" already works via
-- `select * from teams where game_id = X`, no new policy required. What
-- stays exactly as gated as before: `rounds`/`asks` (round data, hider
-- position) -- still strictly `my_team_ids()`-only, untouched by this
-- migration.
create table games (
  id uuid primary key default gen_random_uuid(),
  created_on date not null default current_date
);
alter table games enable row level security;

alter table teams add column game_id uuid references games (id) on delete set null;
create index teams_game_id_idx on teams (game_id);

alter table entitlements add column game_id uuid references games (id) on delete set null;
create index entitlements_game_id_idx on entitlements (game_id);

-- ---------------------------------------------------------------------
-- Part 3: check_and_activate_entitlement() reports game_id too.
-- ---------------------------------------------------------------------

-- CREATE OR REPLACE can't change a function's RETURNS TABLE columns.
drop function check_and_activate_entitlement();

create function check_and_activate_entitlement() returns table (
  eligible boolean, product text, expires_at timestamptz, game_id uuid
) language plpgsql security definer
  set search_path = public
as $$
declare
  row_ entitlements;
begin
  select * into row_ from entitlements
    where entitlements.device_id = auth.uid()
      and entitlements.status = 'activated'
      and entitlements.expires_at > now()
    order by entitlements.expires_at desc limit 1;
  if found then
    return query select true, row_.product, row_.expires_at, row_.game_id;
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
