// Admin tool: make someone a moderator — they see every report, and can hide
// or restore any map or comment (0016_moderation.sql).
//
// The person then signs in with that email in the app and finds
// "Moderation queue →" at the top of Community maps (or opens #/moderation).
//
// Usage:
//   cd app
//   npx tsx grant-moderator.ts someone@example.com ["a note"]
//   npx tsx grant-moderator.ts someone@example.com --remove
//   npx tsx grant-moderator.ts --list
//
// Defaults to the local Supabase stack. For a real project:
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npx tsx grant-moderator.ts ...
// or run in the project's SQL editor:
//   insert into moderators (email, note) values ('someone@example.com', 'a note');
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const [, , first, second] = process.argv;

(async () => {
  const supabase = createClient(url, serviceRoleKey);

  if (first === '--list') {
    const { data, error } = await supabase.from('moderators').select('email, note, added_at').order('added_at');
    if (error) throw new Error(error.message);
    if (!data.length) console.log(`No moderators on ${url}.`);
    for (const m of data) console.log(`${m.email}${m.note ? `  — ${m.note}` : ''}`);
    return;
  }

  if (!first || !first.includes('@')) {
    console.error('Usage: npx tsx grant-moderator.ts <email> ["note"] | <email> --remove | --list');
    process.exit(1);
  }
  const email = first.trim().toLowerCase();

  if (second === '--remove') {
    const { data, error } = await supabase.from('moderators').delete().eq('email', email).select('email');
    if (error) throw new Error(error.message);
    console.log(data.length ? `${email} is no longer a moderator on ${url}.` : `${email} was not a moderator on ${url}.`);
    return;
  }

  const { error } = await supabase.from('moderators').upsert({ email, note: second ?? null });
  if (error) throw new Error(error.message);
  console.log(`${email} is a moderator on ${url}.`);
  console.log('They sign in with that email, then open Community maps > Moderation queue (or #/moderation).');
})().catch((e) => {
  console.error('grant-moderator failed:', e.message ?? e);
  process.exit(1);
});
