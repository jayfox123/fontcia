import { describe, it, expect } from 'vitest';
import jwtLib from 'jsonwebtoken';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../src/lib/jwt';

describe('access tokens', () => {
  it('round-trips a signed payload through verification', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.com' });
    const payload = verifyAccessToken(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.email).toBe('a@example.com');
  });

  it('rejects a malformed token', () => {
    expect(verifyAccessToken('not-a-real-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwtLib.sign({ sub: 'user-1', email: 'a@example.com' }, 'wrong-secret');
    expect(verifyAccessToken(forged)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('generates a raw token whose hash matches hashRefreshToken', () => {
    const { rawToken, tokenHash } = generateRefreshToken();
    expect(hashRefreshToken(rawToken)).toBe(tokenHash);
  });

  it('generates a future expiry date around 30 days out', () => {
    const { expiresAt } = generateRefreshToken();
    const daysFromNow = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysFromNow).toBeGreaterThan(29);
    expect(daysFromNow).toBeLessThan(31);
  });

  it('generates distinct tokens on each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.rawToken).not.toBe(b.rawToken);
  });
});
