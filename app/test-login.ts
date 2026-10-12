// Admin tool: let an email address sign in with the fixed testing code
// instead of an emailed one (supabase/migrations/0010_test_logins.sql).
//
// Two halves, and both are needed:
//   1. the code itself — the TEST_LOGIN_CODE secret, per environment.
//        local:  put TEST_LOGIN_CODE=123456 in supabase/functions/.env, then
//                `npx supabase stop && npx supabase start`
//        cloud:  npx supabase secrets set TEST_LOGIN_CODE=123456
//                npx supabase functions deploy test-login
//   2. who may use it — this script.
//
// Usage:
//   cd app
//   npx tsx test-login.ts someone@example.com ["a note"]
//   npx tsx test-login.ts someone@example.com --remove
//   npx tsx test-login.ts someone@example.com --unlock    # after ten wrong codes
//   npx tsx test-login.ts --list
//
// In the app: enter the email, tap "I have a testing code" (or "Email me a
// code" — either works), and type the code.
//
// Defaults to the local Supabase stack. For a real project:
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npx tsx test-login.ts ...
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const [, , first, second] = process.argv;

(async () => {
  const supabase = createClient(url, serviceRoleKey);

  if (first === '--list') {
    const { data, error } = await supabase.from('test_logins').select('email, failed_attempts, note').order('added_at');
    if (error) throw new Error(error.message);
    if (!data.length) console.log(`No testers on ${url}.`);
    for (const t of data) console.log(`${t.email}${t.failed_attempts >= 10 ? '  [LOCKED — --unlock]' : t.failed_attempts ? `  (${t.failed_attempts} wrong attempts)` : ''}${t.note ? `  — ${t.note}` : ''}`);
    return;
  }

  if (!first || !first.includes('@')) {
    console.error('Usage: npx tsx test-login.ts <email> ["note"] | <email> --remove | <email> --unlock | --list');
    process.exit(1);
  }
  const email = first.trim().toLowerCase();

  if (second === '--remove') {
    const { data, error } = await supabase.from('test_logins').delete().eq('email', email).select('email');
    if (error) throw new Error(error.message);
    console.log(data.length ? `${email} can no longer use the testing code on ${url}.` : `${email} was not a tester on ${url}.`);
    return;
  }
  if (second === '--unlock') {
    const { data, error } = await supabase.from('test_logins').update({ failed_attempts: 0 }).eq('email', email).select('email');
    if (error) throw new Error(error.message);
    console.log(data.length ? `${email} is unlocked on ${url}.` : `${email} is not a tester on ${url}.`);
    return;
  }

  const { error } = await supabase.from('test_logins').upsert({ email, note: second ?? null, failed_attempts: 0 });
  if (error) throw new Error(error.message);
  console.log(`${email} can sign in with the testing code on ${url}.`);
  console.log('The code is whatever TEST_LOGIN_CODE is set to there; unset, nothing happens.');
})().catch((e) => {
  console.error('test-login failed:', e.message ?? e);
  process.exit(1);
});
