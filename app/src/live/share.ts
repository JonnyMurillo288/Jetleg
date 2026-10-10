import type { FeatureCollection } from 'geojson';
import type { LngLat, Role } from '../engine/types';

/**
 * Live location sharing inside a game room — the pure half.
 *
 * Everything here is a function of its arguments, so the one rule that
 * matters can be tested without a network: **a hider's device builds no
 * outgoing message at all.** `outgoingLocation` is the only place a position
 * is turned into something sendable, and it returns null for a hider.
 *
 * Nothing in this module, or anywhere under live/, writes a position to
 * IndexedDB or to a table. Peers live in React state and are gone on reload.
 */

export const LOCATION_EVENT = 'loc';
export const GONE_EVENT = 'gone';
export const channelTopic = (gameId: string) => `game:${gameId}`;

/** A peer not heard from for this long is drawn faded. Three missed heartbeats. */
export const STALE_AFTER_MS = 30_000;
/** ...and after this long is removed: a position that old is not "live". */
export const DROP_AFTER_MS = 120_000;

export type Sharer = { id: string; name: string; team: string };

/** The position a device would share: the same one its own panels anchor on. */
export type SharePosition = { coords: LngLat; accuracyM?: number; manual: boolean };

export type LocationMessage = {
  id: string;
  name: string;
  team: string;
  lon: number;
  lat: number;
  accuracyM: number | null;
  /** Hand-placed rather than measured — the receiver should know the difference. */
  manual: boolean;
};

export type Peer = {
  id: string;
  name: string;
  team: string;
  coords: LngLat;
  accuracyM: number | null;
  manual: boolean;
  /** This device's clock at receipt — never the sender's, which may be skewed. */
  receivedAt: number;
  stale: boolean;
};

export function outgoingLocation(role: Role, who: Sharer, position: SharePosition | null): LocationMessage | null {
  if (role !== 'seeker' || !position) return null;
  return {
    id: who.id,
    name: who.name,
    team: who.team,
    lon: position.coords[0],
    lat: position.coords[1],
    accuracyM: position.manual ? null : position.accuracyM ?? null,
    manual: position.manual,
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 40) : '');

/** Anything on the channel is another device's say-so; take only what is well-formed. */
export function parseLocation(raw: unknown): LocationMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id) return null;
  const { lon, lat } = m;
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return {
    id: m.id,
    name: text(m.name) || 'Seeker',
    team: text(m.team),
    lon,
    lat,
    accuracyM: typeof m.accuracyM === 'number' && Number.isFinite(m.accuracyM) ? m.accuracyM : null,
    manual: m.manual === true,
  };
}

export function receive(peers: Peer[], msg: LocationMessage, now: number): Peer[] {
  const peer: Peer = {
    id: msg.id,
    name: msg.name,
    team: msg.team,
    coords: [msg.lon, msg.lat],
    accuracyM: msg.accuracyM,
    manual: msg.manual,
    receivedAt: now,
    stale: false,
  };
  return [...peers.filter((p) => p.id !== msg.id), peer];
}

/**
 * Marks quiet peers stale and removes long-silent ones. Returns the *same*
 * array when nothing changed, so a timer calling this does not repaint the
 * map every tick.
 */
export function agePeers(peers: Peer[], now: number): Peer[] {
  let changed = false;
  const out: Peer[] = [];
  for (const p of peers) {
    const silentFor = now - p.receivedAt;
    if (silentFor > DROP_AFTER_MS) { changed = true; continue; }
    const stale = silentFor > STALE_AFTER_MS;
    if (stale !== p.stale) { changed = true; out.push({ ...p, stale }); } else out.push(p);
  }
  return changed ? out : peers;
}

export function buildPeersFc(peers: Peer[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: peers.map((p) => ({
      type: 'Feature',
      properties: { id: p.id, name: p.name, team: p.team, stale: p.stale, manual: p.manual },
      geometry: { type: 'Point', coordinates: p.coords },
    })),
  };
}
