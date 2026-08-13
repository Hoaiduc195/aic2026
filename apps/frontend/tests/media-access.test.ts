import { describe, expect, it } from 'vitest';

import { createMediaSessionToken, safeTokenEqual, verifyMediaSessionToken } from '@/lib/media-access';

describe('media access tokens', () => {
  it('derives a signed, expiring session token without exposing the operator secret', () => {
    const token = createMediaSessionToken('operator-secret', 20_000, 'browser-a');
    const otherSession = createMediaSessionToken('operator-secret', 20_000, 'browser-b');
    expect(token).not.toContain('operator-secret');
    expect(token).not.toBe(otherSession);
    expect(verifyMediaSessionToken('operator-secret', token, 10_000)).toBe(true);
    expect(verifyMediaSessionToken('different-secret', token, 10_000)).toBe(false);
    expect(verifyMediaSessionToken('operator-secret', token, 20_001)).toBe(false);
  });

  it('compares credentials without accepting missing or different values', () => {
    expect(safeTokenEqual('expected-token', 'expected-token')).toBe(true);
    expect(safeTokenEqual('expected-token', 'wrong-token')).toBe(false);
    expect(safeTokenEqual('expected-token', null)).toBe(false);
  });
});
