import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../sync/client';
import type { LocalGame, Result } from '../live/room';
import type { LiveStatus } from '../live/useLiveLocations';
import type { Answer, Question, Role } from '../engine/types';
import {
  HELLO_EVENT,
  MESSAGE_EVENT,
  PHOTO_EVENT,
  PhotoAssembler,
  QUESTION_EVENT,
  SYNC_EVENT,
  chatTopic,
  hello,
  mergeMessage,
  mergeQuestion,
  missingFor,
  parseChunk,
  parseHello,
  parseMessage,
  parseQuestion,
  photoChunks,
  stripMetadata,
  unreadCount,
  type ChatLog,
  type ChatMessage,
  type ChatQuestion,
  type Hello,
} from './chat';
import { loadLog, loadPhotos, saveLog, savePhoto } from './local';
import { preparePhoto } from './photo';

const RETRY_MS = 5_000;
/** Pause between photo pieces: ~50 KB/s, inside the relay's ~100 KB/s with room for positions. */
const PHOTO_PACE_MS = 450;
/** Catch-up items per message. */
const SYNC_BATCH = 40;
const seenKey = (gameId: string) => `chat/seen/${gameId}`;
const fail = (error: string): Result<never> => ({ ok: false, error });
const OFFLINE = 'Could not reach the other players. Check your connection and try again.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function readSeen(gameId: string): number {
  try { return Number(localStorage.getItem(seenKey(gameId))) || 0; } catch { return 0; }
}

/**
 * The game's two threads, phone to phone.
 *
 * Nothing goes to a database. Each item is a broadcast on `chat:<game>`,
 * relayed to whoever is listening and kept by no server; this phone keeps
 * its own copy (local.ts) and writes every change to it.
 *
 * A broadcast reaches only the phones listening at that instant. So on
 * every (re)join, and on coming back to the foreground, a phone says
 * `hello` with what it has; the others send what it is missing (`sync`,
 * and photos piece by piece), and say hello back once so the exchange goes
 * both ways. A question asked while the hider's phone was locked therefore
 * arrives when it unlocks — as long as some other phone in the game that has
 * it is online then.
 */
export function useGameChat(game: LocalGame | null, role: Role, viewing: boolean) {
  const [log, setLog] = useState<ChatLog | null>(null);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<LiveStatus>('off');
  const [seenAt, setSeenAt] = useState(0);

  const gameId = game?.gameId;
  const profileId = game?.profileId;
  const logRef = useRef<ChatLog | null>(null);
  logRef.current = log;
  /** Photo bytes this phone has, by question id — what it can send to a phone missing one. */
  const blobs = useRef(new Map<string, Blob>());
  const urls = useRef<string[]>([]);
  const channel = useRef<RealtimeChannel | null>(null);
  const joined = useRef(false);
  /** When a piece of each photo was last heard, so two phones do not both resend it. */
  const recentPiece = useRef(new Map<string, number>());

  const put = useCallback((fn: (l: ChatLog) => ChatLog) => setLog((l) => (l ? fn(l) : l)), []);

  const keepPhoto = useCallback(async (gid: string, questionId: string, jpeg: Blob) => {
    if (blobs.current.has(questionId)) return;
    blobs.current.set(questionId, jpeg);
    await savePhoto(gid, questionId, jpeg);
    const url = URL.createObjectURL(jpeg);
    urls.current.push(url);
    setPhotos((p) => ({ ...p, [questionId]: url }));
  }, []);

  // ---- this phone's copy
  useEffect(() => {
    setLog(null);
    setPhotos({});
    blobs.current = new Map();
    if (!gameId) return;
    setSeenAt(readSeen(gameId));
    let cancelled = false;
    (async () => {
      const [stored, kept] = await Promise.all([loadLog(gameId), loadPhotos(gameId)]);
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [qid, blob] of kept) {
        blobs.current.set(qid, blob);
        const url = URL.createObjectURL(blob);
        urls.current.push(url);
        map[qid] = url;
      }
      setPhotos(map);
      setLog(stored);
    })();
    return () => {
      cancelled = true;
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
  }, [gameId]);

  useEffect(() => {
    if (log && log.gameId === gameId) saveLog(log).catch(() => {});
  }, [log, gameId]);

  const loaded = !!log && log.gameId === gameId;

  // ---- the channel
  useEffect(() => {
    if (!supabase || !gameId || !profileId || !loaded) {
      setStatus('off');
      return;
    }
    const client = supabase;
    let cancelled = false;
    let retry: number | undefined;
    const assembler = new PhotoAssembler();
    const timers: number[] = [];
    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    const send = (event: string, payload: unknown) =>
      channel.current && joined.current
        ? channel.current.send({ type: 'broadcast', event, payload })
        : Promise.resolve('error' as const);

    const sendPhoto = async (questionId: string) => {
      const blob = blobs.current.get(questionId);
      if (!blob) return;
      for (const piece of photoChunks(gameId, questionId, new Uint8Array(await blob.arrayBuffer()))) {
        if (cancelled) return;
        recentPiece.current.set(questionId, Date.now());
        await send(PHOTO_EVENT, piece);
        await sleep(PHOTO_PACE_MS);
      }
    };

    const sayHello = (reply: boolean) =>
      send(HELLO_EVENT, { ...hello(profileId, logRef.current!, blobs.current.keys()), reply });

    const answerHello = (h: Hello, reply: boolean) => {
      // Spread out, so a phone rejoining a game of five is not answered by
      // four phones in the same instant.
      later(150 + Math.random() * 750, async () => {
        const have = logRef.current;
        if (!have || cancelled) return;
        const missing = missingFor(have, new Set(blobs.current.keys()), h);
        for (let i = 0; i < missing.questions.length || i < missing.messages.length; i += SYNC_BATCH) {
          await send(SYNC_EVENT, { questions: missing.questions.slice(i, i + SYNC_BATCH), messages: missing.messages.slice(i, i + SYNC_BATCH) });
        }
        if (!reply) await sayHello(true);
        for (const qid of missing.photos) {
          // Any phone with the photo may send it; the first to start wins,
          // and the rest see its pieces arrive and stand down.
          later(1_500 + Math.random() * 2_000, () => {
            if (Date.now() - (recentPiece.current.get(qid) ?? 0) > 4_000) sendPhoto(qid);
          });
        }
      });
    };

    const open = async () => {
      setStatus('connecting');
      try { await client.realtime.setAuth(); } catch { /* the subscribe below reports it */ }
      if (cancelled) return;
      const ch = client.channel(chatTopic(gameId), { config: { private: true, broadcast: { self: false, ack: true } } });
      channel.current = ch;

      const takeQuestion = (raw: unknown) => {
        const q = parseQuestion(raw);
        if (q && q.gameId === gameId) put((l) => ({ ...l, questions: mergeQuestion(l.questions, q) }));
      };
      const takeMessage = (raw: unknown) => {
        const m = parseMessage(raw);
        if (m && m.gameId === gameId) put((l) => ({ ...l, messages: mergeMessage(l.messages, m) }));
      };
      ch.on('broadcast', { event: QUESTION_EVENT }, ({ payload }) => takeQuestion(payload));
      ch.on('broadcast', { event: MESSAGE_EVENT }, ({ payload }) => takeMessage(payload));
      ch.on('broadcast', { event: SYNC_EVENT }, ({ payload }) => {
        const p = payload as { questions?: unknown; messages?: unknown } | null;
        if (Array.isArray(p?.questions)) p.questions.forEach(takeQuestion);
        if (Array.isArray(p?.messages)) p.messages.forEach(takeMessage);
      });
      ch.on('broadcast', { event: PHOTO_EVENT }, ({ payload }) => {
        const piece = parseChunk(payload);
        if (!piece || piece.gameId !== gameId) return;
        recentPiece.current.set(piece.questionId, Date.now());
        if (blobs.current.has(piece.questionId)) return;
        const bytes = assembler.add(piece);
        if (!bytes) return;
        // The sender stripped it; strip again, so nothing kept on this phone
        // depends on another phone's app having done so.
        let clean: Uint8Array;
        try { clean = stripMetadata(bytes); } catch { return; }
        keepPhoto(gameId, piece.questionId, new Blob([clean as BlobPart], { type: 'image/jpeg' }));
      });
      ch.on('broadcast', { event: HELLO_EVENT }, ({ payload }) => {
        const h = parseHello(payload);
        if (h && h.from !== profileId) answerHello(h, (payload as { reply?: unknown }).reply === true);
      });

      ch.subscribe((state) => {
        if (cancelled) return;
        if (state === 'SUBSCRIBED') {
          joined.current = true;
          setStatus('live');
          sayHello(false);
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
          joined.current = false;
          setStatus('error');
          client.removeChannel(ch);
          retry = window.setTimeout(open, RETRY_MS);
        }
      });
    };
    open();

    // A backgrounded phone's socket goes quiet; catch up on return.
    const onVisible = () => { if (document.visibilityState === 'visible' && joined.current) sayHello(false); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      joined.current = false;
      window.clearTimeout(retry);
      for (const t of timers) window.clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel.current) client.removeChannel(channel.current);
      channel.current = null;
    };
  }, [gameId, profileId, loaded, put, keepPhoto]);

  // ---- sending. Each is kept on this phone only once the relay took it.
  const send = async (event: string, payload: unknown): Promise<boolean> => {
    if (!channel.current || !joined.current) return false;
    return (await channel.current.send({ type: 'broadcast', event, payload })) === 'ok';
  };

  const ask = async (q: Question, text: string, distanceM?: number): Promise<Result<ChatQuestion>> => {
    if (!game) return fail('Join a game first.');
    if (role !== 'seeker') return fail('Only a seeker can ask. Switch to Seeker first.');
    if (q.answerKind === 'null') return fail('That question has no answer to ask for.');
    const askedAt = Date.now();
    const cq: ChatQuestion = {
      id: newId(),
      gameId: game.gameId,
      askedBy: game.profileId,
      askerName: game.displayName,
      askerTeam: game.teamName,
      questionId: q.id,
      text,
      answerKind: q.answerKind,
      distanceM: distanceM ?? null,
      askedAt,
      deadlineAt: askedAt + q.timeLimitMin * 60_000,
      answer: null,
      answeredBy: null,
      answererName: null,
      answeredAt: null,
      photo: false,
    };
    if (!(await send(QUESTION_EVENT, cq))) return fail(OFFLINE);
    put((l) => ({ ...l, questions: mergeQuestion(l.questions, cq) }));
    return { ok: true, value: cq };
  };

  const answered = (cq: ChatQuestion, answer: Answer): ChatQuestion => ({
    ...cq,
    answer,
    answeredBy: game!.profileId,
    answererName: game!.displayName,
    answeredAt: Date.now(),
    photo: answer.kind === 'photo',
  });

  const canAnswer = (cq: ChatQuestion): string | null => {
    if (!game) return 'Join a game first.';
    if (role !== 'hider') return 'Only the hider can answer. Switch to Hider first.';
    if (logRef.current?.questions.find((x) => x.id === cq.id)?.answer) return 'Already answered.';
    return null;
  };

  const answer = async (cq: ChatQuestion, a: Answer): Promise<Result<ChatQuestion>> => {
    const no = canAnswer(cq);
    if (no) return fail(no);
    const next = answered(cq, a);
    if (!(await send(QUESTION_EVENT, next))) return fail(OFFLINE);
    put((l) => ({ ...l, questions: mergeQuestion(l.questions, next) }));
    return { ok: true, value: next };
  };

  /** The photo first, piece by piece, then the answer that pins it to its question. */
  const answerPhoto = async (cq: ChatQuestion, file: Blob): Promise<Result<ChatQuestion>> => {
    const no = canAnswer(cq);
    if (no) return fail(no);
    let jpeg: Blob;
    try { jpeg = await preparePhoto(file); } catch (e) { return fail((e as Error).message); }
    for (const piece of photoChunks(cq.gameId, cq.id, new Uint8Array(await jpeg.arrayBuffer()))) {
      recentPiece.current.set(cq.id, Date.now());
      if (!(await send(PHOTO_EVENT, piece))) return fail(OFFLINE);
      await sleep(PHOTO_PACE_MS);
    }
    const next = answered(cq, { kind: 'photo' });
    if (!(await send(QUESTION_EVENT, next))) return fail(OFFLINE);
    await keepPhoto(cq.gameId, cq.id, jpeg);
    put((l) => ({ ...l, questions: mergeQuestion(l.questions, next) }));
    return { ok: true, value: next };
  };

  const say = async (body: string): Promise<Result<ChatMessage>> => {
    if (!game) return fail('Join a game first.');
    const m: ChatMessage = {
      id: newId(),
      gameId: game.gameId,
      authorId: game.profileId,
      authorName: game.displayName,
      authorRole: role,
      body: body.trim().slice(0, 500),
      createdAt: Date.now(),
    };
    if (!m.body) return fail('Say something first.');
    if (!(await send(MESSAGE_EVENT, m))) return fail(OFFLINE);
    put((l) => ({ ...l, messages: mergeMessage(l.messages, m) }));
    return { ok: true, value: m };
  };

  const questions = useMemo(() => (loaded ? log!.questions : []), [loaded, log]);
  const messages = useMemo(() => (loaded ? log!.messages : []), [loaded, log]);

  // Everything is read while the panel is open.
  const latest = Math.max(0, ...questions.map((q) => Math.max(q.askedAt, q.answeredAt ?? 0)), ...messages.map((m) => m.createdAt));
  useEffect(() => {
    if (!viewing || !gameId || latest <= seenAt) return;
    setSeenAt(latest);
    try { localStorage.setItem(seenKey(gameId), String(latest)); } catch { /* per-device convenience only */ }
  }, [viewing, gameId, latest, seenAt]);

  const unread = useMemo(
    () => (profileId ? unreadCount(questions, messages, profileId, seenAt) : 0),
    [questions, messages, profileId, seenAt],
  );

  return { questions, messages, photos, status, unread, ask, answer, answerPhoto, say };
}

export type GameChat = ReturnType<typeof useGameChat>;
