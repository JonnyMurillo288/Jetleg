-- Google sign-in keeps an email and a name, and nothing else.
--
-- The app asks Google only for Supabase's default scopes, `openid email
-- profile`: the least Google offers that includes a person's name. But the
-- `profile` scope also hands over a profile picture and a locale, and
-- Supabase Auth stores every claim it is given, twice -- on the identity
-- (auth.identities.identity_data) and on the user
-- (auth.users.raw_user_meta_data). These triggers cut both down, as the row
-- is written, to an allow-list: who the account is, its email, its name.
--
-- An allow-list, not a list of what to drop, so a claim Google adds later is
-- not kept by default.
--
-- What stays, and why:
--   sub, provider_id, iss        the Google account id -- what signing in is
--   email, email_verified        what developer access and publishing check
--   phone_verified               Supabase's own flag, not Google data
--   name, full_name              offered as a display name, never used unasked
--
-- Only Google's data is touched: email and anonymous accounts carry nothing
-- here that is not on the list anyway, but they are left exactly as they are.

create function google_claims_only_(claims jsonb) returns jsonb
  language sql immutable
  set search_path = ''
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(coalesce(claims, '{}'::jsonb))
  where key in ('sub', 'provider_id', 'iss', 'email', 'email_verified', 'phone_verified', 'name', 'full_name')
$$;

create function google_identity_minimal_() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.provider = 'google' then
    new.identity_data := public.google_claims_only_(new.identity_data);
  end if;
  return new;
end;
$$;

create function google_user_minimal_() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if coalesce(new.raw_app_meta_data -> 'providers', '[]'::jsonb) ? 'google'
     or new.raw_app_meta_data ->> 'provider' = 'google' then
    new.raw_user_meta_data := public.google_claims_only_(new.raw_user_meta_data);
  end if;
  return new;
end;
$$;

-- Before insert *and* update: Supabase rewrites both on every sign-in, from
-- whatever Google sent that time.
create trigger google_identity_minimal
  before insert or update of identity_data, provider on auth.identities
  for each row execute function google_identity_minimal_();

create trigger google_user_minimal
  before insert or update of raw_user_meta_data, raw_app_meta_data on auth.users
  for each row execute function google_user_minimal_();

revoke execute on function google_identity_minimal_() from public, anon, authenticated;
revoke execute on function google_user_minimal_() from public, anon, authenticated;
