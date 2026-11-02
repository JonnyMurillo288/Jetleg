---
name: jetleg-chat
description: How JetLeg's in-game chat works — the Questions thread (a seeker asks a catalog question, a countdown runs, a hider answers by hand with hit/miss, closer/further, a tentacle place, null, or a photo), the separate free Chat thread, photo answers pinned to their question and shown as a drop-down under the seeker's Photo category, and how a chat answer lands in the seeker's ask log and the hider's exposure log. The chat is never stored on a server — it travels phone to phone over a Realtime broadcast relay and each phone keeps its own copy with its rounds, in the game file, deleted with them. Use when changing app/src/chat/, ui/ChatPanel.tsx, ui/ChatPhotos.tsx, the Chat button in TopBar, "Ask in game chat" on a question row, the game file's `chats`, or supabase/migrations/0013_game_chat.sql; when a player says a question, answer or photo never arrived, arrived twice, or is still on the phone after deleting; and before anything that touches what a photo or a chat item carries, because a photo's EXIF is the hider's exact position.
---

# The in-game chat

A game room (see the `jetleg` skill and `references/architecture.md`, "Game
rooms") has two threads, kept apart on purpose:

- **Questions**: the game. A seeker picks one of the 80 catalog questions,
  the hider's clock starts, and the hider answers *by hand*. The app never
  answers for them. It shows the hider what the answer assistant reads, as
  their own panel always has, but nothing is sent until a person picks an
  answer **and** confirms it. That is Jonny's decision; keep it.
- **Chat**: trash talk, rulings, "where ARE you". Text only.

**Nothing is stored on a server — Jonny's rule, explicitly.** No table, no
bucket. Every item is a Realtime *broadcast* on the private channel
`chat:<game id>`, which relays to whoever is listening and keeps nothing.
Each phone keeps its own copy in IndexedDB beside its rounds; it leaves the
phone only in the game file the player saves, and is deleted with the game
data. Do not add a table or a bucket "for reliability" — that is the one
change this design exists to refuse.

The general JetLeg rules (verification ladder, deploys, silent failures) are
in the `jetleg` skill. Read that too.

| File | Role |
|---|---|
| `supabase/migrations/0013_game_chat.sql` | Two policies on `realtime.messages`: game members may join and send on `chat:<game>`. Authorization only — no data. |
| `app/src/chat/chat.ts` | The pure half: event names, types, `parseQuestion`/`parseMessage`/`parseLog` (everything from another phone is checked), `mergeQuestion` (first answer wins, same on every phone), `hello`/`missingFor` (catch-up), photo pieces, `stripMetadata`/`hasExif`, labels, clock, unread. |
| `app/src/chat/useGameChat.ts` | Loads the phone's copy, saves every change, the channel, catch-up, sending (`ask`, `answer`, `answerPhoto`, `say`). |
| `app/src/chat/local.ts` | IndexedDB: `chat/log/<game>` and `chat/photo/<game>/<question>`; `forgetUnusedChats`; `withChats`/`restoreChats` for the game file. |
| `app/src/chat/subject.ts` | `subjectFor`: the seeker's own nearest one for a matching/measuring question — the name (and for measuring, the distance) sent with it. |
| `app/src/chat/photo.ts` | `preparePhoto`: canvas re-encode (1280 px, stepping quality down to ~250 KB), byte-level metadata strip, then a check. |
| `app/src/ui/ChatPanel.tsx` | Questions / Chat segments, `AskComposer`, `ChatQuestionCard`, `SubjectLine`, `AnswerBox`, and `Chat` — the messaging layout (bubbles, runs, day lines, pinned composer, "Sending…"/"Not sent · retry"). |
| `app/src/ui/ChatPhotos.tsx` | `PhotoThumb`, `Lightbox` (object URLs of the phone's copy), `Countdown` (its own 1 s timer). |
| `app/src/ui/SeekerPanel.tsx` | `PhotoDrawer` (the drop-down under Photo); passes `onAskInChat` to `QuestionRow`. |
| `app/src/App.tsx` | `askInChat`, the effect that applies answers, `logHiderAnswer`, stamping `Round.chatGames`, running `forgetUnusedChats`. |
| `app/src/store/game.ts` | `Round.chatAsks` (pending), `Round.chatGames`, `addChatAsk`, `applyChatAnswer`, `addChatGame`; `AskEntry.chatId`. |
| `app/src/stats/gamefile.ts` | Keeps `chatGames` and `chatId` through a file. The file's `chats` array is written and read by `local.ts`. |
| `app/src/chat/chat.test.ts` | Unit tests: parsing, merge order-independence, catch-up, pieces, EXIF strip. |
| `app/verify-chat.ts` | The relay: no table or bucket exists, members only, a hider can answer but still not send positions, a paced 250 KB photo arrives whole, the relay table stays empty. |
| `app/verify-chat-ui.cjs` | Two browsers, end to end, at the layers that fail (below). |

## The flow

```
seeker: Chat → Questions → AskComposer          seeker: Play → Ask → row → "Ask in game chat"
            └──────────────┬───────────────────────────────┘
                   App.askInChat(q, extra)
                     ├─ chat.ask() → broadcast 'q' { …question, askedAt, deadlineAt = askedAt + timeLimitMin }
                     └─ store.addChatAsk(id, { questionId, askedAt, origin, destination?, distanceM? })
                                                      ▲ stays on the seeker's phone, never sent
hider: Chat button badge (owed) → ChatQuestionCard → AnswerBox
            pick "Hit" → "Send “Hit”"  ──► chat.answer() → broadcast 'q' with the answer
            photo: <input capture> → preparePhoto → broadcast 'pc' pieces (24 KB, 450 ms apart)
                                                  → broadcast 'q' answered { kind: 'photo' }
            App.logHiderAnswer → hider's exposure log (origin = asker's live dot ?? seeker pin)

every phone: each 'q' / 'm' / 'pc' → parse → merge into its copy → saveLog / savePhoto
seeker:      App effect → store.applyChatAnswer(id, answer) → AskEntry { …pending, answer, chatId } → zone count moves

catch-up:    on join and on returning to the foreground a phone sends 'hello' (what it has);
             each other phone waits 150–900 ms, sends 'sync' with what is missing, and says
             hello back once (reply: true) so it goes both ways; a missing photo is resent by
             whichever phone starts first — the rest see its pieces and stand down.
```

## What must stay true

1. **Nothing on a server.** `verify-chat.ts` asserts no chat table and no
   bucket exist, and that `realtime.messages` holds nothing for the game
   after a full exchange. `verify-chat-ui` asserts neither phone makes any
   `/storage/` or chat `/rest/` request.
2. **Deleted with the game data.** A round played while in a game gets the
   game's id in `Round.chatGames`. `forgetUnusedChats` deletes every log and
   photo whose game is neither named by a round on the phone nor the game the
   phone is in. It must not run before **both** the store has hydrated
   (rounds load asynchronously; an empty list at first render would delete
   everything) **and** `loadGame()` has resolved. App waits for both.
3. **A photo's EXIF is the hider's exact GPS position.** Every phone camera
   writes it, and nothing between the phones would remove it. `preparePhoto`
   is the protection: canvas re-encode, then `stripMetadata` (drops
   APP1–APP15 except APP14 Adobe, plus comments), then `hasExif` must be
   false. Never send the input's `File` directly, and never "fall back" to
   the original when decoding fails; refuse. Receivers strip again before
   keeping (and `restoreChats` does on import), so a phone's copy never
   depends on another phone's app having done it.
4. **No position in a chat item.** A question carries the question, a
   chosen radar distance, and for matching/measuring the *name* of the
   seeker's own nearest one (`subject`, with a distance for measuring) —
   what a seeker says out loud: "is your nearest library the same as mine?
   Mine is Main Library." Where the seeker stood stays in `Round.chatAsks`
   on their phone. `parseQuestion` rebuilds every item from known fields, so
   a position attached by a sender is dropped, not kept (tested).
5. **Nothing answers itself.** `chat.answer` is only called from an
   `AnswerBox` click after a confirm. `verify-chat-ui` reads the hider's
   socket and asserts no answer left before the tap, and one after.
6. **Every phone agrees.** Items are merged by id; a question's own fields
   are fixed by the first copy; answers are final and the earliest wins
   (tie: lower author id), whatever order they arrive in. Logs are never
   "replaced" wholesale.
7. **An answer is logged once.** Live delivery and catch-up both hand over
   the same answer. `applyChatAnswer` is idempotent via `chatId` and writes
   only into the unended round the question was asked in.

## What the server no longer enforces

With no database, rules that were checks in SQL are now the app's:

- **Who asks and who answers** is the sender's own role in the app. A
  member of the game could forge a message under another member's name.
  The location channel's rule is unaffected: a hider still cannot send on
  `game:<id>` (`verify-chat.ts` re-checks it).
- **The clock** is the asker's phone clock (`askedAt`/`deadlineAt`). Phones
  keep network time; a phone set by hand would be off.
- **Catch-up needs a phone that has it.** A question asked while the hider's
  phone was off arrives when it comes back *if* some phone that has the
  question is online then. Usually the asker is.

## Verifying

```bash
npx supabase migration up            # from the repo root, after pulling 0013
cd app
npm run verify:chat                  # the relay: 16 checks, needs `supabase start`
npm run build && npx vite preview --port 4310    # in another shell
npm run verify:chat:ui               # two browsers; needs supabase/functions/.env TEST_LOGIN_CODE
SHOTS=/some/dir npm run verify:chat:ui           # keep the screenshots and the exported game file, then LOOK
npx vitest run src/chat
```

What `verify:chat:ui` proves, each at the layer that fails:

- the clock ticks (read twice), the confirm step sends nothing, and the
  hider's **socket** carries no answer before the tap and one after
- the seeker's **zone count drops**, the ask log has the answer once, still
  once after a reload, and the chat is still there after the reload
- a question asked while the hider's tab was **closed** arrives on reopening
- the photo fixture really has EXIF GPS (PIL parsed it as N 37.7694
  W 122.4477 when written), and the photo **reassembled from the pieces the
  hider sent**, the copy in the **seeker's IndexedDB**, and the copy in the
  **exported file** have no `Exif\0\0` and no TIFF header
- the exported game file has both questions, both messages and the photo
- leaving the game keeps the chat while a round names it; deleting the
  rounds removes every `chat/` key; re-opening the file puts them back

## The messaging layout

The Chat section is a messaging app inside the sheet. `.app.chat-open`
grows the sheet to `--chat-sheet` (82dvh) and `.chatpanel.chatview` takes
that height, so the **thread** scrolls, never the sheet, and the composer
stays at the bottom (`verify-chat-ui` asserts both after 14 messages).
`threadRows` (chat.ts, tested) decides runs — same author within
`GROUP_GAP_MS` and the same day — and day lines. A message shows at once as
"Sending…" and turns into the delivered one when the relay acks; on
failure it says "Not sent · Tap to retry". The thread follows new messages
only while the reader is within 80 px of the bottom. The input is 16 px so
iOS does not zoom on focus; how the iOS keyboard pushes the sheet has not
been checked on a real phone.

## Traps already hit

- **A phone ran a build from before the chat went local**, calling
  `post_chat`, which dev never had, so no question ever loaded. The fix is
  `src/update.ts` (see the `jetleg` skill); `verify:update` covers it.
- **realtime-js sends a user broadcast as a binary frame**, not the JSON
  array other messages use (`lib/serializer.js`, kind byte 3, five length
  bytes, an encoding byte, then topic, event, payload). A harness that reads
  frames as text sees no broadcasts at all, and "no answer was sent before
  the tap" passes while blind. `broadcastsIn` in the harness decodes both.
- **A negative check is only worth its positive twin.** Every "nothing was
  sent / received / stored" check in both harnesses sits beside one that
  proves the same channel does carry something.
- **The relay carries ~100 KB a second for the whole project**
  (`_realtime.tenants.max_bytes_per_second` locally; the cloud's own limits
  apply there). Photos go in 24 KB pieces 450 ms apart: about 7 s for
  250 KB. Sending them in one burst, or several phones resending at once,
  risks the relay dropping or rate-limiting.
- **An answered card is a remounted card.** It moves from "waiting" to
  "answered", so state on it, or on its `AnswerBox`, is lost the moment the
  answer lands. The "not in your exposure log" note lives in `ChatPanel`.
- **The hider's first answer can come before the seeker's first dot.**
  Seekers re-send every 10 s. With no dot and no hand pin the answer is
  sent but not logged locally, and the card says so.
- **A hash change does not reload the page.** Going from `#/stats` to
  `#/play` leaves `window.__mapReady` true from before; a harness waiting on
  it waits on nothing. Reload.
- **The Countdown has its own interval.** Do not lift the clock into `App`
  or the store: a shared clock once re-rendered the whole app, map redraw
  included, every second.
- **The local storage service cannot upload at all** (storage-api v1.79.36,
  `42P10`, an index built without `COLLATE "C"`). Irrelevant while nothing
  uses storage — which is the design — but it will bite the first feature
  that does.

## Not decided (Jonny's to rule)

- **One open question at a time?** The rulebook has seekers wait for an
  answer before asking again. Not enforced.
- **Late answers**: accepted and marked late. Penalties are a ruling.
- **Forged names**: any member of a game can send under another's name.
  Fine among friends with a code; worth knowing before strangers play.
