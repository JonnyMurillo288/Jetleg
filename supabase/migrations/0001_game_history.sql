-- Phase 1 backend: end-of-game history sync.
--
-- Implementation note, a deliberate refinement of the approved plan: the
-- plan described `profiles` as a client-generated id gated by a "soft
-- guard" RLS check on a client-asserted profile_id. Postgres RLS cannot
-- actually verify a value the client supplies in its own request — a soft
-- guard built that way blocks nothing, since any anon-key holder can just
-- assert a different id. Supabase's anonymous auth (no email/password
-- prompt, same "no visible login" UX the plan asked for) gives a real
-- `auth.uid()` to gate on instead, so `profiles.id` is `auth.users.id`
-- from an anonymous sign-in rather than a bare client-generated uuid. This
-- is the one deviation from the plan as written — flagged for review.
--
-- Nothing else here syncs a raw GPS point, a clock time, or anything about
-- a round still in progress. See ROADMAP.md and
-- .claude/skills/jetleg/references/architecture.md for the full picture.

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_on date not null default current_date
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  join_code text not null unique,
  created_on date not null default current_date
);

create table team_members (
  team_id uuid not null references teams (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  primary key (team_id, profile_id)
);

create table games (
  id uuid primary key,
  user_id uuid not null references profiles (id),
  team_id uuid not null references teams (id),
  city text not null default 'sf',
  size text not null check (size in ('small', 'medium', 'large')),
  settings jsonb not null default '{}',
  played_on date not null default current_date,
  raw_state jsonb not null
);

create table rounds (
  id uuid primary key,
  game_id uuid not null references games (id) on delete cascade,
  role text not null check (role in ('seeker', 'hider')),
  label text not null,
  hider_station_id text,
  played_on date not null,
  duration_s int
);

create table asks (
  id uuid primary key,
  round_id uuid not null references rounds (id) on delete cascade,
  seq int not null,
  question_id text not null,
  category text not null,
  played_on date not null,
  origin_lon double precision,
  origin_lat double precision,
  destination_lon double precision,
  destination_lat double precision,
  distance_m int,
  answer jsonb not null,
  note text,
  disabled boolean not null default false
);

create index games_team_id_idx on games (team_id);
create index rounds_game_id_idx on rounds (game_id);
create index asks_round_id_idx on asks (round_id);
create index team_members_profile_id_idx on team_members (profile_id);

-- Security-definer helper: policies on team_members and on games/rounds/asks
-- both need "which teams is this profile on", and a policy that queries
-- team_members from within team_members' own policy is infinite recursion
-- (Postgres re-evaluates RLS on every reference to the table, including from
-- inside another policy's subquery). Running as the function owner bypasses
-- RLS on that one internal lookup instead of re-triggering it.
create function my_team_ids() returns setof uuid
  language sql security definer stable
  set search_path = public
as $$
  select team_id from team_members where profile_id = auth.uid()
$$;

alter table profiles enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
alter table games enable row level security;
alter table rounds enable row level security;
alter table asks enable row level security;

-- profiles: only the anonymous-auth user themself.
create policy "profiles: own row" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- teams: no game data lives here, just a shareable code. Any signed-in
-- (anonymous or not) device may look one up to join it, or create a new one.
create policy "teams: any signed-in device" on teams
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- team_members: see and manage your own memberships, and see who else is
-- on a team you're already a member of.
create policy "team_members: own or shared team" on team_members
  for select using (
    profile_id = auth.uid()
    or team_id in (select my_team_ids())
  );
create policy "team_members: join as self" on team_members
  for insert with check (profile_id = auth.uid());
create policy "team_members: leave as self" on team_members
  for delete using (profile_id = auth.uid());

-- games / rounds / asks: only readable/writable by a member of the game's team.
create policy "games: team member" on games
  for all using (
    team_id in (select my_team_ids())
  ) with check (
    user_id = auth.uid()
    and team_id in (select my_team_ids())
  );

create policy "rounds: team member" on rounds
  for all using (
    game_id in (select id from games where team_id in (select my_team_ids()))
  ) with check (
    game_id in (select id from games where team_id in (select my_team_ids()))
  );

create policy "asks: team member" on asks
  for all using (
    round_id in (
      select r.id from rounds r
      join games g on g.id = r.game_id
      where g.team_id in (select my_team_ids())
    )
  ) with check (
    round_id in (
      select r.id from rounds r
      join games g on g.id = r.game_id
      where g.team_id in (select my_team_ids())
    )
  );
