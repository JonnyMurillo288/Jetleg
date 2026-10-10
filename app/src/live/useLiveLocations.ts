import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../sync/client';
import type { Role } from '../engine/types';
import { setGameRole, type LocalGame } from './room';
import {
  GONE_EVENT,
  LOCATION_EVENT,
  agePeers,
  channelTopic,
  outgoingLocation,
  parseLocation,
  receive,
  type Peer,
  type SharePosition,
} from './share';

export type LiveStatus = 'off' | 'connecting' | 'live' | 'error';

/** A moving seeker sends at most this often... */
const MIN_SEND_INTERVAL_MS = 3_000;
/** ...and a still one re-sends this often, so someone who just joined sees them. */
const HEARTBEAT_MS = 10_000;
const RETRY_MS = 5_000;

/**
 * Role declarations reach the server strictly in the order they were made.
 * Without this, a quick seeker → hider flip could have its two calls land
 * the other way round and leave the server believing a hider is seeking —
 * which is exactly the belief the broadcast policy relies on.
 */
let roleQueue: Promise<unknown> = Promise.resolve();
function declareRole(gameId: string, role: Role): Promise<void> {
  const next = roleQueue.catch(() => {}).then(() => setGameRole(gameId, role));
  roleQueue = next;
  return next;
}

/**
 * Live seeker positions for everyone in the game.
 *
 * A seeker sends; a hider only listens. The channel is rebuilt whenever the
 * role changes, for two reasons: the sending half below exists only inside a
 * seeker's run of the effect, so switching to hider tears it down rather than
 * relying on a flag; and Realtime decides at join time whether this device
 * may broadcast at all, from the role just declared (see 0005_game_rooms.sql).
 *
 * Positions are relayed, not stored — nothing here writes to IndexedDB, and
 * the server keeps no copy. Reloading the page forgets every peer.
 */
export function useLiveLocations(
  game: LocalGame | null,
  role: Role,
  position: SharePosition | null,
): { peers: Peer[]; status: LiveStatus } {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<LiveStatus>('off');
  const positionRef = useRef(position);
  positionRef.current = position;
  /** Set only while a seeker's channel is joined. */
  const onMove = useRef<(() => void) | null>(null);

  const gameId = game?.gameId;
  const profileId = game?.profileId;
  const name = game?.displayName;
  const team = game?.teamName;

  useEffect(() => {
    if (!supabase || !gameId || !profileId) {
      setStatus('off');
      setPeers([]);
      return;
    }
    const client = supabase;
    const who = { id: profileId, name: name ?? '', team: team ?? '' };
    let cancelled = false;
    let joined = false;
    let channel: RealtimeChannel | null = null;
    let heartbeat: number | undefined;
    let retry: number | undefined;
    setStatus('connecting');

    const open = async () => {
      try {
        await declareRole(gameId, role);
        if (cancelled) return;
        await client.realtime.setAuth();
      } catch {
        if (cancelled) return;
        setStatus('error');
        retry = window.setTimeout(open, RETRY_MS);
        return;
      }
      if (cancelled) return;

      const ch = client.channel(channelTopic(gameId), {
        config: { private: true, broadcast: { self: false } },
      });
      channel = ch;

      ch.on('broadcast', { event: LOCATION_EVENT }, ({ payload }) => {
        const msg = parseLocation(payload);
        if (msg && msg.id !== profileId) setPeers((ps) => receive(ps, msg, Date.now()));
      });
      ch.on('broadcast', { event: GONE_EVENT }, ({ payload }) => {
        const id = (payload as { id?: unknown } | null)?.id;
        if (typeof id === 'string') setPeers((ps) => ps.filter((p) => p.id !== id));
      });

      let publish: (() => void) | null = null;
      if (role === 'seeker') {
        let lastSent = 0;
        publish = () => {
          const msg = outgoingLocation(role, who, positionRef.current);
          if (!msg || !joined || cancelled) return;
          lastSent = Date.now();
          ch.send({ type: 'broadcast', event: LOCATION_EVENT, payload: msg });
        };
        const send = publish;
        onMove.current = () => { if (Date.now() - lastSent >= MIN_SEND_INTERVAL_MS) send(); };
        heartbeat = window.setInterval(send, HEARTBEAT_MS);
      }

      ch.subscribe((state) => {
        if (cancelled) return;
        joined = state === 'SUBSCRIBED';
        if (joined) {
          setStatus('live');
          publish?.();
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
          setStatus('error');
        } else {
          setStatus('connecting');
        }
      });
    };
    open();

    return () => {
      cancelled = true;
      onMove.current = null;
      window.clearInterval(heartbeat);
      window.clearTimeout(retry);
      if (channel) {
        // Tell the others straight away rather than leaving a dot to fade.
        if (role === 'seeker' && joined) {
          channel.send({ type: 'broadcast', event: GONE_EVENT, payload: { id: profileId } });
        }
        client.removeChannel(channel);
      }
    };
  }, [gameId, profileId, name, team, role]);

  useEffect(() => {
    onMove.current?.();
  }, [position?.coords[0], position?.coords[1], position?.manual]);

  useEffect(() => {
    const t = window.setInterval(() => setPeers((ps) => agePeers(ps, Date.now())), 5_000);
    return () => window.clearInterval(t);
  }, []);

  return { peers, status };
}
