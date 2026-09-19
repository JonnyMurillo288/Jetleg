import { describe, it, expect } from 'vitest';
import { isStillValid, type CachedEntitlement } from './entitlement';

const NOW = Date.parse('2026-01-15T12:00:00Z');

function entitlement(overrides: Partial<CachedEntitlement> = {}): CachedEntitlement {
  return { eligible: true, product: 'single_game', expiresAt: '2026-01-16T12:00:00Z', gameId: null, ...overrides };
}

describe('isStillValid', () => {
  it('is false with no cached entitlement at all', () => {
    expect(isStillValid(null, NOW)).toBe(false);
    expect(isStillValid(undefined, NOW)).toBe(false);
  });

  it('is false when the cache says ineligible, even with a future expiry', () => {
    expect(isStillValid(entitlement({ eligible: false }), NOW)).toBe(false);
  });

  it('is false with no expiry recorded (never activated)', () => {
    expect(isStillValid(entitlement({ expiresAt: null }), NOW)).toBe(false);
  });

  it('is true strictly before expiry, false strictly after', () => {
    const cached = entitlement({ expiresAt: new Date(NOW + 1000).toISOString() });
    expect(isStillValid(cached, NOW)).toBe(true);
    expect(isStillValid(cached, NOW + 2000)).toBe(false);
  });
});
