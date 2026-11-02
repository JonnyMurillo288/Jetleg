import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval';
import {
  emptyLog,
  fromBase64,
  mergeMessage,
  mergeQuestion,
  parseLog,
  stripMetadata,
  toBase64,
  type ChatLog,
} from './chat';

/**
 * Where a game's chat lives: on this phone, and nowhere else.
 *
 * The log (questions, answers, messages) and each photo are kept in this
 * phone's IndexedDB, beside its rounds. They leave the phone only in the
 * game file the player exports, and are deleted with the game data: once no
 * round on the phone names the game (Round.chatGames) and the phone is not
 * in it any more, `forgetUnusedChats` removes the log and every photo.
 */

const LOG_PREFIX = 'chat/log/';
const PHOTO_PREFIX = 'chat/photo/';
const logKey = (gameId: string) => `${LOG_PREFIX}${gameId}`;
const photoKey = (gameId: string, questionId: string) => `${PHOTO_PREFIX}${gameId}/${questionId}`;

export async function loadLog(gameId: string): Promise<ChatLog> {
  const stored = await idbGet(logKey(gameId)).catch(() => undefined);
  return parseLog(stored) ?? emptyLog(gameId);
}

export async function saveLog(log: ChatLog): Promise<void> {
  await idbSet(logKey(log.gameId), log);
}

export async function savePhoto(gameId: string, questionId: string, jpeg: Blob): Promise<void> {
  await idbSet(photoKey(gameId, questionId), jpeg);
}

/** Every photo kept for a game, by question id. */
export async function loadPhotos(gameId: string): Promise<Map<string, Blob>> {
  const prefix = `${PHOTO_PREFIX}${gameId}/`;
  const out = new Map<string, Blob>();
  for (const k of await idbKeys()) {
    if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
    const blob = await idbGet<Blob>(k);
    if (blob) out.set(k.slice(prefix.length), blob);
  }
  return out;
}

/** The log and every photo of one game. */
export async function deleteGameChat(gameId: string): Promise<void> {
  const photos = `${PHOTO_PREFIX}${gameId}/`;
  for (const k of await idbKeys()) {
    if (typeof k === 'string' && (k === logKey(gameId) || k.startsWith(photos))) await idbDel(k);
  }
}

/**
 * Deletes the chat of every game this phone no longer has any business
 * keeping: no round names it and the phone is not in it. Photos with no log
 * beside them go too. Returns the games deleted.
 */
export async function forgetUnusedChats(keep: Set<string>): Promise<string[]> {
  const gone = new Set<string>();
  for (const k of await idbKeys()) {
    if (typeof k !== 'string') continue;
    const gameId = k.startsWith(LOG_PREFIX) ? k.slice(LOG_PREFIX.length)
      : k.startsWith(PHOTO_PREFIX) ? k.slice(PHOTO_PREFIX.length).split('/')[0]
      : null;
    if (gameId && !keep.has(gameId)) {
      await idbDel(k);
      gone.add(gameId);
    }
  }
  return [...gone];
}

/** The games a set of rounds had chat in. */
export const chatGamesOf = (rounds: { chatGames?: string[] }[]) =>
  new Set(rounds.flatMap((r) => r.chatGames ?? []));

// ----------------------------------------------------------- the game file

/** A game's chat as it is written into the game file. Photos as base64 JPEG. */
type FileChat = ChatLog & { photos: Record<string, string> };

/**
 * Adds the chat of every game its rounds name to a game file's text. The
 * file is the one place a chat goes when it leaves the phone, and it goes
 * whole — photos included — so an exported round reads back complete.
 *
 * `from` is another game file to take the chats from instead of this phone:
 * a round re-saved from an opened file keeps that file's chat.
 */
export async function withChats(fileText: string, from?: string): Promise<string> {
  const doc = JSON.parse(fileText) as { rounds?: { chatGames?: string[] }[] } & Record<string, unknown>;
  const games = chatGamesOf(doc.rounds ?? []);
  if (from !== undefined) {
    let source: unknown;
    try { source = JSON.parse(from); } catch { source = null; }
    const theirs = (source as { chats?: unknown } | null)?.chats;
    const chats = Array.isArray(theirs) ? theirs.filter((c) => games.has((c as { gameId?: string })?.gameId ?? '')) : [];
    return JSON.stringify(chats.length ? { ...doc, chats } : doc, null, 2);
  }
  const chats: FileChat[] = [];
  for (const gameId of games) {
    const log = await loadLog(gameId);
    const photos: Record<string, string> = {};
    for (const [qid, blob] of await loadPhotos(gameId)) photos[qid] = toBase64(new Uint8Array(await blob.arrayBuffer()));
    if (log.questions.length || log.messages.length || Object.keys(photos).length) chats.push({ ...log, photos });
  }
  return JSON.stringify(chats.length ? { ...doc, chats } : doc, null, 2);
}

/**
 * Puts a game file's chats back on this phone, merged with whatever it
 * already has. A file is something a person can edit, so every item is
 * checked as if it had just arrived, and every photo is stripped again.
 * Returns how many games' chats were restored.
 */
export async function restoreChats(fileText: string): Promise<number> {
  let doc: unknown;
  try { doc = JSON.parse(fileText); } catch { return 0; }
  const chats = (doc as { chats?: unknown }).chats;
  if (!Array.isArray(chats)) return 0;
  let n = 0;
  for (const raw of chats) {
    const incoming = parseLog(raw);
    if (!incoming) continue;
    const have = await loadLog(incoming.gameId);
    await saveLog({
      gameId: incoming.gameId,
      questions: incoming.questions.reduce(mergeQuestion, have.questions),
      messages: incoming.messages.reduce(mergeMessage, have.messages),
    });
    const photos = (raw as { photos?: unknown }).photos;
    if (photos && typeof photos === 'object') {
      for (const [qid, b64] of Object.entries(photos as Record<string, unknown>)) {
        if (typeof b64 !== 'string' || !incoming.questions.some((q) => q.id === qid && q.photo)) continue;
        try {
          const bytes = stripMetadata(fromBase64(b64));
          await savePhoto(incoming.gameId, qid, new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
        } catch { /* not a JPEG: left out */ }
      }
    }
    n++;
  }
  return n;
}
