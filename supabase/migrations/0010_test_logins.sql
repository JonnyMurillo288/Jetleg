-- A fixed sign-in code for testing.
--
-- Sign-in is a six-digit code sent by email (0006). That is right for
-- players and tedious for whoever is testing: locally the code has to be
-- fished out of the mail catcher every time, and on a project with no mail
-- provider set up yet it cannot be had at all.
--
-- So the `test-login` edge function accepts one fixed code instead -- but a
-- fixed code that worked for everyone would be a master key to every
-- account. Two things have to be true for it to do anything:
--
--   1. The function's TEST_LOGIN_CODE secret is set. It is unset by default,
--      and each environment sets its own. Unset means the feature is off.
--   2. The email is on this list. Only these addresses can be signed into
--      with the code; every other account still needs its emailed code.
--
-- A six-digit code can be guessed, so wrong attempts are counted per
-- address and the address locks after ten until it is unlocked by hand
-- (`npx tsx test-login.ts <email> --unlock`).
--
-- Like `developers` (0007) the list is data, not migration: nobody's address
-- is committed, and local, staging and production each have their own.

create table test_logins (
  email text primary key check (email = lower(btrim(email)) and email <> ''),
  failed_attempts int not null default 0,
  note text,
  added_at timestamptz not null default now()
);

-- RLS on, no policies: only the service role (the function, the script).
alter table test_logins enable row level security;
