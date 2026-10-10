-- Developer access: named people who play free, on any device they sign in on.
--
-- A pass (0002) is bought or granted per device and runs out. That is the
-- wrong shape for the people building and testing the game, who need to
-- start rounds on whatever phone or browser profile is in front of them,
-- repeatedly, forever. So: a short list of email addresses. Anyone signed in
-- with a *verified* email on that list (is_signed_in(), 0006) is eligible,
-- with nothing to buy, restore or renew.
--
-- The list is deliberately not in this migration. It is data, managed with
-- `npx tsx grant-developer.ts <email>` against whichever project you mean,
-- so no one's address is committed to the repository and local, staging and
-- production each have their own.

create table developers (
  email text primary key check (email = lower(btrim(email)) and email <> ''),
  note text,
  added_at timestamptz not null default now()
);

-- RLS on, no policies: invisible and unwritable to every client. Only the
-- service role (grant-developer.ts) and the definer function below read it.
alter table developers enable row level security;

create function is_developer() returns boolean
  language sql security definer stable
  set search_path = public
as $$
  select is_signed_in()
    and exists (select 1 from developers d where d.email = lower(auth.jwt() ->> 'email'))
$$;

-- Same function as 0004, with one case added in front. `product` reads
-- 'developer', and the window is always thirty days from *now*: the app
-- caches the answer so an entitled device keeps working with no signal, and
-- a rolling window means a developer taken off the list stops being
-- eligible offline within a month, and online at once.
create or replace function check_and_activate_entitlement() returns table (
  eligible boolean, product text, expires_at timestamptz, game_id uuid
) language plpgsql security definer
  set search_path = public
as $$
declare
  row_ entitlements;
begin
  if is_developer() then
    return query select true, 'developer'::text, now() + interval '30 days', null::uuid;
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
