-- Up and down votes on a map's comments, so its discussion can lead with
-- what people found most useful rather than with whatever was said first.
--
-- Shaped exactly like likes on a map (0006, part 6):
--
--   community_comment_votes   one row per user per comment: 1 up, -1 down
--   up_count / down_count     totals on the comment row, recounted by a
--                             trigger, never written by a client
--   score                     up minus down, what the thread is ordered by
--
-- `map_id` is copied onto each vote so the app can fetch "my votes on this
-- map" in one filter, instead of listing every comment id in a URL.
--
-- Who may do what:
--   read      totals: everyone. Who voted what: only the voter, as with likes.
--   write     a signed-in user, through vote_on_comment(), on anyone's
--             comment but their own.

alter table community_comments
  add column up_count int not null default 0,
  add column down_count int not null default 0,
  add column score int generated always as (up_count - down_count) stored;

create index community_comments_map_score_idx on community_comments (map_id, score desc, created_at);

create table community_comment_votes (
  comment_id uuid not null references community_comments (id) on delete cascade,
  map_id uuid not null references community_maps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index community_comment_votes_mine_idx on community_comment_votes (map_id, user_id);

alter table community_comment_votes enable row level security;

-- No insert, update or delete policy: written only by vote_on_comment().
create policy "community_comment_votes: own, read only" on community_comment_votes
  for select using (user_id = auth.uid());

-- 1 up, -1 down, 0 takes it back.
create function vote_on_comment(comment uuid, new_value int) returns void
  language plpgsql security definer
  set search_path = public
as $$
declare
  target_ community_comments;
begin
  if not is_signed_in() then
    raise exception 'Sign in with your email to do that';
  end if;
  select * into target_ from community_comments where id = comment;
  if not found then
    raise exception 'That comment no longer exists';
  end if;
  if target_.author_id = auth.uid() then
    raise exception 'You cannot vote on your own comment';
  end if;
  if new_value = 0 then
    delete from community_comment_votes where comment_id = comment and user_id = auth.uid();
  elsif new_value in (-1, 1) then
    insert into community_comment_votes (comment_id, map_id, user_id, value)
      values (comment, target_.map_id, auth.uid(), new_value)
      on conflict (comment_id, user_id) do update set value = excluded.value;
  else
    raise exception 'A vote is 1, -1 or 0';
  end if;
end;
$$;
revoke execute on function vote_on_comment(uuid, int) from public;
grant execute on function vote_on_comment(uuid, int) to authenticated;

-- Lock, then recount, for the reasons given above community_reaction_changed_()
-- in 0006: incrementing loses votes cast at the same moment.
create function community_comment_vote_changed_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
declare
  comment_id_ uuid := coalesce(new.comment_id, old.comment_id);
begin
  perform pg_advisory_xact_lock(hashtextextended(comment_id_::text, 0));
  update community_comments set
      up_count = (select count(*) from community_comment_votes v where v.comment_id = comment_id_ and v.value = 1),
      down_count = (select count(*) from community_comment_votes v where v.comment_id = comment_id_ and v.value = -1)
    where id = comment_id_;
  return null;
end;
$$;
create trigger community_comment_vote_changed after insert or update or delete on community_comment_votes
  for each row execute function community_comment_vote_changed_();
