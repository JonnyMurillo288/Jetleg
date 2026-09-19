-- Phase 3 backend: paid, per-device entitlements.
--
-- Every round -- including fully local, solo play -- now requires a device
-- to hold a valid entitlement token. Keyed on auth.users.id directly, not
-- profiles.id: a solo player who never touches team sync still needs a
-- device identity to pay, and should never be forced to pick a display name
-- just for that. See BACKEND_TESTING.md / PAYMENTS_TESTING.md and
-- .claude/skills/jetleg/references/architecture.md for the full picture.
--
-- Security model: Stripe verifies the money, a webhook (service role, this
-- migration grants it no special policy because service_role bypasses RLS
-- entirely) is the only thing that ever inserts a row, and the
-- security-definer function below is the only thing that ever updates one.
-- No policy here grants the client insert/update on this table at all --
-- unlike my_team_ids() (a security-definer *read*, to dodge RLS recursion),
-- this is a security-definer *write*, for the same underlying reason: the
-- table's own RLS must never trust anything the client asserts about its
-- own eligibility.

create table entitlements (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references auth.users (id) on delete cascade,
  product text not null check (product in ('single_game', 'week_pass')),
  status text not null default 'pending' check (status in ('pending', 'activated')),
  duration_s int not null,
  purchased_at timestamptz not null default now(),
  activated_at timestamptz,
  expires_at timestamptz,
  stripe_session_id text not null unique,
  stripe_customer_email text
);

create index entitlements_device_id_idx on entitlements (device_id);
create index entitlements_email_idx on entitlements (stripe_customer_email);

alter table entitlements enable row level security;

-- Read-only for the owning device, so the app can show "time remaining"
-- without a round trip through the RPC below.
create policy "entitlements: own row, read only" on entitlements
  for select using (device_id = auth.uid());

-- Activates the calling device's oldest still-pending entitlement on first
-- use (the 72h/7d window starts now, not at purchase), and reports current
-- eligibility. A repeat call during an already-activated window is a pure
-- read -- expires_at > now() -- and activates nothing further, so one
-- purchase covers unlimited round-starts until it lapses.
--
-- Every column reference below is qualified with the `entitlements` alias.
-- The OUT parameters are named `product`/`expires_at` to match the table's
-- own columns for a readable return shape, but that name collision makes an
-- unqualified reference genuinely ambiguous to plpgsql inside embedded SQL
-- -- caught by actually calling this from verify-payments.ts, not by
-- reading the SQL.
create function check_and_activate_entitlement() returns table (
  eligible boolean, product text, expires_at timestamptz
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
    return query select true, row_.product, row_.expires_at;
    return;
  end if;

  select * into row_ from entitlements
    where entitlements.device_id = auth.uid() and entitlements.status = 'pending'
    order by entitlements.purchased_at asc limit 1;
  if found then
    update entitlements set status = 'activated', activated_at = now(),
      expires_at = now() + (row_.duration_s || ' seconds')::interval
      where entitlements.id = row_.id returning * into row_;
    return query select true, row_.product, row_.expires_at;
    return;
  end if;

  return query select false, null::text, null::timestamptz;
end;
$$;
