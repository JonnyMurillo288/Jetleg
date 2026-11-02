-- In-game chat: who may use a game's chat channel. Nothing else.
--
-- The chat stores nothing on the server -- no table, no bucket. Questions,
-- answers, messages and photos travel as Realtime *Broadcast* messages on a
-- private channel, `chat:<game id>`, which Realtime relays to whoever is
-- subscribed at that instant and keeps no copy of (the same mechanism, and
-- the same check, as live positions in 0005: realtime.messages stays empty).
-- Each phone keeps its own copy, in its own storage, with the game's rounds;
-- it goes wherever that phone's game file goes and is deleted with them.
--
-- A phone that was asleep catches up from the others' copies when it comes
-- back (src/chat/useGameChat.ts), not from here.
--
-- Unlike `game:<id>`, a hider may send on this channel -- answering is the
-- hider's whole part in it. That is safe for the fairness rule because the
-- two channels are separate topics: the hider still has no write access to
-- `game:<id>`, where positions go, and no location listener subscribes to
-- `chat:<id>`. What the hider does send is chosen by a person (an answer, a
-- message) or is a photo with its location metadata removed on the phone
-- before it leaves (src/chat/photo.ts).

create policy "game members receive chat" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() in (select 'chat:' || g from my_game_ids() g)
  );

create policy "game members send chat" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() in (select 'chat:' || g from my_game_ids() g)
  );
