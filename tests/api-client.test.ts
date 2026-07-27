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
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
  getSavedFonts,
  getScans,
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

  it('does not resurrect a session if logout happens while a refresh is in flight', async () => {
    await setStoredAuth(STORED);
    let resolveRefresh!: (value: Response) => void;
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' })) // original request 401s
      .mockReturnValueOnce(refreshPromise) // /auth/refresh call, held open
      .mockResolvedValueOnce(emptyResponse(204)) // /auth/logout call, fired while the refresh above is in flight
      .mockResolvedValueOnce(jsonResponse(200, { savedFonts: [] })); // only consumed if the bug retries the original request

    const apiFetchPromise = apiFetch('/saved-fonts', { method: 'GET', auth: 'required' });

    // Drain the microtask queue until apiFetch has actually reached the
    // held-open refresh call. This can't overshoot: refreshPromise stays
    // pending, so execution cannot progress past it no matter how many
    // extra ticks we drain — that's what makes this deterministic rather
    // than a guess at a magic tick count.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(fetchMock.mock.calls.some(([url]) => url === 'http://localhost:3001/auth/refresh')).toBe(true);

    // Log out while that refresh is still in flight.
    await logout();

    // Now let the stale refresh resolve successfully.
    resolveRefresh(
      jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-01-02T00:00:00.000Z' }),
    );

    await apiFetchPromise;

    // The logout must stick — the stale refresh must not have written new tokens back.
    await expect(getStoredAuth()).resolves.toBeNull();
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

describe('matchImage', () => {
  it('posts the blob as multipart form data and returns the matches array', async () => {
    const matches = [{ fontName: 'Inter', confidence: 82, sources: [] }];
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { matches }));

    const blob = new Blob(['fake image data'], { type: 'image/png' });
    const result = await matchImage(blob);

    expect(result).toEqual({ ok: true, data: matches });
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/font-matches');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.body).toBeInstanceOf(FormData);
    expect(requestInit.headers).toBeUndefined();

    // The server's multer().single('image') requires this exact field name —
    // a silent rename here would 400 in production while every other
    // assertion above kept passing.
    const uploaded = (requestInit.body as FormData).get('image') as File;
    expect(uploaded.name).toBe('crop.png');
    expect(uploaded.size).toBe(blob.size);
    expect(uploaded.type).toBe(blob.type);
  });

  it('returns the server error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'image is required' }));

    const result = await matchImage(new Blob());

    expect(result).toEqual({ ok: false, error: 'image is required' });
  });

  it('falls back to a generic error when the error response has no JSON body', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(500));

    const result = await matchImage(new Blob());

    expect(result).toEqual({ ok: false, error: 'Request failed with status 500' });
  });
});

describe('getPendingSubmissions', () => {
  it('fetches and unwraps the submissions array', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { submissions: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] }),
    );

    const result = await getPendingSubmissions();

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/font-submissions/pending');
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await getPendingSubmissions();

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('confirmFontSubmission', () => {
  it('posts to /font-submissions/:id/confirm with the proposed sourceUrl in the body', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'pending', confirmationCount: 2 }));

    const result = await confirmFontSubmission('sub-1', 'https://fonts.adobe.com/fonts/brandon-grotesque');

    expect(result).toEqual({ ok: true, data: { status: 'pending', confirmationCount: 2 } });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/font-submissions/sub-1/confirm');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].body).toBe(
      JSON.stringify({ sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque' }),
    );
  });

  it('sends a null sourceUrl when none is proposed', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'pending', confirmationCount: 2 }));

    await confirmFontSubmission('sub-1', null);

    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ sourceUrl: null }));
  });
});

describe('resolveFontName', () => {
  it('fetches with the font-family stack URL-encoded and unwraps the result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        fontName: 'Brandon Grotesque',
        sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
      }),
    );

    const result = await resolveFontName('"Brandon Grotesque", sans-serif');

    expect(result).toEqual({
      ok: true,
      data: {
        fontName: 'Brandon Grotesque',
        sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:3001/fonts/resolve?name=%22Brandon%20Grotesque%22%2C%20sans-serif',
    );
  });

  it('returns the server error on a non-2xx response (e.g. not found)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'Font not found' }));

    const result = await resolveFontName('SomeUnknownFont');

    expect(result).toEqual({ ok: false, error: 'Font not found' });
  });

  it('attaches a stored access token when present, without requiring one', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { fontName: 'Brandon Grotesque', sources: [] }));

    await resolveFontName('Brandon Grotesque');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-1');
  });

  it('works with no stored auth at all', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { fontName: 'Brandon Grotesque', sources: [] }));

    const result = await resolveFontName('Brandon Grotesque');

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe('submitFont', () => {
  it('posts the blob and fields as multipart form data with the stored access token attached', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { submissionId: 'sub-1' }));

    const blob = new Blob(['fake image data'], { type: 'image/png' });
    const result = await submitFont('Brandon Grotesque', 'https://example.com', blob);

    expect(result).toEqual({ ok: true, data: { submissionId: 'sub-1' } });
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/font-submissions');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers.Authorization).toBe('Bearer access-1');
    expect(requestInit.body).toBeInstanceOf(FormData);

    const body = requestInit.body as FormData;
    expect(body.get('fontName')).toBe('Brandon Grotesque');
    expect(body.get('sourceUrl')).toBe('https://example.com');
    const uploaded = body.get('image') as File;
    expect(uploaded.name).toBe('sample.png');
    expect(uploaded.size).toBe(blob.size);
  });

  it('omits the sourceUrl field entirely when null', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { submissionId: 'sub-1' }));

    await submitFont('Brandon Grotesque', null, new Blob(['fake']));

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('sourceUrl')).toBeNull();
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await submitFont('Brandon Grotesque', null, new Blob());

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes and retries once on a 401', async () => {
    await setStoredAuth(STORED);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-01-02T00:00:00.000Z' }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { submissionId: 'sub-1' }));

    const result = await submitFont('Brandon Grotesque', null, new Blob(['fake']));

    expect(result).toEqual({ ok: true, data: { submissionId: 'sub-1' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryHeaders = fetchMock.mock.calls[2][1].headers;
    expect(retryHeaders.Authorization).toBe('Bearer access-2');
  });

  it('returns the server error message on a non-2xx response', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'fontName is required' }));

    const result = await submitFont('', null, new Blob());

    expect(result).toEqual({ ok: false, error: 'fontName is required' });
  });
});

describe('getSavedFonts', () => {
  it('fetches and unwraps the savedFonts array', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        savedFonts: [
          { id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );

    const result = await getSavedFonts();

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/saved-fonts');
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await getSavedFonts();

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getScans', () => {
  it('fetches and unwraps the scans array', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        scans: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );

    const result = await getScans();

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/scans');
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await getScans();

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
