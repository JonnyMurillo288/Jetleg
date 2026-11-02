import type { BoardStamp } from '../community/active';
import type { Answer, AskEntry, LngLat, Role } from '../engine/types';
import type { Round } from '../store/game';

/**
 * The game file — what "Export to file" writes and what the stats page opens.
 *
 * It is a player's own record of their rounds, kept wherever they keep
 * files. Reading one happens entirely in the browser: nothing in this module
 * touches the network, and opening a file neither uploads it nor adds it to
 * the rounds stored on the device unless the player asks for that.
 *
 * A file is something a person can edit, rename or pick by mistake, so it is
 * read defensively: a round or a question that is not well-formed is left
 * out and counted, rather than handed on to code that would trip over it.
 */

export const GAME_FILE_APP = 'jetleg-sf';
export const GAME_FILE_VERSION = 1;

export type GameFile = {
  rounds: Round[];
  /** As exported; not validated, and only ever merged over known settings. */
  settings: Record<string, unknown>;
  exportedAt: number | null;
  /** Rounds and questions that were malformed and left out. */
  skipped: number;
};

export type ReadGameFile = { ok: true; file: GameFile } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function point(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [lon, lat] = v;
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
}

function answer(v: unknown): Answer | null {
  if (!isObject(v)) return null;
  switch (v.kind) {
    case 'yesno': return v.value === 'yes' || v.value === 'no' ? { kind: 'yesno', value: v.value } : null;
    case 'closerFurther': return v.value === 'closer' || v.value === 'further' ? { kind: 'closerFurther', value: v.value } : null;
    case 'hotterColder': return v.value === 'hotter' || v.value === 'colder' ? { kind: 'hotterColder', value: v.value } : null;
    case 'tentacle': return typeof v.poiId === 'string' || v.poiId === null ? { kind: 'tentacle', poiId: v.poiId } : null;
    case 'null': return { kind: 'null' };
    case 'photo': return { kind: 'photo' };
    default: return null;
  }
}

function ask(v: unknown): AskEntry | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.questionId !== 'string' || !isTime(v.askedAt)) return null;
  const origin = point(v.origin);
  const given = answer(v.answer);
  if (!origin || !given) return null;
  const entry: AskEntry = { id: v.id, questionId: v.questionId, askedAt: v.askedAt, origin, answer: given };
  const destination = point(v.destination);
  if (destination) entry.destination = destination;
  if (typeof v.distanceM === 'number' && Number.isFinite(v.distanceM) && v.distanceM > 0) entry.distanceM = v.distanceM;
  if (typeof v.note === 'string') entry.note = v.note.slice(0, 2000);
  if (v.disabled === true) entry.disabled = true;
  if (typeof v.chatId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v.chatId)) entry.chatId = v.chatId;
  return entry;
}

function stamp(v: unknown): BoardStamp | undefined {
  if (!isObject(v) || typeof v.name !== 'string' || typeof v.stationCount !== 'number') return undefined;
  return { name: v.name, versionId: typeof v.versionId === 'string' ? v.versionId : null, stationCount: v.stationCount };
}

function round(v: unknown, skip: () => void): Round | null {
  if (!isObject(v) || typeof v.id !== 'string' || !isTime(v.startedAt) || !Array.isArray(v.asks)) return null;
  const role: Role | null = v.role === 'seeker' || v.role === 'hider' ? v.role : null;
  if (!role) return null;

  const asks: AskEntry[] = [];
  for (const raw of v.asks) {
    const entry = ask(raw);
    if (entry) asks.push(entry); else skip();
  }
  const out: Round = {
    id: v.id,
    role,
    label: typeof v.label === 'string' && v.label.trim() ? v.label.slice(0, 120) : role === 'seeker' ? 'Seeking round' : 'Hiding round',
    startedAt: v.startedAt,
    asks,
  };
  if (isTime(v.endedAt) && v.endedAt >= v.startedAt) out.endedAt = v.endedAt;
  const board = stamp(v.board);
  if (board) out.board = board;
  if (typeof v.hiderStationId === 'string') out.hiderStationId = v.hiderStationId;
  const pin = point(v.seekerPin);
  if (pin) out.seekerPin = pin;
  if (Array.isArray(v.chatGames)) {
    const games = v.chatGames.filter((g): g is string => typeof g === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(g));
    if (games.length) out.chatGames = games;
  }
  return out;
}

export function readGameFile(text: string): ReadGameFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not JSON, so it is not a JetLeg game file.' };
  }
  if (!isObject(doc) || doc.app !== GAME_FILE_APP) return { ok: false, error: 'Not a JetLeg export file.' };
  if (typeof doc.version === 'number' && doc.version > GAME_FILE_VERSION) {
    return { ok: false, error: 'This file was made with a newer version of the app. Update to open it.' };
  }
  if (!Array.isArray(doc.rounds)) return { ok: false, error: 'No rounds in file.' };

  let skipped = 0;
  const rounds: Round[] = [];
  const seen = new Set<string>();
  for (const raw of doc.rounds) {
    const r = round(raw, () => { skipped++; });
    // A round twice in one file is one round.
    if (!r || seen.has(r.id)) { skipped++; continue; }
    seen.add(r.id);
    rounds.push(r);
  }
  return {
    ok: true,
    file: {
      rounds,
      settings: isObject(doc.settings) ? doc.settings : {},
      exportedAt: isTime(doc.exportedAt) ? doc.exportedAt : null,
      skipped,
    },
  };
}

/** The file for these rounds, in the one format this app reads back. */
export function gameFileText(rounds: Round[], settings: object, role: Role): string {
  return JSON.stringify({ app: GAME_FILE_APP, version: GAME_FILE_VERSION, exportedAt: Date.now(), role, settings, rounds }, null, 2);
}

/** A file name for one round: `jetleg-seeking-round-2-2026-10-13.json`. */
export function roundFileName(r: Round): string {
  const slug = r.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'round';
  return `jetleg-${slug}-${new Date(r.startedAt).toISOString().slice(0, 10)}.json`;
}

/** Hand a text file to the browser's own save flow. Nothing is sent anywhere. */
export function saveTextFile(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
