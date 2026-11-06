-- How fast one account may post.
--
-- Anyone with a verified email can publish, comment and report. Nothing
-- stopped one of them doing it a thousand times a minute: a page of spam
-- comments, a flood of near-identical maps, or reports to wear a moderator
-- out. These limits are far above anything a person playing the game does,
-- and low enough that a script gets nowhere.
--
--   comments   20 an hour
--   maps       10 new maps an hour (new versions of your own map are not limited)
--   reports    30 an hour
--
-- Counted from the table itself, so there is nothing to keep in step. The
-- message says how long to wait.

create function posting_limit_(what text, made int, allowed int) returns void
  language plpgsql immutable
as $$
begin
  if made >= allowed then
    raise exception 'Too many % in the last hour. Try again later.', what
      using errcode = 'P0001';
  end if;
end;
$$;

create function community_comment_rate_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
begin
  perform posting_limit_('comments',
    (select count(*)::int from community_comments c where c.author_id = new.author_id and c.created_at > now() - interval '1 hour'),
    20);
  return new;
end;
$$;
-- Named to sort after community_comment_inserting, which sets author_id.
create trigger community_comment_rate before insert on community_comments
  for each row execute function community_comment_rate_();

create function community_map_rate_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
begin
  perform posting_limit_('new maps',
    (select count(*)::int from community_maps m where m.author_id = new.author_id and m.created_at > now() - interval '1 hour'),
    10);
  return new;
end;
$$;
create trigger community_map_rate before insert on community_maps
  for each row execute function community_map_rate_();

create function community_report_rate_() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
begin
  perform posting_limit_('reports',
    (select count(*)::int from community_reports r where r.reporter_id = new.reporter_id and r.created_at > now() - interval '1 hour'),
    30);
  return new;
end;
$$;
create trigger community_report_rate before insert on community_reports
  for each row execute function community_report_rate_();
