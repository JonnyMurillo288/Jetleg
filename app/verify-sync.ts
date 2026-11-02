// Verification for the game-history sync (src/sync/). Exercises the real
// identity -> payload -> insert path against a running Supabase (local by
// default) and asserts at the layer that actually matters: what a second,
// unrelated device can read back — not just that the sanitizer's output
// looks right in isolation.
//
// Requires `supabase start` first. Run against another environment with
// SUPABASE_URL / SUPABASE_ANON_KEY env vars.
import { createClient } from '@supabase/supabase-js';
import { buildGamePayload } from './src/sync/payload';
import { writeRound } from './src/sync/write';
import { metres } from './src/engine/project';
import { QUESTIONS } from './src/engine/questions';
import type { Round } from './src/store/game';

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fail.push(name);
};

const radar = QUESTIONS.find((q) => q.category === 'radar');
const matching = QUESTIONS.find((q) => q.category === 'matching');
if (!radar || !matching) throw new Error('fixture questions not found in catalog');

const trueOrigin: [number, number] = [-122.4194, 37.7793]; // seeker's real GPS, never meant to sync

function makeRound(): Round {
  return {
    id: crypto.randomUUID(),
    role: 'seeker',
    label: 'verify:sync fixture round',
    startedAt: Date.now() - 45 * 60 * 1000,
    endedAt: Date.now(),
    hiderStationId: 'theembarcaderostockton',
    asks: [
      {
        id: crypto.randomUUID(),
        questionId: radar.id,
        askedAt: Date.now() - 30 * 60 * 1000,
        origin: trueOrigin,
        distanceM: 800,
        answer: { kind: 'yesno', value: 'yes' },
      },
      {
        id: crypto.randomUUID(),
        questionId: matching.id,
        askedAt: Date.now() - 10 * 60 * 1000,
        origin: trueOrigin,
        answer: { kind: 'yesno', value: 'yes' },
      },
    ],
  };
}

const settings = { gameSize: 'medium', strictness: 'strict', units: 'imperial', supervisorDistrictsAsAdmin4: false };

async function signInDevice(displayName: string) {
  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`sign-in failed for ${displayName}: ${error?.message}`);
  await client.from('profiles').upsert({ id: data.user.id, display_name: displayName });
  return { client, profile: { id: data.user.id, displayName } };
}

(async () => {
  const { client: deviceA, profile: profileA } = await signInDevice('verify-sync device A');
  const joinCode = 'VRFY' + Math.floor(Math.random() * 100);
  const { data: team, error: teamError } = await deviceA
    .from('teams')
    .insert({ join_code: joinCode })
    .select('id, join_code')
    .single();
  check('device A can create a team', !teamError && !!team, teamError?.message);

  const { error: memberError } = await deviceA
    .from('team_members')
    .insert({ team_id: team!.id, profile_id: profileA.id });
  check('device A can join its own team', !memberError, memberError?.message);

  const round = makeRound();
  const sessionId = crypto.randomUUID();
  const payload = buildGamePayload(round, settings, profileA, { id: team!.id, joinCode: team!.join_code }, sessionId);

  const radarAsk = payload.asks.find((a) => a.category === 'radar')!;
  const matchingAsk = payload.asks.find((a) => a.category === 'matching')!;

  check('radar point never equals the true point', radarAsk.origin_lon !== trueOrigin[0] || radarAsk.origin_lat !== trueOrigin[1]);
  const jitterDistance = metres(trueOrigin, [radarAsk.origin_lon!, radarAsk.origin_lat!]);
  check('radar point is jittered within ~1km of the true point', jitterDistance > 0 && jitterDistance <= 1000, `${jitterDistance.toFixed(1)} m`);
  check('matching ask carries no position at all', matchingAsk.origin_lon === null && matchingAsk.origin_lat === null);
  check('round played_on is a date, not a timestamp', /^\d{4}-\d{2}-\d{2}$/.test(payload.round.played_on), payload.round.played_on);
  check('no ask carries a raw askedAt/time field', !('askedAt' in radarAsk) && !('asked_at' in radarAsk));
  check('payload never carries seekerPin in any form', JSON.stringify(payload).toLowerCase().includes('seekerpin') === false);

  const { error: sessionError } = await deviceA.from('sessions').insert(payload.session);
  check('device A can insert its own session', !sessionError, sessionError?.message);
  const { error: roundError } = await deviceA.from('rounds').insert(payload.round);
  check('device A can insert its own round', !roundError, roundError?.message);
  const { error: asksError } = await deviceA.from('asks').insert(payload.asks);
  check('device A can insert its own asks', !asksError, asksError?.message);

  const { data: readBack } = await deviceA.from('sessions').select('raw_state').eq('id', sessionId).single();
  check('device A reads back the row it wrote', !!readBack, readBack);
  check(
    'stored row still shows the jittered point, not the true one',
    !!readBack && JSON.stringify(readBack.raw_state).includes(String(trueOrigin[0])) === false,
  );

  // The fairness-shaped check: an unrelated device, also validly signed in,
  // must not be able to read this session at all.
  const { client: deviceB } = await signInDevice('verify-sync device B (outsider)');
  const { data: outsiderRead, error: outsiderError } = await deviceB.from('sessions').select('id').eq('id', sessionId);
  check('an outsider device reads back zero rows for this session', !outsiderError && (outsiderRead?.length ?? -1) === 0, outsiderRead);

  const { error: outsiderInsertError } = await deviceB.from('sessions').insert({ ...payload.session, id: crypto.randomUUID() });
  check('an outsider device cannot insert into a team it is not on', !!outsiderInsertError);

  // ---- a round resumed after it ended, and ended again
  // The first send above used a random session id, as rounds synced before
  // resuming existed did. The second goes through the app's own write, with
  // the round's id as the session's, one question deleted and one added.
  const resumed: Round = {
    ...round,
    endedAt: round.endedAt! + 3_600_000,
    asks: [
      ...round.asks.slice(1),
      { ...round.asks[0], id: crypto.randomUUID(), askedAt: round.asks[0].askedAt + 1_800_000 },
    ],
  };
  const again = buildGamePayload(resumed, settings, profileA, { id: team!.id, joinCode: team!.join_code }, resumed.id);
  const rewrite = await writeRound(deviceA, again);
  check('a resumed round, ended again, syncs instead of failing on its own id', rewrite.ok, rewrite);
  const { data: rows } = await deviceA.from('rounds').select('id, session_id').eq('id', round.id);
  check('...as one round, not two', rows?.length === 1 && rows[0].session_id === resumed.id, rows);
  const { data: theAsks } = await deviceA.from('asks').select('id').eq('round_id', round.id);
  const want = again.asks.map((a) => a.id).sort();
  check('...whose questions are the ones it has now, the deleted one gone', JSON.stringify((theAsks ?? []).map((a) => a.id).sort()) === JSON.stringify(want), { got: theAsks?.length, want: want.length });
  const { data: oldSession } = await deviceA.from('sessions').select('id').eq('id', sessionId);
  check('...and the session it was first sent under is gone with it', oldSession?.length === 0, oldSession);
  const retry = await writeRound(deviceA, again);
  const { data: afterRetry } = await deviceA.from('asks').select('id').eq('round_id', round.id);
  check('sending the same round twice (a retry) changes nothing', retry.ok && afterRetry?.length === want.length, retry);
  const theirs = await writeRound(deviceB, { ...again, session: { ...again.session, user_id: (await deviceB.auth.getUser()).data.user!.id } });
  const { data: stillMine } = await deviceA.from('rounds').select('session_id').eq('id', round.id).single();
  check('another team’s device cannot overwrite it', !theirs.ok && stillMine?.session_id === resumed.id, theirs);

  console.log(`\n${fail.length === 0 ? 'ALL PASS' : `${fail.length} FAILED: ${fail.join(', ')}`}`);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify:sync crashed:', e);
  process.exit(1);
});
