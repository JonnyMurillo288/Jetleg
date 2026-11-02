import type { Answer, AnswerKind, Role } from '../engine/types';

/**
 * The in-game chat — the pure half.
 *
 * A game room has two threads:
 *
 *   questions — a seeker asks one of the catalog's questions, a clock starts,
 *               and a hider answers it by hand. The app never answers for
 *               them: it may show the hider what the answer assistant reads,
 *               but nothing is sent until a person taps it.
 *   chat      — everything else. Trash talk, rulings, "where ARE you".
 *
 * **Nothing here is stored on a server.** Every item travels as a Realtime
 * broadcast on `chat:<game id>` (supabase/migrations/0013_game_chat.sql),
 * which relays and keeps nothing, and each phone keeps its own copy with its
 * game data (local.ts). So everything that arrives is another phone's say-so:
 * it is checked here before it is kept, and two phones that hear the same
 * things in a different order must end up agreeing (`mergeQuestion`).
 *
 * Neither thread ever carries a position. Where the seeker stood when asking
 * stays in their round (Round.chatAsks); the hider measures from the seeker's
 * live dot.
 */

export const QUESTION_EVENT = 'q';
export const MESSAGE_EVENT = 'm';
export const PHOTO_EVENT = 'pc';
export const HELLO_EVENT = 'hello';
export const SYNC_EVENT = 'sync';
export const chatTopic = (gameId: string) => `chat:${gameId}`;

/** The asker's own nearest one, named with the question (subject.ts). */
export type ChatSubject = { name: string; distanceM: number | null };

export type ChatQuestion = {
  id: string;
  gameId: string;
  askedBy: string;
  askerName: string;
  askerTeam: string;
  /** The catalog id, engine/questions.ts. */
  questionId: string;
  text: string;
  answerKind: Exclude<AnswerKind, 'null'>;
  /** Radar "Choose" only: the radius the seeker said. */
  distanceM: number | null;
  /**
   * Matching and measuring: the asker's own nearest one — "is your nearest
   * library the same as mine? Mine is Main Library." A name, and for
   * measuring how far the asker is from it.
   */
  subject: ChatSubject | null;
  /** The asker's clock. Phones keep network time; the clock is shown, not enforced. */
  askedAt: number;
  deadlineAt: number;
  answer: Answer | null;
  answeredBy: string | null;
  answererName: string | null;
  answeredAt: number | null;
  /** The answer is a photo, kept on each phone under this question's id. */
  photo: boolean;
};

export type ChatMessage = {
  id: string;
  gameId: string;
  authorId: string;
  authorName: string;
  authorRole: Role;
  body: string;
  createdAt: number;
};

/** One game's chat as a phone keeps it. Photos are kept beside it, by question id. */
export type ChatLog = { gameId: string; questions: ChatQuestion[]; messages: ChatMessage[] };

export const emptyLog = (gameId: string): ChatLog => ({ gameId, questions: [], messages: [] });

const ANSWER_KINDS = ['yesno', 'closerFurther', 'hotterColder', 'tentacle', 'photo'] as const;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : null;
const id = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : null);

/** An answer as another phone sent it. Anything unrecognised reads as unanswered. */
export function parseAnswer(raw: unknown): Answer | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  switch (a.kind) {
    case 'yesno': return a.value === 'yes' || a.value === 'no' ? { kind: 'yesno', value: a.value } : null;
    case 'closerFurther': return a.value === 'closer' || a.value === 'further' ? { kind: 'closerFurther', value: a.value } : null;
    case 'hotterColder': return a.value === 'hotter' || a.value === 'colder' ? { kind: 'hotterColder', value: a.value } : null;
    case 'tentacle':
      if (a.poiId === null) return { kind: 'tentacle', poiId: null };
      return typeof a.poiId === 'string' && a.poiId.length <= 120 ? { kind: 'tentacle', poiId: a.poiId } : null;
    case 'photo': return { kind: 'photo' };
    case 'null': return { kind: 'null' };
    default: return null;
  }
}

/**
 * A question from the channel, a stored log or a game file. Rebuilt from
 * known fields only, so anything else a sender attached — a position, say —
 * is dropped rather than kept.
 */
export function parseQuestion(raw: unknown): ChatQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const qid = id(r.id), gameId = id(r.gameId), askedBy = id(r.askedBy);
  if (!qid || !gameId || !askedBy) return null;
  if (typeof r.questionId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(r.questionId)) return null;
  if (!ANSWER_KINDS.includes(r.answerKind as never)) return null;
  const question = text(r.text, 300);
  if (!question || !isTime(r.askedAt) || !isTime(r.deadlineAt)) return null;
  // The catalog's limits are 5 and 10 minutes; anything outside a minute to
  // an hour is not a question this app asked.
  const limit = r.deadlineAt - r.askedAt;
  if (limit < 60_000 || limit > 3_600_000) return null;
  const distanceM = typeof r.distanceM === 'number' && r.distanceM >= 1 && r.distanceM <= 100_000 ? r.distanceM : null;
  const s = r.subject as Record<string, unknown> | null | undefined;
  const subjectName = s && typeof s === 'object' ? text(s.name, 120) : null;
  const subject: ChatSubject | null = subjectName
    ? { name: subjectName, distanceM: typeof s!.distanceM === 'number' && s!.distanceM >= 0 && s!.distanceM <= 100_000 ? s!.distanceM : null }
    : null;

  const base: ChatQuestion = {
    id: qid,
    gameId,
    askedBy,
    askerName: text(r.askerName, 40) ?? 'Seeker',
    askerTeam: text(r.askerTeam, 40) ?? '',
    questionId: r.questionId,
    text: question,
    answerKind: r.answerKind as ChatQuestion['answerKind'],
    distanceM,
    subject,
    askedAt: r.askedAt,
    deadlineAt: r.deadlineAt,
    answer: null,
    answeredBy: null,
    answererName: null,
    answeredAt: null,
    photo: false,
  };
  const answer = parseAnswer(r.answer);
  const answeredBy = id(r.answeredBy);
  // An answer of the wrong kind, or with no author or time, is not an answer.
  if (!answer || !answeredBy || !isTime(r.answeredAt)) return base;
  if (answer.kind !== 'null' && answer.kind !== base.answerKind) return base;
  return {
    ...base,
    answer,
    answeredBy,
    answererName: text(r.answererName, 40) ?? 'Hider',
    answeredAt: r.answeredAt,
    photo: answer.kind === 'photo',
  };
}

export function parseMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mid = id(r.id), gameId = id(r.gameId), authorId = id(r.authorId);
  const body = text(r.body, 500);
  if (!mid || !gameId || !authorId || !body || !isTime(r.createdAt)) return null;
  return {
    id: mid,
    gameId,
    authorId,
    authorName: text(r.authorName, 40) ?? 'Player',
    authorRole: r.authorRole === 'seeker' ? 'seeker' : 'hider',
    body,
    createdAt: r.createdAt,
  };
}

/** A stored log or a file's copy of one: every item checked as if it had just arrived. */
export function parseLog(raw: unknown): ChatLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const gameId = id(r.gameId);
  if (!gameId) return null;
  let log = emptyLog(gameId);
  for (const q of Array.isArray(r.questions) ? r.questions : []) {
    const p = parseQuestion(q);
    if (p && p.gameId === gameId) log = { ...log, questions: mergeQuestion(log.questions, p) };
  }
  for (const m of Array.isArray(r.messages) ? r.messages : []) {
    const p = parseMessage(m);
    if (p && p.gameId === gameId) log = { ...log, messages: mergeMessage(log.messages, p) };
  }
  return log;
}

/** The earlier answer wins; on the same instant, the lower author id. Every phone picks the same one. */
function firstAnswer(a: ChatQuestion, b: ChatQuestion): ChatQuestion {
  if (a.answeredAt! !== b.answeredAt!) return a.answeredAt! < b.answeredAt! ? a : b;
  return a.answeredBy! <= b.answeredBy! ? a : b;
}

/**
 * Add a question, or an answer to one. The question itself is fixed by the
 * first copy seen; an answer is final, and if two arrive the same one wins on
 * every phone whatever order they came in.
 */
export function mergeQuestion(list: ChatQuestion[], q: ChatQuestion): ChatQuestion[] {
  const had = list.find((x) => x.id === q.id);
  let next = q;
  if (had) {
    const answered = had.answer && q.answer ? firstAnswer(had, q) : had.answer ? had : q;
    next = {
      ...had,
      answer: answered.answer,
      answeredBy: answered.answeredBy,
      answererName: answered.answererName,
      answeredAt: answered.answeredAt,
      photo: answered.photo,
    };
    if (had.answeredAt === next.answeredAt && had.answeredBy === next.answeredBy) return list;
  }
  return [...list.filter((x) => x.id !== q.id), next].sort((a, b) => b.askedAt - a.askedAt);
}

/** Insert by id. Chat reads oldest first, like every chat. */
export function mergeMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  if (list.some((x) => x.id === m.id)) return list;
  return [...list, m].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- catching up

/**
 * What a phone has, sent when it (re)joins the channel. A broadcast reaches
 * only phones listening at that instant, so a phone that slept through a
 * question learns of it from another phone's copy, never from a server.
 */
export type Hello = {
  from: string;
  /** Question id → whether this phone has its answer. */
  questions: Record<string, boolean>;
  messages: string[];
  /** Questions whose photo this phone has. */
  photos: string[];
};

export function hello(from: string, log: ChatLog, photos: Iterable<string>): Hello {
  return {
    from,
    questions: Object.fromEntries(log.questions.map((q) => [q.id, !!q.answer])),
    messages: log.messages.map((m) => m.id),
    photos: [...photos],
  };
}

export function parseHello(raw: unknown): Hello | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = id(r.from);
  if (!from || !r.questions || typeof r.questions !== 'object') return null;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => !!id(x)) : []);
  return {
    from,
    questions: Object.fromEntries(
      Object.entries(r.questions as Record<string, unknown>).filter(([k]) => id(k)).map(([k, v]) => [k, v === true]),
    ),
    messages: ids(r.messages),
    photos: ids(r.photos),
  };
}

/** What this phone has that the one saying hello does not. */
export function missingFor(log: ChatLog, photos: Set<string>, h: Hello) {
  const known = new Set(h.messages);
  const theirPhotos = new Set(h.photos);
  return {
    questions: log.questions.filter((q) => !(q.id in h.questions) || (!!q.answer && !h.questions[q.id])),
    messages: log.messages.filter((m) => !known.has(m.id)),
    photos: log.questions.filter((q) => q.photo && photos.has(q.id) && !theirPhotos.has(q.id)).map((q) => q.id),
  };
}

// --------------------------------------------------------------------- photos

/**
 * Bytes per photo piece, before base64. Realtime relays at most ~100 KB a
 * second for the whole project, so a photo goes in pieces with a pause
 * between them (useGameChat), not as one burst.
 */
export const PHOTO_CHUNK_BYTES = 24_000;
/** A photo larger than this is refused rather than sent; the re-encode keeps them well under. */
export const PHOTO_MAX_BYTES = 600_000;

export type PhotoChunk = { questionId: string; gameId: string; index: number; total: number; data: string };

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function photoChunks(gameId: string, questionId: string, bytes: Uint8Array): PhotoChunk[] {
  const total = Math.max(1, Math.ceil(bytes.length / PHOTO_CHUNK_BYTES));
  return Array.from({ length: total }, (_, index) => ({
    gameId,
    questionId,
    index,
    total,
    data: toBase64(bytes.subarray(index * PHOTO_CHUNK_BYTES, (index + 1) * PHOTO_CHUNK_BYTES)),
  }));
}

export function parseChunk(raw: unknown): PhotoChunk | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const questionId = id(r.questionId), gameId = id(r.gameId);
  const { index, total, data } = r;
  if (!questionId || !gameId || typeof data !== 'string') return null;
  if (typeof index !== 'number' || typeof total !== 'number' || !Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (total < 1 || total > Math.ceil(PHOTO_MAX_BYTES / PHOTO_CHUNK_BYTES) || index < 0 || index >= total) return null;
  if (data.length > Math.ceil(PHOTO_CHUNK_BYTES / 3) * 4) return null;
  return { questionId, gameId, index, total, data };
}

/** Collects a photo's pieces, in any order and with repeats; the bytes once all are in. */
export class PhotoAssembler {
  private parts = new Map<string, (string | undefined)[]>();

  add(c: PhotoChunk): Uint8Array | null {
    let got = this.parts.get(c.questionId);
    if (!got || got.length !== c.total) got = new Array<string | undefined>(c.total).fill(undefined);
    got[c.index] = c.data;
    this.parts.set(c.questionId, got);
    if (got.some((p) => p === undefined)) return null;
    this.parts.delete(c.questionId);
    const pieces = got.map((p) => fromBase64(p!));
    const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) { out.set(p, at); at += p.length; }
    return out;
  }
}

// ------------------------------------------------------------------ answering

/** The answer buttons a hider gets, in the words players say out loud. */
export function answerChoices(kind: ChatQuestion['answerKind']): { answer: Answer; label: string; tone: 'yes' | 'no' }[] {
  switch (kind) {
    // "Hit" / "miss" is how the table says yes / no to a matching or radar question.
    case 'yesno': return [
      { answer: { kind: 'yesno', value: 'yes' }, label: 'Hit', tone: 'yes' },
      { answer: { kind: 'yesno', value: 'no' }, label: 'Miss', tone: 'no' },
    ];
    case 'closerFurther': return [
      { answer: { kind: 'closerFurther', value: 'closer' }, label: 'Closer', tone: 'yes' },
      { answer: { kind: 'closerFurther', value: 'further' }, label: 'Further', tone: 'no' },
    ];
    case 'hotterColder': return [
      { answer: { kind: 'hotterColder', value: 'hotter' }, label: 'Hotter', tone: 'yes' },
      { answer: { kind: 'hotterColder', value: 'colder' }, label: 'Colder', tone: 'no' },
    ];
    default: return [];
  }
}

/** How an answer reads in the thread. `poiName` resolves a tentacle's id. */
export function answerLabel(a: Answer, poiName?: (id: string) => string): string {
  switch (a.kind) {
    case 'yesno': return a.value === 'yes' ? 'HIT' : 'MISS';
    case 'closerFurther': return a.value.toUpperCase();
    case 'hotterColder': return a.value.toUpperCase();
    case 'tentacle': return a.poiId ? (poiName?.(a.poiId) ?? a.poiId) : 'NOT WITHIN REACH';
    case 'null': return 'NULL';
    case 'photo': return 'PHOTO';
  }
}

/** m:ss, with a leading minus once the clock has run out. */
export function formatClock(ms: number): string {
  const late = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  return `${late ? '−' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long the hider took, and whether that was inside the limit. */
export function answerTiming(q: ChatQuestion): { took: string; late: boolean } | null {
  if (q.answeredAt === null) return null;
  return { took: formatClock(Math.max(0, q.answeredAt - q.askedAt)), late: q.answeredAt > q.deadlineAt };
}

/** Questions the hider still owes an answer to, oldest first — the order they were asked in. */
export function openQuestions(questions: ChatQuestion[]): ChatQuestion[] {
  return questions.filter((q) => !q.answer).sort((a, b) => a.askedAt - b.askedAt);
}

/**
 * What the badge on the Chat button counts: things someone else did since
 * this device last looked. A hider's open questions are counted separately
 * and always, because those are owed, not merely unread.
 */
export function unreadCount(
  questions: ChatQuestion[],
  messages: ChatMessage[],
  me: string,
  seenAt: number,
): number {
  let n = 0;
  for (const m of messages) if (m.authorId !== me && m.createdAt > seenAt) n++;
  for (const q of questions) {
    if (q.askedBy !== me && q.askedAt > seenAt) n++;
    if (q.answeredBy !== me && q.answeredAt !== null && q.answeredAt > seenAt) n++;
  }
  return n;
}

// ------------------------------------------------------------------- metadata

/**
 * A JPEG with every metadata segment removed: APP1 to APP15 except APP14,
 * plus comments. That covers EXIF and XMP (both APP1, both able to carry GPS)
 * and IPTC (APP13). Kept: APP0 (JFIF) and APP14 (Adobe), which say how to
 * decode the colours, and everything from start-of-scan on, verbatim.
 *
 * Applied to the canvas re-encode in photo.ts, so the guarantee does not rest
 * on any one browser's encoder writing no metadata of its own. Orientation
 * has already been applied to the pixels by then, so dropping its tag is
 * right — keeping it would turn the photo twice.
 */
export function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const keep: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let scan = false;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('malformed JPEG');
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) { keep.push(bytes.subarray(i)); scan = true; break; }
    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    if (end > bytes.length) throw new Error('malformed JPEG');
    const metadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!metadata) keep.push(bytes.subarray(i, end));
    i = end;
  }
  // Headers that never reach the image: truncated, not a photo to send.
  if (!scan) throw new Error('malformed JPEG');
  const out = new Uint8Array(keep.reduce((n, k) => n + k.length, 0));
  let at = 0;
  for (const k of keep) { out.set(k, at); at += k.length; }
  return out;
}

/**
 * Whether a JPEG still carries an EXIF block (an APP1 segment opening
 * "Exif"). A phone camera writes the GPS position there, which for a hider
 * is the one thing the game is about. Walks the segment headers rather than
 * searching the bytes, so image data that happens to spell "Exif" is not
 * mistaken for metadata.
 */
export function hasExif(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return false;
    const marker = bytes[i + 1];
    // Start of scan: the headers are over, image data follows.
    if (marker === 0xda || marker === 0xd9) return false;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...bytes.slice(i + 4, i + 8)) === 'Exif') return true;
    i += 2 + len;
  }
  return false;
}

// ------------------------------------------------------------- the thread

/** Messages from one person this close together read as one run. */
export const GROUP_GAP_MS = 3 * 60_000;

export type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: ChatMessage; mine: boolean; first: boolean; last: boolean };

function dayLabel(t: number, now: number): string {
  const day = (x: number) => new Date(x).toDateString();
  if (day(t) === day(now)) return 'Today';
  if (day(t) === day(now - 86_400_000)) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * The chat laid out the way messaging apps do: a line for each new day, and
 * runs of messages from one person shown as one group — their name over the
 * first, the time under the last.
 */
export function threadRows(messages: ChatMessage[], me: string, now: number): ThreadRow[] {
  const rows: ThreadRow[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
    if (newDay) rows.push({ kind: 'day', key: `day-${m.id}`, label: dayLabel(m.createdAt, now) });
    const joinsPrev = !newDay && !!prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt <= GROUP_GAP_MS;
    const joinsNext = !!next && next.authorId === m.authorId && next.createdAt - m.createdAt <= GROUP_GAP_MS
      && new Date(next.createdAt).toDateString() === new Date(m.createdAt).toDateString();
    rows.push({ kind: 'message', key: m.id, message: m, mine: m.authorId === me, first: !joinsPrev, last: !joinsNext });
  });
  return rows;
}
