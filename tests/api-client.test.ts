import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import {
  apiFetch,
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
} from '../src/background/api-client';
import { getStoredAuth, setStoredAuth } from '../src/background/auth-storage';

let chromeMock: ReturnType<typeof createChromeMock>;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const STORED = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2026-01-01T00:00:00.000Z',
  userId: 'user-1',
  email: 'a@example.com',
};

describe('apiFetch', () => {
  it('sends no Authorization header when auth is "none"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/scans', { method: 'POST', body: { status: 'match' }, auth: 'none' });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers.Authorization).toBeUndefined();
  });

  it('fails fast without calling fetch when auth is "required" and nothing is stored', async () => {
    const result = await apiFetch('/saved-fonts', { method: 'GET', auth: 'required' });

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches the stored access token when present', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { savedFonts: [] }));

    await apiFetch('/saved-fonts', { method: 'GET', auth: 'required' });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers.Authorization).toBe('Bearer access-1');
  });

  it('refreshes and retries once on a 401, returning the retried result', async () => {
    await setStoredAuth(STORED);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-01-02T00:00:00.000Z' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { savedFonts: ['ok'] }));

    const result = await apiFetch('/saved-fonts', { method: 'GET', auth: 'required' });

    expect(result).toEqual({ ok: true, data: { savedFonts: ['ok'] } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:3001/auth/refresh');

    const retryHeaders = fetchMock.mock.calls[2][1].headers;
    expect(retryHeaders.Authorization).toBe('Bearer access-2');
  });

  it('clears stored auth and returns the original failure when refresh itself fails', async () => {
    await setStoredAuth(STORED);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Invalid refresh token' }));

    const result = await apiFetch('/saved-fonts', { method: 'GET', auth: 'required' });

    expect(result).toEqual({ ok: false, error: 'Unauthorized' });
    await expect(getStoredAuth()).resolves.toBeNull();
  });

  it('single-flights concurrent refreshes: two simultaneous 401s trigger only one /auth/refresh call', async () => {
    await setStoredAuth(STORED);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' })) // request A, first attempt
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' })) // request B, first attempt
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-01-02T00:00:00.000Z' }),
      ) // the single refresh call
      .mockResolvedValueOnce(jsonResponse(200, { savedFonts: ['a'] })) // request A retry
      .mockResolvedValueOnce(jsonResponse(200, { savedFonts: ['b'] })); // request B retry

    const [resultA, resultB] = await Promise.all([
      apiFetch('/saved-fonts', { method: 'GET', auth: 'required' }),
      apiFetch('/saved-fonts', { method: 'GET', auth: 'required' }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url === 'http://localhost:3001/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
  });
});

describe('signup / login', () => {
  it('signup stores the returned tokens and returns the user', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        user: { id: 'user-1', email: 'a@example.com' },
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const result = await signup('a@example.com', 'password123');

    expect(result).toEqual({ ok: true, data: { user: { id: 'user-1', email: 'a@example.com' } } });
    await expect(getStoredAuth()).resolves.toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      userId: 'user-1',
      email: 'a@example.com',
    });
  });

  it('login returns the server error without storing anything on failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Invalid email or password' }));

    const result = await login('a@example.com', 'wrongpassword');

    expect(result).toEqual({ ok: false, error: 'Invalid email or password' });
    await expect(getStoredAuth()).resolves.toBeNull();
  });
});

describe('logout', () => {
  it('calls /auth/logout with the stored refresh token and clears storage', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(emptyResponse(204));

    const result = await logout();

    expect(result).toEqual({ ok: true, data: null });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/auth/logout',
      expect.objectContaining({ body: JSON.stringify({ refreshToken: 'refresh-1' }) }),
    );
    await expect(getStoredAuth()).resolves.toBeNull();
  });

  it('clears storage even when nothing was stored to begin with', async () => {
    const result = await logout();

    expect(result).toEqual({ ok: true, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getAuthState', () => {
  it('reports logged out with no network call when nothing is stored', async () => {
    const result = await getAuthState();

    expect(result).toEqual({ ok: true, data: { loggedIn: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports logged in with the stored email when auth is present', async () => {
    await setStoredAuth(STORED);

    const result = await getAuthState();

    expect(result).toEqual({ ok: true, data: { loggedIn: true, email: 'a@example.com' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('saveFont / deleteSavedFont', () => {
  it('saveFont posts to /saved-fonts and unwraps the id', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { savedFont: { id: 'font-1' } }));

    const result = await saveFont('Inter', 92, []);

    expect(result).toEqual({ ok: true, data: { id: 'font-1' } });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/saved-fonts');
  });

  it('deleteSavedFont deletes /saved-fonts/:id', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(emptyResponse(204));

    const result = await deleteSavedFont('font-1');

    expect(result).toEqual({ ok: true, data: null });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/saved-fonts/font-1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('logScan', () => {
  it('posts to /scans and works with no stored auth (optional auth)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'scan-1', createdAt: '2026-01-01T00:00:00.000Z' }));

    const result = await logScan('match', 'Inter', 92);

    expect(result).toEqual({ ok: true, data: null });
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers.Authorization).toBeUndefined();
  });
});
