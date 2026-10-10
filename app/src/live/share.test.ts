import { describe, expect, it } from 'vitest';
import {
  DROP_AFTER_MS,
  STALE_AFTER_MS,
  agePeers,
  buildPeersFc,
  outgoingLocation,
  parseLocation,
  receive,
  type Peer,
} from './share';

const who = { id: 'device-1', name: 'Sam', team: 'Blue' };
const here = { coords: [-122.4194, 37.7793] as [number, number], accuracyM: 12, manual: false };

describe('outgoingLocation', () => {
  it('builds nothing for a hider, whatever position it is handed', () => {
    expect(outgoingLocation('hider', who, here)).toBeNull();
    expect(outgoingLocation('hider', who, { ...here, manual: true })).toBeNull();
  });

  it('builds nothing for a seeker with no position', () => {
    expect(outgoingLocation('seeker', who, null)).toBeNull();
  });

  it('carries a seeker’s position and who they are', () => {
    expect(outgoingLocation('seeker', who, here)).toEqual({
      id: 'device-1', name: 'Sam', team: 'Blue',
      lon: -122.4194, lat: 37.7793, accuracyM: 12, manual: false,
    });
  });

  it('does not claim an accuracy for a hand-placed point', () => {
    expect(outgoingLocation('seeker', who, { ...here, manual: true })?.accuracyM).toBeNull();
  });
});

describe('parseLocation', () => {
  it('round-trips what outgoingLocation builds', () => {
    const msg = outgoingLocation('seeker', who, here)!;
    expect(parseLocation(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });

  it('rejects anything malformed', () => {
    expect(parseLocation(null)).toBeNull();
    expect(parseLocation({ id: 'x', lon: 'a', lat: 1 })).toBeNull();
    expect(parseLocation({ id: 'x', lon: 0, lat: 91 })).toBeNull();
    expect(parseLocation({ id: 'x', lon: NaN, lat: 1 })).toBeNull();
    expect(parseLocation({ lon: 0, lat: 0 })).toBeNull();
  });
});

describe('peers', () => {
  const msg = outgoingLocation('seeker', who, here)!;

  it('keeps one entry per device, the newest', () => {
    let peers = receive([], msg, 1000);
    peers = receive(peers, { ...msg, lon: -122.4 }, 2000);
    expect(peers).toHaveLength(1);
    expect(peers[0].coords[0]).toBe(-122.4);
    expect(peers[0].receivedAt).toBe(2000);
  });

  it('goes stale, then drops, and returns the same array when nothing changed', () => {
    const peers: Peer[] = receive([], msg, 0);
    expect(agePeers(peers, STALE_AFTER_MS)).toBe(peers);
    const stale = agePeers(peers, STALE_AFTER_MS + 1);
    expect(stale[0].stale).toBe(true);
    expect(agePeers(stale, STALE_AFTER_MS + 2)).toBe(stale);
    expect(agePeers(stale, DROP_AFTER_MS + 1)).toEqual([]);
  });

  it('draws one point per peer', () => {
    const fc = buildPeersFc(receive([], msg, 0));
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-122.4194, 37.7793] });
    expect(fc.features[0].properties).toMatchObject({ name: 'Sam', stale: false });
  });
});
