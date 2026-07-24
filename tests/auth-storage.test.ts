import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { getStoredAuth, setStoredAuth, clearStoredAuth } from '../src/background/auth-storage';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('auth-storage', () => {
  it('returns null when nothing is stored', async () => {
    await expect(getStoredAuth()).resolves.toBeNull();
  });

  it('round-trips a stored auth record', async () => {
    const auth = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      userId: 'user-1',
      email: 'a@example.com',
    };

    await setStoredAuth(auth);

    await expect(getStoredAuth()).resolves.toEqual(auth);
  });

  it('clears the stored auth record', async () => {
    await setStoredAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      userId: 'user-1',
      email: 'a@example.com',
    });

    await clearStoredAuth();

    await expect(getStoredAuth()).resolves.toBeNull();
  });
});
