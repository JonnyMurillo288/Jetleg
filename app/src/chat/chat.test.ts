import { describe, expect, it } from 'vitest';
import {
  PHOTO_CHUNK_BYTES,
  PhotoAssembler,
  answerChoices,
  answerLabel,
  answerTiming,
  emptyLog,
  formatClock,
  hasExif,
  hello,
  mergeMessage,
  mergeQuestion,
  missingFor,
  openQuestions,
  parseAnswer,
  parseChunk,
  parseHello,
  parseLog,
  parseQuestion,
  photoChunks,
  stripMetadata,
  unreadCount,
  type ChatMessage,
  type ChatQuestion,
} from './chat';

const T = Date.parse('2026-10-31T12:00:00Z');
const raw = (over: Record<string, unknown> = {}) => ({
  id: 'q1', gameId: 'g', askedBy: 'seeker', askerName: 'Sam', askerTeam: 'Blue',
  questionId: 'match-park', text: 'Is your nearest park the same as my nearest park?',
  answerKind: 'yesno', distanceM: null,
  askedAt: T, deadlineAt: T + 5 * 60_000,
  answer: null, answeredBy: null, answererName: null, answeredAt: null, photo: false,
  ...over,
});
const q = (over: Record<string, unknown> = {}) => parseQuestion(raw(over))!;
const answered = (value: 'yes' | 'no', by: string, at: number, over: Record<string, unknown> = {}) =>
  q({ answer: { kind: 'yesno', value }, answeredBy: by, answererName: by, answeredAt: at, ...over });
const msg = (id: string, authorId: string, at: number): ChatMessage => ({
  id, gameId: 'g', authorId, authorName: authorId, authorRole: 'seeker', body: 'hi', createdAt: at,
});

describe('what arrives from another phone', () => {
  it('a well-formed question is kept', () => {
    expect(q().deadlineAt - q().askedAt).toBe(5 * 60_000);
    expect(q().answer).toBeNull();
  });

  it('anything else the sender attached — a position, say — is dropped', () => {
    const p = parseQuestion(raw({ lon: -122.4477, lat: 37.7694, origin: [-122.4, 37.7] })) as Record<string, unknown>;
    expect(Object.keys(p).some((k) => /lon|lat|origin/.test(k))).toBe(false);
  });

  it('a question this app could not have asked is refused', () => {
    expect(parseQuestion(raw({ answerKind: 'telepathy' }))).toBeNull();
    expect(parseQuestion(raw({ questionId: "x'; drop" }))).toBeNull();
    expect(parseQuestion(raw({ deadlineAt: T + 1000 }))).toBeNull();      // a one-second clock
    expect(parseQuestion(raw({ deadlineAt: T + 86_400_000 }))).toBeNull(); // a day
    expect(parseQuestion(raw({ text: 'x'.repeat(301) }))).toBeNull();
    expect(parseQuestion(null)).toBeNull();
  });

  it('an answer of the wrong kind is no answer', () => {
    expect(q({ answer: { kind: 'closerFurther', value: 'closer' }, answeredBy: 'h', answeredAt: T + 1 }).answer).toBeNull();
    expect(q({ answer: { kind: 'yesno', value: 'maybe' }, answeredBy: 'h', answeredAt: T + 1 }).answer).toBeNull();
    expect(q({ answer: { kind: 'yesno', value: 'yes' }, answeredAt: T + 1 }).answer).toBeNull(); // no author
  });

  it('null answers any question; only a photo answer has a photo', () => {
    expect(q({ answer: { kind: 'null' }, answeredBy: 'h', answeredAt: T + 1 }).answer).toEqual({ kind: 'null' });
    expect(q({ answer: { kind: 'null' }, answeredBy: 'h', answeredAt: T + 1, photo: true }).photo).toBe(false);
    expect(q({ answerKind: 'photo', deadlineAt: T + 600_000, answer: { kind: 'photo' }, answeredBy: 'h', answeredAt: T + 1 }).photo).toBe(true);
  });

  it('parseAnswer reads only what it recognises', () => {
    expect(parseAnswer({ kind: 'yesno', value: 'yes' })).toEqual({ kind: 'yesno', value: 'yes' });
    expect(parseAnswer({ kind: 'tentacle', poiId: null })).toEqual({ kind: 'tentacle', poiId: null });
    expect(parseAnswer({ kind: 'yesno', value: 'maybe' })).toBeNull();
  });
});

describe('every phone ends up agreeing', () => {
  it('questions read newest first; an answer replaces the unanswered copy', () => {
    let list: ChatQuestion[] = [];
    list = mergeQuestion(list, q({ id: 'a' }));
    list = mergeQuestion(list, q({ id: 'b', askedAt: T + 600_000, deadlineAt: T + 900_000 }));
    list = mergeQuestion(list, answered('no', 'h', T + 60_000, { id: 'a' }));
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
    expect(list[1].answer).toEqual({ kind: 'yesno', value: 'no' });
  });

  it('an answer is final: a later unanswered copy does not undo it', () => {
    const list = mergeQuestion(mergeQuestion([], answered('no', 'h', T + 60_000)), q());
    expect(list[0].answer).toEqual({ kind: 'yesno', value: 'no' });
  });

  it('two answers: the earlier wins, in whatever order they arrive', () => {
    const early = answered('no', 'hana', T + 30_000);
    const late = answered('yes', 'hugo', T + 40_000);
    expect(mergeQuestion(mergeQuestion([q()], early), late)[0].answeredBy).toBe('hana');
    expect(mergeQuestion(mergeQuestion([q()], late), early)[0].answeredBy).toBe('hana');
  });

  it('...and at the same instant, the same one on every phone', () => {
    const a = answered('no', 'aaa', T + 30_000);
    const b = answered('yes', 'bbb', T + 30_000);
    expect(mergeQuestion([a], b)[0].answeredBy).toBe(mergeQuestion([b], a)[0].answeredBy);
  });

  it('the question itself is fixed by the first copy seen', () => {
    const list = mergeQuestion([q()], q({ text: 'Something else entirely?' }));
    expect(list[0].text).toMatch(/nearest park/);
  });

  it('merging the same thing again changes nothing (no needless re-save)', () => {
    const list = [answered('no', 'h', T + 60_000)];
    expect(mergeQuestion(list, answered('no', 'h', T + 60_000))).toBe(list);
    const ms = [msg('m1', 'x', 1)];
    expect(mergeMessage(ms, msg('m1', 'x', 1))).toBe(ms);
  });

  it('a stored log or file is read as strictly as the channel', () => {
    const log = parseLog({ gameId: 'g', questions: [raw(), raw({ id: 'bad', answerKind: 'nope' }), raw({ id: 'elsewhere', gameId: 'other' })], messages: [msg('m', 'x', 1), { id: 'junk' }] });
    expect(log?.questions.map((x) => x.id)).toEqual(['q1']);
    expect(log?.messages.map((x) => x.id)).toEqual(['m']);
  });
});

describe('catching up a phone that slept', () => {
  const log = { ...emptyLog('g'), questions: [answered('no', 'h', T + 60_000), q({ id: 'q2', askedAt: T + 1 })], messages: [msg('m1', 'x', 1), msg('m2', 'y', 2)] };

  it('a phone with nothing is sent everything', () => {
    const m = missingFor(log, new Set(), parseHello(hello('other', emptyLog('g'), []))!);
    expect(m.questions).toHaveLength(2);
    expect(m.messages).toHaveLength(2);
  });

  it('a phone that saw a question but not its answer is sent the answer', () => {
    const theirs = { ...emptyLog('g'), questions: [q(), q({ id: 'q2', askedAt: T + 1 })], messages: log.messages };
    const m = missingFor(log, new Set(), hello('other', theirs, []));
    expect(m.questions.map((x) => x.id)).toEqual(['q1']);
    expect(m.messages).toHaveLength(0);
  });

  it('a phone with everything is sent nothing', () => {
    const m = missingFor(log, new Set(), hello('other', log, []));
    expect(m.questions.length + m.messages.length + m.photos.length).toBe(0);
  });

  it('photos go only to a phone without them, and only from a phone that has them', () => {
    const withPhoto = { ...emptyLog('g'), questions: [q({ id: 'p', answerKind: 'photo', deadlineAt: T + 600_000, answer: { kind: 'photo' }, answeredBy: 'h', answeredAt: T + 1 })] };
    expect(missingFor(withPhoto, new Set(['p']), hello('o', withPhoto, [])).photos).toEqual(['p']);
    expect(missingFor(withPhoto, new Set(['p']), hello('o', withPhoto, ['p'])).photos).toEqual([]);
    expect(missingFor(withPhoto, new Set(), hello('o', withPhoto, [])).photos).toEqual([]);
  });
});

describe('photos, piece by piece', () => {
  const bytes = new Uint8Array(PHOTO_CHUNK_BYTES * 2 + 123).map((_, i) => (i * 7) & 255);

  it('arrive whole, in any order, with repeats', () => {
    const pieces = photoChunks('g', 'p', bytes);
    expect(pieces).toHaveLength(3);
    const a = new PhotoAssembler();
    expect(a.add(pieces[2])).toBeNull();
    expect(a.add(pieces[2])).toBeNull();
    expect(a.add(pieces[0])).toBeNull();
    expect(a.add(pieces[1])).toEqual(bytes);
  });

  it('a piece that is malformed or oversized is refused', () => {
    const [piece] = photoChunks('g', 'p', bytes);
    expect(parseChunk(piece)).toEqual(piece);
    expect(parseChunk({ ...piece, index: 9 })).toBeNull();
    expect(parseChunk({ ...piece, total: 10_000 })).toBeNull();
    expect(parseChunk({ ...piece, data: 'A'.repeat(PHOTO_CHUNK_BYTES * 2) })).toBeNull();
  });
});

describe('answers, as players say them', () => {
  it('matching and radar are hit or miss', () => {
    expect(answerChoices('yesno').map((c) => c.label)).toEqual(['Hit', 'Miss']);
    expect(answerLabel({ kind: 'yesno', value: 'yes' })).toBe('HIT');
    expect(answerLabel({ kind: 'yesno', value: 'no' })).toBe('MISS');
  });

  it('a tentacle answer names the place, not its id', () => {
    expect(answerLabel({ kind: 'tentacle', poiId: 'n123' }, () => 'de Young')).toBe('de Young');
    expect(answerLabel({ kind: 'tentacle', poiId: null })).toBe('NOT WITHIN REACH');
  });

  it('open questions are owed oldest first', () => {
    const list = [q({ id: 'new', askedAt: T + 1000, deadlineAt: T + 301_000 }), q({ id: 'old' }), answered('no', 'h', T + 5)];
    expect(openQuestions(list).map((x) => x.id)).toEqual(['old', 'new']);
  });
});

describe('the clock', () => {
  it('counts m:ss and goes negative once the time is up', () => {
    expect(formatClock(299_999)).toBe('4:59');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-12_000)).toBe('−0:12');
  });

  it('an answer after the deadline is marked late, not refused', () => {
    expect(answerTiming(answered('no', 'h', T + 240_000))).toEqual({ took: '4:00', late: false });
    expect(answerTiming(answered('no', 'h', T + 390_000))).toEqual({ took: '6:30', late: true });
  });
});

describe('unread', () => {
  it('counts what others did since this phone last looked, never its own', () => {
    const seen = T + 60_000;
    const questions = [
      q({ id: 'mine', askedBy: 'me', askedAt: T + 120_000, deadlineAt: T + 420_000, answer: { kind: 'null' }, answeredBy: 'hider', answeredAt: T + 180_000 }),
      q({ id: 'theirs', askedBy: 'other', askedAt: T + 120_000, deadlineAt: T + 420_000 }),
      q({ id: 'old', askedBy: 'other' }),
    ];
    const messages = [msg('a', 'me', seen + 1), msg('b', 'other', seen + 1), msg('c', 'other', seen - 1)];
    expect(unreadCount(questions, messages, 'me', seen)).toBe(3);
  });
});

describe('EXIF, where a phone writes its position', () => {
  const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it('finds an Exif APP1 segment, after a JFIF header too', () => {
    expect(hasExif(new Uint8Array([0xff, 0xd8, ...segment(0xe1, [...ascii('Exif'), 0, 0]), 0xff, 0xd9]))).toBe(true);
    expect(hasExif(new Uint8Array([0xff, 0xd8, ...segment(0xe0, ascii('JFIF\0')), ...segment(0xe1, [...ascii('Exif'), 0, 0]), 0xff, 0xd9]))).toBe(true);
  });

  it('"Exif" inside the image data is pixels, not metadata', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, ...segment(0xe0, ascii('JFIF\0')), 0xff, 0xda, 0, 2, ...ascii('Exif'), 0xff, 0xd9]);
    expect(hasExif(jpeg)).toBe(false);
  });

  it('stripping removes EXIF, XMP, IPTC and comments, and keeps JFIF, Adobe and the image', () => {
    const jfif = segment(0xe0, ascii('JFIF\0'));
    const exif = segment(0xe1, [...ascii('Exif'), 0, 0, ...ascii('GPS 37.7694 -122.4477')]);
    const xmp = segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<exif:GPSLatitude>'));
    const iptc = segment(0xed, ascii('Photoshop 3.0'));
    const comment = segment(0xfe, ascii('taken at home'));
    const adobe = segment(0xee, ascii('Adobe'));
    const tables = segment(0xdb, [0, 1, 2]);
    const scan = [0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9];
    const out = stripMetadata(new Uint8Array([0xff, 0xd8, ...jfif, ...exif, ...xmp, ...iptc, ...comment, ...adobe, ...tables, ...scan]));
    expect([...out]).toEqual([0xff, 0xd8, ...jfif, ...adobe, ...tables, ...scan]);
    expect(new TextDecoder().decode(out)).not.toMatch(/GPS|home|Photoshop/);
  });

  it('refuses something that is not a whole JPEG rather than passing it through', () => {
    expect(() => stripMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow();
    expect(() => stripMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toThrow();
  });
});
