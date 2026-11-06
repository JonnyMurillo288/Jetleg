-- Deleting your own account, from the app.
--
-- Until now the privacy page said "to have an account removed, ask". That
-- is not good enough once strangers sign up: deleting an account has to be
-- something a person can do themselves, at once.
--
-- Everything that is theirs already hangs off their auth.users row (0001,
-- 0006, 0014, 0016), so one delete does it:
--
--   gone with it    profile and display name, team memberships, maps they
--                   published (with versions and discussion), comments,
--                   likes, comment votes, reports they made, any old
--                   per-device pass (0002)
--   kept, unlinked  a place they took in a paid game room (0015): the seat
--                   stays counted with no owner, so a place cannot be freed
--                   by deleting an account and handed on; a room they
--                   bought (games.created_by goes null), which the other
--                   players paid into as much as they did
--
-- Branches other people made of their maps stay, pointing at nothing
-- (0006, 0009). Rounds on their phone are untouched: those were never on
-- the server.

create function delete_my_account() returns void
  language plpgsql security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'There is no account here to delete';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function delete_my_account() from public, anon;
grant execute on function delete_my_account() to authenticated;
