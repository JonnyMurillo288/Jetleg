// Admin tool: give someone developer access — free play, on any device they
// sign in on, with nothing to buy or renew (0007_developers.sql).
//
// The person then opens the app and signs in with that email: on the paywall
// ("Developer or tester?") or under Map > Community maps. Locally, the
// six-digit code lands in the mail catcher at http://127.0.0.1:54324.
//
// Usage:
//   cd app
//   npx tsx grant-developer.ts someone@example.com ["a note"]
//   npx tsx grant-developer.ts someone@example.com --remove
//   npx tsx grant-developer.ts --list
//
// Defaults to the local Supabase stack. For a real project:
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npx tsx grant-developer.ts ...
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const [, , first, second] = process.argv;

(async () => {
  const supabase = createClient(url, serviceRoleKey);

  if (first === '--list') {
    const { data, error } = await supabase.from('developers').select('email, note, added_at').order('added_at');
    if (error) throw new Error(error.message);
    if (!data.length) console.log(`No developers on ${url}.`);
    for (const d of data) console.log(`${d.email}${d.note ? `  — ${d.note}` : ''}`);
    return;
  }

  if (!first || !first.includes('@')) {
    console.error('Usage: npx tsx grant-developer.ts <email> ["note"] | <email> --remove | --list');
    process.exit(1);
  }
  const email = first.trim().toLowerCase();

  if (second === '--remove') {
    const { data, error } = await supabase.from('developers').delete().eq('email', email).select('email');
    if (error) throw new Error(error.message);
    console.log(data.length ? `Removed developer access for ${email} on ${url}.` : `${email} had no developer access on ${url}.`);
    return;
  }

  const { error } = await supabase.from('developers').upsert({ email, note: second ?? null });
  if (error) throw new Error(error.message);
  console.log(`${email} has developer access on ${url}.`);
  console.log('They sign in with that email in the app — on the paywall, or under Map > Community maps.');
  if (url.includes('127.0.0.1') || url.includes('localhost')) {
    console.log('Local stack: the sign-in code arrives in the mail catcher at http://127.0.0.1:54324');
  }
})().catch((e) => {
  console.error('grant-developer failed:', e.message ?? e);
  process.exit(1);
});
