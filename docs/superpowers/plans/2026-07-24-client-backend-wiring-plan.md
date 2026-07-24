# Client/Backend Wiring Implementation Plan (Sub-project 4b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the fontCIA extension client to the backend server built in sub-project 4a — real persistence for Save/Unsave, scan-outcome logging, a bare-bones login/signup page, and `chrome.storage.local`-backed token storage with reactive refresh — with every backend call proxied through the background service worker.

**Architecture:** New shared message-contract and config files (`src/shared/`), a new background-only auth-storage + API-client layer (`src/background/`) that owns all `fetch()` calls and token lifecycle, a new standalone `login.html`/`login.ts` extension page, and targeted changes to the existing `locked-selection.ts`/`scan-dialogue.ts` to consume the new message protocol instead of local-only state.

**Tech Stack:** Vanilla TypeScript, native `fetch`, `chrome.runtime` message passing, `chrome.storage.local`, esbuild, Vitest + jsdom.

---

## File Structure

```
src/
  shared/
    api-config.ts        — API_BASE_URL constant (new)
    api-messages.ts       — ApiMessage / ApiResponse<T> type contract (new)
  background/
    auth-storage.ts       — chrome.storage.local read/write/clear for the auth record (new)
    api-client.ts         — fetch wrapper, 401-refresh-and-retry, single-flight guard, per-endpoint functions (new)
    service-worker.ts     — gains a chrome.runtime.onMessage handler for ApiMessage (modified)
  content/
    scan-dialogue.ts      — renderResultState gains isLoggedIn/onLoginPrompt (modified)
    locked-selection.ts   — async save/unsave, auth check, login prompt, cross-tab reactivity (modified)
  login/
    login.html             — bare-bones login/signup page markup (new)
    login.ts                — login/signup/logout page logic (new)
tests/
  auth-storage.test.ts     (new)
  api-client.test.ts       (new)
  service-worker.test.ts   (modified — extends existing file)
  scan-dialogue.test.ts    (modified — extends existing file)
  locked-selection.test.ts (modified — extends existing file)
  login.test.ts            (new)
  helpers/chrome-mock.ts   (modified — adds storage.local, storage.onChanged, runtime.sendMessage, runtime.getURL)
manifest.json               (modified — host_permissions, web_accessible_resources)
esbuild.config.mjs          (modified — new login page entry point)
```

Nothing under `server/` is touched by this plan.

---

### Task 1: Shared API Types and Config

**Files:**
- Create: `src/shared/api-config.ts`
- Create: `src/shared/api-messages.ts`

No dedicated test file for this task — both files are pure type/constant declarations with no logic, the same category as the existing untested `src/content/scan-types.ts`.

- [ ] **Step 1: Create `src/shared/api-config.ts`**

```ts
// Hardcoded for this dev-focused pass — there is no deployed production server
// yet, so an environment-config system would be speculative. Revisit once a
// real deployment target exists.
export const API_BASE_URL = 'http://localhost:3001';
```

- [ ] **Step 2: Create `src/shared/api-messages.ts`**

```ts
import type { ScanSource } from '../content/scan-types';

export type ApiMessage =
  | { type: 'SIGNUP'; email: string; password: string }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'SAVE_FONT'; fontName: string; confidence: number; sources: ScanSource[] }
  | { type: 'DELETE_SAVED_FONT'; id: string }
  | { type: 'LOG_SCAN'; status: 'match' | 'no-match'; fontName?: string; confidence?: number };

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/api-config.ts src/shared/api-messages.ts
git commit -m "feat: add shared API message contract and config"
```

---

### Task 2: Auth Storage Module

**Files:**
- Create: `src/background/auth-storage.ts`
- Modify: `tests/helpers/chrome-mock.ts` (add `storage.local`)
- Test: `tests/auth-storage.test.ts`

- [ ] **Step 1: Extend `tests/helpers/chrome-mock.ts` with `storage.local`**

Current file (reproduced in full for reference):

```ts
import { vi } from 'vitest';

export function createChromeMock() {
  const store = new Map<string, unknown>();
  const messageListeners: Array<(message: unknown) => void> = [];

  return {
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (store.has(key)) result[key] = store.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) store.delete(key);
        }),
        setAccessLevel: vi.fn(async () => {}),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (message: unknown) => void) => {
          messageListeners.push(fn);
        }),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        for (const fn of messageListeners) fn(message);
      }),
    },
    action: {
      onClicked: {
        addListener: vi.fn((_fn: (tab: { id: number }) => void) => {}),
      },
      setBadgeText: vi.fn(async (_details: { text: string }) => {}),
      setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => {}),
    },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;
```

Replace it with:

```ts
import { vi } from 'vitest';

export function createChromeMock() {
  const store = new Map<string, unknown>();
  const localStore = new Map<string, unknown>();
  const messageListeners: Array<(message: unknown) => void> = [];

  return {
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (store.has(key)) result[key] = store.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) store.delete(key);
        }),
        setAccessLevel: vi.fn(async () => {}),
      },
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (localStore.has(key)) result[key] = localStore.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) localStore.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) localStore.delete(key);
        }),
      },
      onChanged: {
        addListener: vi.fn((_fn: (changes: unknown, areaName: string) => void) => {}),
        removeListener: vi.fn((_fn: (changes: unknown, areaName: string) => void) => {}),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (message: unknown) => void) => {
          messageListeners.push(fn);
        }),
      },
      sendMessage: vi.fn(),
      getURL: vi.fn((path: string) => `chrome-extension://fake-extension-id/${path}`),
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        for (const fn of messageListeners) fn(message);
      }),
    },
    action: {
      onClicked: {
        addListener: vi.fn((_fn: (tab: { id: number }) => void) => {}),
      },
      setBadgeText: vi.fn(async (_details: { text: string }) => {}),
      setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => {}),
    },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;
```

`runtime.sendMessage` is deliberately left with no default implementation — each test configures its own `mockResolvedValueOnce(...)`, so a test that forgets to mock it fails loudly (`.then` on `undefined`) rather than silently passing against a made-up default.

- [ ] **Step 2: Write the failing test**

`tests/auth-storage.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/auth-storage.test.ts`
Expected: FAIL — `Cannot find module '../src/background/auth-storage'`

- [ ] **Step 4: Write `src/background/auth-storage.ts`**

```ts
export interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  email: string;
}

const AUTH_STORAGE_KEY = 'fontcia-auth';

export async function getStoredAuth(): Promise<StoredAuth | null> {
  const result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  return (result[AUTH_STORAGE_KEY] as StoredAuth | undefined) ?? null;
}

export async function setStoredAuth(auth: StoredAuth): Promise<void> {
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: auth });
}

export async function clearStoredAuth(): Promise<void> {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/auth-storage.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 6: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; all existing tests plus the 3 new ones pass.

- [ ] **Step 7: Commit**

```bash
git add tests/helpers/chrome-mock.ts tests/auth-storage.test.ts src/background/auth-storage.ts
git commit -m "feat: add chrome.storage.local-backed auth storage module"
```

---

### Task 3: API Client

**Files:**
- Create: `src/background/api-client.ts`
- Test: `tests/api-client.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/api-client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api-client.test.ts`
Expected: FAIL — `Cannot find module '../src/background/api-client'`

- [ ] **Step 3: Write `src/background/api-client.ts`**

```ts
import { API_BASE_URL } from '../shared/api-config';
import { getStoredAuth, setStoredAuth, clearStoredAuth } from './auth-storage';
import type { ApiResponse } from '../shared/api-messages';
import type { ScanSource } from '../content/scan-types';

interface FetchOptions {
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  auth: 'required' | 'optional' | 'none';
}

interface RawResult {
  status: number;
  json: unknown;
}

async function rawRequest(path: string, method: string, body: unknown, accessToken: string | null): Promise<RawResult> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  return { status: res.status, json };
}

async function doRefresh(): Promise<boolean> {
  const stored = await getStoredAuth();
  if (!stored) return false;

  const { status, json } = await rawRequest('/auth/refresh', 'POST', { refreshToken: stored.refreshToken }, null);

  if (status !== 200) {
    await clearStoredAuth();
    return false;
  }

  const data = json as { accessToken: string; refreshToken: string; expiresAt: string };
  await setStoredAuth({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    userId: stored.userId,
    email: stored.email,
  });
  return true;
}

// Scoped to the service worker's current in-memory lifetime, which is
// sufficient: MV3 handles concurrent onMessage events within one active
// instance without spinning up parallel instances, and a service-worker
// restart only happens between bursts of activity, not mid-burst.
let refreshInFlight: Promise<boolean> | null = null;

async function ensureFreshToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function apiFetch<T>(path: string, options: FetchOptions): Promise<ApiResponse<T>> {
  const stored = options.auth === 'none' ? null : await getStoredAuth();

  if (options.auth === 'required' && !stored) {
    return { ok: false, error: 'Not logged in' };
  }

  let { status, json } = await rawRequest(path, options.method, options.body, stored?.accessToken ?? null);

  if (status === 401 && options.auth !== 'none' && stored) {
    const refreshed = await ensureFreshToken();
    if (refreshed) {
      const refreshedAuth = await getStoredAuth();
      ({ status, json } = await rawRequest(path, options.method, options.body, refreshedAuth?.accessToken ?? null));
    }
  }

  if (status >= 200 && status < 300) {
    return { ok: true, data: json as T };
  }

  const errorMessage = (json as { error?: string } | null)?.error ?? `Request failed with status ${status}`;
  return { ok: false, error: errorMessage };
}

export async function signup(
  email: string,
  password: string,
): Promise<ApiResponse<{ user: { id: string; email: string } }>> {
  const result = await apiFetch<{
    user: { id: string; email: string };
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  }>('/auth/signup', { method: 'POST', body: { email, password }, auth: 'none' });

  if (!result.ok) return result;

  await setStoredAuth({
    accessToken: result.data.accessToken,
    refreshToken: result.data.refreshToken,
    expiresAt: result.data.expiresAt,
    userId: result.data.user.id,
    email: result.data.user.email,
  });

  return { ok: true, data: { user: result.data.user } };
}

export async function login(
  email: string,
  password: string,
): Promise<ApiResponse<{ user: { id: string; email: string } }>> {
  const result = await apiFetch<{
    user: { id: string; email: string };
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  }>('/auth/login', { method: 'POST', body: { email, password }, auth: 'none' });

  if (!result.ok) return result;

  await setStoredAuth({
    accessToken: result.data.accessToken,
    refreshToken: result.data.refreshToken,
    expiresAt: result.data.expiresAt,
    userId: result.data.user.id,
    email: result.data.user.email,
  });

  return { ok: true, data: { user: result.data.user } };
}

export async function logout(): Promise<ApiResponse<null>> {
  const stored = await getStoredAuth();
  if (stored) {
    await rawRequest('/auth/logout', 'POST', { refreshToken: stored.refreshToken }, null);
  }
  await clearStoredAuth();
  return { ok: true, data: null };
}

export async function getAuthState(): Promise<ApiResponse<{ loggedIn: boolean; email?: string }>> {
  const stored = await getStoredAuth();
  return { ok: true, data: stored ? { loggedIn: true, email: stored.email } : { loggedIn: false } };
}

export async function saveFont(
  fontName: string,
  confidence: number,
  sources: ScanSource[],
): Promise<ApiResponse<{ id: string }>> {
  const result = await apiFetch<{ savedFont: { id: string } }>('/saved-fonts', {
    method: 'POST',
    body: { fontName, confidence, sources },
    auth: 'required',
  });

  if (!result.ok) return result;
  return { ok: true, data: { id: result.data.savedFont.id } };
}

export async function deleteSavedFont(id: string): Promise<ApiResponse<null>> {
  return apiFetch<null>(`/saved-fonts/${id}`, { method: 'DELETE', auth: 'required' });
}

export async function logScan(
  status: 'match' | 'no-match',
  fontName?: string,
  confidence?: number,
): Promise<ApiResponse<null>> {
  return apiFetch<null>('/scans', { method: 'POST', body: { status, fontName, confidence }, auth: 'optional' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api-client.test.ts`
Expected: PASS — count the `it(...)` blocks: apiFetch (6) + signup/login (2) + logout (2) + getAuthState (2) + saveFont/deleteSavedFont (2) + logScan (1) = **15 tests passed**.

- [ ] **Step 5: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/api-client.ts tests/api-client.test.ts
git commit -m "feat: add API client with 401-refresh-and-retry and single-flight guard"
```

---

### Task 4: Service Worker Message Handler

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts` (extends existing file)

- [ ] **Step 1: Write the failing tests**

Current `tests/service-worker.test.ts` ends with a `describe('module load side effects', ...)` block. Add this new `describe` block immediately before that final block (i.e., after the `describe('isInjectableUrl', ...)` block and before `describe('module load side effects', ...)`):

```ts
describe('handleApiMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('dispatches SIGNUP to the api-client signup function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(async () => ({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } })),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { signup } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'SIGNUP', email: 'a@example.com', password: 'password123' });

    expect(signup).toHaveBeenCalledWith('a@example.com', 'password123');
    expect(result).toEqual({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });
  });

  it('dispatches LOGIN to the api-client login function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(async () => ({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } })),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { login } = await import('../src/background/api-client');

    await handleApiMessage({ type: 'LOGIN', email: 'a@example.com', password: 'password123' });

    expect(login).toHaveBeenCalledWith('a@example.com', 'password123');
  });

  it('dispatches LOGOUT to the api-client logout function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(async () => ({ ok: true, data: null })),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { logout } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'LOGOUT' });

    expect(logout).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, data: null });
  });

  it('dispatches GET_AUTH_STATE to the api-client getAuthState function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(async () => ({ ok: true, data: { loggedIn: false } })),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { getAuthState } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'GET_AUTH_STATE' });

    expect(getAuthState).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, data: { loggedIn: false } });
  });

  it('dispatches SAVE_FONT to the api-client saveFont function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(async () => ({ ok: true, data: { id: 'font-1' } })),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { saveFont } = await import('../src/background/api-client');

    const result = await handleApiMessage({
      type: 'SAVE_FONT',
      fontName: 'Inter',
      confidence: 92,
      sources: [],
    });

    expect(saveFont).toHaveBeenCalledWith('Inter', 92, []);
    expect(result).toEqual({ ok: true, data: { id: 'font-1' } });
  });

  it('dispatches DELETE_SAVED_FONT to the api-client deleteSavedFont function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(async () => ({ ok: true, data: null })),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { deleteSavedFont } = await import('../src/background/api-client');

    await handleApiMessage({ type: 'DELETE_SAVED_FONT', id: 'font-1' });

    expect(deleteSavedFont).toHaveBeenCalledWith('font-1');
  });

  it('dispatches LOG_SCAN to the api-client logScan function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(async () => ({ ok: true, data: null })),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { logScan } = await import('../src/background/api-client');

    await handleApiMessage({ type: 'LOG_SCAN', status: 'match', fontName: 'Inter', confidence: 92 });

    expect(logScan).toHaveBeenCalledWith('match', 'Inter', 92);
  });

  it('returns an error response for an unrecognized message type', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');

    // @ts-expect-error deliberately malformed input to prove the runtime fallback
    const result = await handleApiMessage({ type: 'NOT_A_REAL_MESSAGE' });

    expect(result).toEqual({ ok: false, error: 'Unknown message type' });
  });
});
```

Also add `vi.doMock`/module-reset imports to the top of the file: change the existing top import block from:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { moduleLoadChromeMock } from './setup';
import { handleIconClick, isInjectableUrl } from '../src/background/service-worker';
```

to:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { moduleLoadChromeMock } from './setup';
import { handleIconClick, isInjectableUrl } from '../src/background/service-worker';
```

(only the `vitest` import gains `vi` — the rest of the file, including the existing `describe('handleIconClick', ...)`, `describe('isInjectableUrl', ...)`, and `describe('module load side effects', ...)` blocks, is unchanged.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — `handleApiMessage` is not exported from `../src/background/service-worker`.

- [ ] **Step 3: Modify `src/background/service-worker.ts`**

Current file ends with:

```ts
chrome.action.onClicked.addListener(handleIconClick);
```

Change the top imports from:

```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
```

to:

```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan } from './api-client';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
```

And change the final line from:

```ts
chrome.action.onClicked.addListener(handleIconClick);
```

to:

```ts
chrome.action.onClicked.addListener(handleIconClick);

export async function handleApiMessage(message: ApiMessage): Promise<ApiResponse<unknown>> {
  switch (message.type) {
    case 'SIGNUP':
      return signup(message.email, message.password);
    case 'LOGIN':
      return login(message.email, message.password);
    case 'LOGOUT':
      return logout();
    case 'GET_AUTH_STATE':
      return getAuthState();
    case 'SAVE_FONT':
      return saveFont(message.fontName, message.confidence, message.sources);
    case 'DELETE_SAVED_FONT':
      return deleteSavedFont(message.id);
    case 'LOG_SCAN':
      return logScan(message.status, message.fontName, message.confidence);
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

chrome.runtime.onMessage.addListener((message: ApiMessage, _sender, sendResponse) => {
  handleApiMessage(message).then(sendResponse);
  return true;
});
```

Everything else in the file (`isInjectableUrl`, `flashUnavailableBadge`, `handleIconClick`, the module-load `setAccessLevel` call) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — the file's existing 14 tests (7 in `handleIconClick`, 6 in `isInjectableUrl`, 1 in `module load side effects`) plus the new 8 `handleApiMessage` tests = **22 tests passed**.

- [ ] **Step 5: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: add background message handler for the API message contract"
```

---

### Task 5: `renderResultState` Gains Logged-Out Handling

**Files:**
- Modify: `src/content/scan-dialogue.ts`
- Test: `tests/scan-dialogue.test.ts` (extends existing file)

- [ ] **Step 1: Update the failing tests**

In `tests/scan-dialogue.test.ts`, within `describe('renderResultState', ...)`, update the 4 existing calls to `renderResultState` to pass two new trailing arguments (`isLoggedIn`, `onLoginPrompt`), and add 2 new tests. Replace the entire `describe('renderResultState', ...)` block with:

```ts
describe('renderResultState', () => {
  const result: MatchResult = {
    status: 'match',
    fontName: 'Inter',
    confidence: 92,
    sources: [
      { url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 14 },
      { url: 'https://rsms.me/inter/', label: 'Official site', votes: 6 },
    ],
  };

  it('renders the font name, confidence, and all sources', () => {
    const body = document.createElement('div');

    renderResultState(body, result, false, vi.fn(), vi.fn(), true, vi.fn());

    expect(body.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');
    expect(body.querySelector('.fontcia-confidence')?.textContent).toBe('92% confidence');

    const links = body.querySelectorAll('.fontcia-source-link');
    expect(links.length).toBe(2);
    expect((links[0] as HTMLAnchorElement).href).toBe('https://fonts.google.com/specimen/Inter');
  });

  it('shows unsaved state and calls onToggleSave on click when logged in', () => {
    const body = document.createElement('div');
    const onToggleSave = vi.fn();

    renderResultState(body, result, false, onToggleSave, vi.fn(), true, vi.fn());

    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');

    saveBtn.click();
    expect(onToggleSave).toHaveBeenCalledOnce();
  });

  it('shows saved state when saved is true and logged in', () => {
    const body = document.createElement('div');

    renderResultState(body, result, true, vi.fn(), vi.fn(), true, vi.fn());

    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('★ Saved');
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderResultState(body, result, false, vi.fn(), onNewScan, true, vi.fn());

    const newScanBtn = body.querySelector('.fontcia-btn-secondary') as HTMLButtonElement;
    expect(newScanBtn.textContent).toBe('New scan');

    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });

  it('shows a "Log in to save" button instead of Save/Saved when not logged in', () => {
    const body = document.createElement('div');

    renderResultState(body, result, false, vi.fn(), vi.fn(), false, vi.fn());

    const loginBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(loginBtn.textContent).toBe('Log in to save');
  });

  it('calls onLoginPrompt when "Log in to save" is clicked', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderResultState(body, result, false, vi.fn(), vi.fn(), false, onLoginPrompt);

    const loginBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    loginBtn.click();

    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: FAIL — `renderResultState` is called with too many arguments (TypeScript) / the login-button tests find no `.fontcia-btn-primary` with the expected text.

- [ ] **Step 3: Modify `src/content/scan-dialogue.ts`**

Change the `renderResultState` function signature and body from:

```ts
export function renderResultState(
  body: HTMLElement,
  result: MatchResult,
  saved: boolean,
  onToggleSave: () => void,
  onNewScan: () => void,
): void {
  body.replaceChildren();

  const fontName = document.createElement('div');
  fontName.className = 'fontcia-result-font';
  fontName.textContent = result.fontName;
  body.appendChild(fontName);

  const confidence = document.createElement('div');
  confidence.className = 'fontcia-confidence';
  confidence.textContent = `${result.confidence}% confidence`;
  body.appendChild(confidence);

  const sourcesList = document.createElement('ul');
  sourcesList.className = 'fontcia-sources';
  for (const source of result.sources) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'fontcia-source-link';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.label;
    item.appendChild(link);
    sourcesList.appendChild(item);
  }
  body.appendChild(sourcesList);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'fontcia-btn fontcia-btn-primary';
  saveBtn.textContent = saved ? '★ Saved' : '☆ Save';
  saveBtn.addEventListener('click', onToggleSave);
  actions.appendChild(saveBtn);

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

to:

```ts
export function renderResultState(
  body: HTMLElement,
  result: MatchResult,
  saved: boolean,
  onToggleSave: () => void,
  onNewScan: () => void,
  isLoggedIn: boolean,
  onLoginPrompt: () => void,
): void {
  body.replaceChildren();

  const fontName = document.createElement('div');
  fontName.className = 'fontcia-result-font';
  fontName.textContent = result.fontName;
  body.appendChild(fontName);

  const confidence = document.createElement('div');
  confidence.className = 'fontcia-confidence';
  confidence.textContent = `${result.confidence}% confidence`;
  body.appendChild(confidence);

  const sourcesList = document.createElement('ul');
  sourcesList.className = 'fontcia-sources';
  for (const source of result.sources) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'fontcia-source-link';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.label;
    item.appendChild(link);
    sourcesList.appendChild(item);
  }
  body.appendChild(sourcesList);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  if (isLoggedIn) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'fontcia-btn fontcia-btn-primary';
    saveBtn.textContent = saved ? '★ Saved' : '☆ Save';
    saveBtn.addEventListener('click', onToggleSave);
    actions.appendChild(saveBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-primary';
    loginBtn.textContent = 'Log in to save';
    loginBtn.addEventListener('click', onLoginPrompt);
    actions.appendChild(loginBtn);
  }

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — `renderReadyState` (2) + `renderLoadingState` (1) + `renderResultState` (6) + `renderNoMatchState` (2) = **11 tests passed**.

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean — note this will show errors in `src/content/locked-selection.ts` (the only other caller of `renderResultState`) until Task 6 updates it; that's expected at this point in the plan. If your tooling fails the build on any `tsc` error repo-wide, treat that as expected/known at this step and proceed to Task 6, which fixes it — don't attempt a workaround here.

- [ ] **Step 6: Commit**

```bash
git add src/content/scan-dialogue.ts tests/scan-dialogue.test.ts
git commit -m "feat: renderResultState shows a login prompt instead of Save when logged out"
```

---

### Task 6: Locked-Selection — Async Save/Unsave, Auth Check, Login Prompt, Cross-Tab Reactivity

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts` (full rewrite — most tests change)

This is the largest task in the plan. Work through it carefully; the test file below replaces the entire current file.

- [ ] **Step 1: Replace `tests/locked-selection.test.ts` in full**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderLockedSelection } from '../src/content/locked-selection';
import type { ScanResult } from '../src/content/scan-types';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') {
      return { ok: true, data: { loggedIn: true } };
    }
    return { ok: true, data: null };
  });
});

describe('renderLockedSelection', () => {
  it('renders a box positioned to the rect', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { box } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());

    expect(box.className).toBe('fontcia-box');
    expect(box.style.left).toBe('10px');
    expect(box.style.top).toBe('20px');
    expect(box.style.width).toBe('100px');
    expect(box.style.height).toBe('30px');
    expect(container.contains(box)).toBe(true);
  });

  it('renders a panel underneath the box with a notch and close button', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());

    expect(panel.className).toBe('fontcia-panel');
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('58px'); // rect.y + rect.height + 8px gap
    expect(panel.querySelector('.fontcia-notch')).not.toBeNull();
    expect(panel.querySelector('.fontcia-panel-close')).not.toBeNull();
    expect(container.contains(panel)).toBe(true);
  });

  it('calls onDismiss when the close button is clicked', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());
    const closeBtn = panel.querySelector('.fontcia-panel-close') as HTMLElement;
    closeBtn.click();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows the ready state with a Scan button initially', () => {
    const container = document.createElement('div');

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn());

    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(scanBtn.textContent).toBe('Scan');
  });

  it('transitions ready -> loading -> result when Scan is clicked and the mock resolves to a match, while logged in', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();

    deferred.resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
    await deferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');
    const saveBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');
  });

  it('shows "Log in to save" instead of Save when GET_AUTH_STATE reports logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') {
        return { ok: true, data: { loggedIn: false } };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const loginBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(loginBtn.textContent).toBe('Log in to save');
  });

  it('opens the login page via window.open when "Log in to save" is clicked', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') {
        return { ok: true, data: { loggedIn: false } };
      }
      return { ok: true, data: null };
    });
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();

    expect(windowOpenSpy).toHaveBeenCalledWith('chrome-extension://fake-extension-id/login/login.html', '_blank');

    windowOpenSpy.mockRestore();
  });

  it('transitions ready -> loading -> no-match when the mock resolves to no-match', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 40, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();

    deferred.resolve({ status: 'no-match' });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-no-match-message')).not.toBeNull();
  });

  it('saves the font via SAVE_FONT and shows Saved on success', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'SAVE_FONT') return { ok: true, data: { id: 'font-1' } };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const saveBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');

    saveBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_FONT',
      fontName: 'Inter',
      confidence: 92,
      sources: [],
    });
    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('★ Saved');
  });

  it('unsaves via DELETE_SAVED_FONT using the id returned from the save call', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'SAVE_FONT') return { ok: true, data: { id: 'font-1' } };
      if (message.type === 'DELETE_SAVED_FONT') return { ok: true, data: null };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'DELETE_SAVED_FONT', id: 'font-1' });
    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('☆ Save');
  });

  it('reverts to unsaved and logs an error when SAVE_FONT fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'SAVE_FONT') return { ok: false, error: 'Not logged in' };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('☆ Save');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('calls onRestart when New scan is clicked in the result state', async () => {
    const container = document.createElement('div');
    const onRestart = vi.fn();
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      onRestart,
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const newScanBtn = panel.querySelector('.fontcia-btn-secondary') as HTMLButtonElement;
    newScanBtn.click();

    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('does not render a result if dispose() is called before the mock resolves', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel, dispose } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    dispose();

    deferred.resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
    await deferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-result-font')).toBeNull();
    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();
  });

  it('falls back to the no-match state if the scan promise rejects', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.reject(new Error('boom')));

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')).not.toBeNull();
  });

  it('does not render the no-match fallback if dispose() is called before the scan promise rejects', async () => {
    const container = document.createElement('div');
    let rejectScan!: (error: Error) => void;
    const scanFn = vi.fn(
      () =>
        new Promise<ScanResult>((_resolve, reject) => {
          rejectScan = reject;
        }),
    );

    const { panel, dispose } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    dispose();

    rejectScan(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')).toBeNull();
    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();
  });

  it('logs a scan via LOG_SCAN on a match result', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOG_SCAN',
      status: 'match',
      fontName: 'Inter',
      confidence: 92,
    });
  });

  it('logs a scan via LOG_SCAN on a no-match result', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match' }));

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
  });

  it('logs a scan via LOG_SCAN when the scan promise rejects', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.reject(new Error('boom')));

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
  });

  it('registers a storage.onChanged listener and re-renders the Save area when auth state changes', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('☆ Save');
    expect(chromeMock.storage.onChanged.addListener).toHaveBeenCalledOnce();

    // Simulate the user logging in from the separate login.html tab: flip the
    // mocked GET_AUTH_STATE response, then fire the change listener directly,
    // exactly as chrome.storage.onChanged would when the login page's
    // background write completes.
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });
    const changeListener = chromeMock.storage.onChanged.addListener.mock.calls[0][0];
    changeListener({ 'fontcia-auth': { newValue: undefined } }, 'local');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('Log in to save');
  });

  it('removes the storage.onChanged listener on dispose', () => {
    const container = document.createElement('div');

    const { dispose } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn());

    dispose();

    expect(chromeMock.storage.onChanged.removeListener).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — the current implementation doesn't call `chrome.runtime.sendMessage`, doesn't check auth state, and `renderResultState`'s new required parameters aren't supplied.

- [ ] **Step 3: Modify `src/content/locked-selection.ts`**

Replace the entire file with:

```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import { resolveFontFromSelection } from './font-resolver';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from './scan-dialogue';

export interface LockedSelectionElements {
  box: HTMLDivElement;
  panel: HTMLDivElement;
  dispose: () => void;
}

function applyRect(el: HTMLDivElement, rect: Rect): void {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

async function sendApiMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export function renderLockedSelection(
  container: ParentNode,
  rect: Rect,
  onDismiss: () => void,
  onRestart: () => void,
  scanFn: (rect: Rect) => Promise<ScanResult> = resolveFontFromSelection,
): LockedSelectionElements {
  const box = document.createElement('div');
  box.className = 'fontcia-box';
  applyRect(box, rect);
  container.appendChild(box);

  const panel = document.createElement('div');
  panel.className = 'fontcia-panel';
  panel.style.left = `${rect.x}px`;
  panel.style.top = `${rect.y + rect.height + 8}px`;
  // Stop mouse events on the panel from bubbling to the drag surface underneath
  // it, so interacting with panel content (e.g. a future scrollable area) can't
  // be mistaken for a new drag gesture.
  panel.addEventListener('mousedown', (event) => event.stopPropagation());

  const notch = document.createElement('div');
  notch.className = 'fontcia-notch';
  panel.appendChild(notch);

  const header = document.createElement('div');
  header.className = 'fontcia-panel-header';

  const title = document.createElement('strong');
  title.textContent = 'Scan dialogue';
  header.appendChild(title);

  const closeBtn = document.createElement('span');
  closeBtn.className = 'fontcia-panel-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', onDismiss);
  header.appendChild(closeBtn);

  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'fontcia-panel-body';
  panel.appendChild(body);

  container.appendChild(panel);

  // State is scoped to this one closure — a fresh instance every time a
  // selection locks, never module-level, so there's no cross-instance leakage.
  let disposed = false;
  let savedFontId: string | null = null;
  let currentResult: MatchResult | null = null;

  function handleLoginPrompt(): void {
    window.open(chrome.runtime.getURL('login/login.html'), '_blank');
  }

  async function renderResult(): Promise<void> {
    if (!currentResult) return;
    const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
    if (disposed || !currentResult) return;
    const isLoggedIn = authRes.ok && authRes.data.loggedIn;
    renderResultState(body, currentResult, savedFontId !== null, handleToggleSave, onRestart, isLoggedIn, handleLoginPrompt);
  }

  function showResult(result: MatchResult): void {
    currentResult = result;
    savedFontId = null;
    void renderResult();
  }

  function handleToggleSave(): void {
    if (!currentResult) return;
    const wasSaved = savedFontId !== null;
    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;

    if (wasSaved) {
      const idToDelete = savedFontId as string;
      sendApiMessage<null>({ type: 'DELETE_SAVED_FONT', id: idToDelete })
        .then((res) => {
          if (disposed) return;
          if (res.ok) {
            savedFontId = null;
          } else {
            console.error('fontCIA: unsave failed', res.error);
          }
          void renderResult();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.error('fontCIA: unsave failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    } else {
      const { fontName, confidence, sources } = currentResult;
      sendApiMessage<{ id: string }>({ type: 'SAVE_FONT', fontName, confidence, sources })
        .then((res) => {
          if (disposed) return;
          if (res.ok) {
            savedFontId = res.data.id;
          } else {
            console.error('fontCIA: save failed', res.error);
          }
          void renderResult();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.error('fontCIA: save failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    }
  }

  function logScanResult(result: ScanResult): void {
    const message: ApiMessage =
      result.status === 'match'
        ? { type: 'LOG_SCAN', status: 'match', fontName: result.fontName, confidence: result.confidence }
        : { type: 'LOG_SCAN', status: 'no-match' };
    sendApiMessage<null>(message).catch((error: unknown) => {
      console.error('fontCIA: scan logging failed', error);
    });
  }

  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        // An in-flight scan must not touch the DOM after the panel is dismissed
        // (Esc, the close button, or an icon-click toggle-off) — all three
        // converge on overlay.ts's teardownOverlay(), which calls dispose()
        // before this promise can resolve into a stale render.
        if (disposed) return;
        if (result.status === 'match') {
          showResult(result);
        } else {
          renderNoMatchState(body, onRestart);
        }
      })
      .catch((error: unknown) => {
        logScanResult({ status: 'no-match', reason: 'error' });
        if (disposed) return;
        console.error('fontCIA: font resolution failed', error);
        renderNoMatchState(body, onRestart);
      });
  }

  renderReadyState(body, handleScan);

  function handleAuthChange(changes: Record<string, unknown>, areaName: string): void {
    if (areaName !== 'local' || !('fontcia-auth' in changes)) return;
    void renderResult();
  }

  chrome.storage.onChanged.addListener(handleAuthChange);

  function dispose(): void {
    disposed = true;
    chrome.storage.onChanged.removeListener(handleAuthChange);
  }

  return { box, panel, dispose };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — **20 tests passed**.

- [ ] **Step 5: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck (the Task 5 typecheck note above is now resolved); all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: wire Save/Unsave and scan logging to the backend via message passing"
```

---

### Task 7: Bare-Bones Login Page

**Files:**
- Create: `src/login/login.html`
- Create: `src/login/login.ts`
- Modify: `esbuild.config.mjs`
- Test: `tests/login.test.ts`

- [ ] **Step 1: Create `src/login/login.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>fontCIA — Log in</title>
  </head>
  <body>
    <div id="loggedInView" hidden>
      <p id="loggedInMessage"></p>
      <button id="logoutBtn" type="button">Log out</button>
    </div>
    <div id="formView">
      <div>
        <button id="modeLoginBtn" type="button">Log in</button>
        <button id="modeSignupBtn" type="button">Sign up</button>
      </div>
      <form id="authForm">
        <input id="emailInput" type="email" placeholder="Email" required />
        <input id="passwordInput" type="password" placeholder="Password" required />
        <button id="submitBtn" type="submit">Log in</button>
      </form>
      <p id="errorMessage" hidden></p>
      <p id="successMessage" hidden></p>
    </div>
    <script src="login.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing tests**

`tests/login.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

const FIXTURE_HTML = `
  <div id="loggedInView" hidden>
    <p id="loggedInMessage"></p>
    <button id="logoutBtn" type="button">Log out</button>
  </div>
  <div id="formView">
    <div>
      <button id="modeLoginBtn" type="button">Log in</button>
      <button id="modeSignupBtn" type="button">Sign up</button>
    </div>
    <form id="authForm">
      <input id="emailInput" type="email" placeholder="Email" required />
      <input id="passwordInput" type="password" placeholder="Password" required />
      <button id="submitBtn" type="submit">Log in</button>
    </form>
    <p id="errorMessage" hidden></p>
    <p id="successMessage" hidden></p>
  </div>
`;

let chromeMock: ReturnType<typeof createChromeMock>;

async function loadLoginPage(): Promise<void> {
  document.body.innerHTML = FIXTURE_HTML;
  vi.resetModules();
  await import('../src/login/login');
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('login page', () => {
  it('shows the form view when GET_AUTH_STATE reports logged out', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: false } });

    await loadLoginPage();

    expect((document.getElementById('formView') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(true);
  });

  it('shows the logged-in view with the email when GET_AUTH_STATE reports logged in', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({
      ok: true,
      data: { loggedIn: true, email: 'a@example.com' },
    });

    await loadLoginPage();

    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('loggedInMessage')?.textContent).toBe('Logged in as a@example.com');
  });

  it('submits a LOGIN message by default and shows the logged-in view on success', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } }) // initial GET_AUTH_STATE
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } }); // LOGIN

    await loadLoginPage();

    (document.getElementById('emailInput') as HTMLInputElement).value = 'a@example.com';
    (document.getElementById('passwordInput') as HTMLInputElement).value = 'password123';
    (document.getElementById('authForm') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOGIN',
      email: 'a@example.com',
      password: 'password123',
    });
    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('loggedInMessage')?.textContent).toBe('Logged in as a@example.com');
  });

  it('submits a SIGNUP message after switching to sign-up mode', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });

    await loadLoginPage();

    (document.getElementById('modeSignupBtn') as HTMLButtonElement).click();
    (document.getElementById('emailInput') as HTMLInputElement).value = 'a@example.com';
    (document.getElementById('passwordInput') as HTMLInputElement).value = 'password123';
    (document.getElementById('authForm') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SIGNUP',
      email: 'a@example.com',
      password: 'password123',
    });
  });

  it('shows the error message text on a failed login', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: false, error: 'Invalid email or password' });

    await loadLoginPage();

    (document.getElementById('emailInput') as HTMLInputElement).value = 'a@example.com';
    (document.getElementById('passwordInput') as HTMLInputElement).value = 'wrongpassword';
    (document.getElementById('authForm') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorEl = document.getElementById('errorMessage') as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('Invalid email or password');
  });

  it('sends LOGOUT and returns to the form view when Log out is clicked', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } })
      .mockResolvedValueOnce({ ok: true, data: null });

    await loadLoginPage();

    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(false);

    (document.getElementById('logoutBtn') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOGOUT' });
    expect((document.getElementById('formView') as HTMLElement).hidden).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/login.test.ts`
Expected: FAIL — `Cannot find module '../src/login/login'`

- [ ] **Step 4: Create `src/login/login.ts`**

```ts
import type { ApiMessage, ApiResponse } from '../shared/api-messages';

type Mode = 'login' | 'signup';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fontCIA login page: missing #${id}`);
  return el;
}

async function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return (await chrome.runtime.sendMessage(message)) as ApiResponse<T>;
}

let mode: Mode = 'login';

function setMode(newMode: Mode): void {
  mode = newMode;
  ($('submitBtn') as HTMLButtonElement).textContent = mode === 'login' ? 'Log in' : 'Sign up';
}

function showError(message: string): void {
  const errorEl = $('errorMessage');
  errorEl.textContent = message;
  errorEl.hidden = false;
  $('successMessage').hidden = true;
}

function showLoggedInView(email: string): void {
  $('formView').hidden = true;
  $('loggedInView').hidden = false;
  $('loggedInMessage').textContent = `Logged in as ${email}`;
}

function showFormView(): void {
  $('loggedInView').hidden = true;
  $('formView').hidden = false;
}

export async function initLoginPage(): Promise<void> {
  $('modeLoginBtn').addEventListener('click', () => setMode('login'));
  $('modeSignupBtn').addEventListener('click', () => setMode('signup'));

  $('authForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = ($('emailInput') as HTMLInputElement).value;
    const password = ($('passwordInput') as HTMLInputElement).value;

    const message: ApiMessage = mode === 'login' ? { type: 'LOGIN', email, password } : { type: 'SIGNUP', email, password };

    sendMessage<{ user: { id: string; email: string } }>(message)
      .then((response) => {
        if (response.ok) {
          $('errorMessage').hidden = true;
          showLoggedInView(response.data.user.email);
        } else {
          showError(response.error);
        }
      })
      .catch((error: unknown) => {
        console.error('fontCIA: login request failed', error);
        showError('Something went wrong. Please try again.');
      });
  });

  $('logoutBtn').addEventListener('click', () => {
    sendMessage<null>({ type: 'LOGOUT' })
      .then(() => showFormView())
      .catch((error: unknown) => console.error('fontCIA: logout failed', error));
  });

  const authState = await sendMessage<{ loggedIn: boolean; email?: string }>({ type: 'GET_AUTH_STATE' });
  if (authState.ok && authState.data.loggedIn && authState.data.email) {
    showLoggedInView(authState.data.email);
  }
}

initLoginPage();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/login.test.ts`
Expected: PASS — **6 tests passed**.

- [ ] **Step 6: Modify `esbuild.config.mjs`**

Current file:

```js
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: { 'service-worker': 'src/background/service-worker.ts' },
  outdir: 'dist/background',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
});

await esbuild.build({
  entryPoints: { overlay: 'src/content/overlay.ts' },
  outdir: 'dist/content',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

copyFileSync('manifest.json', 'dist/manifest.json');
```

Change to:

```js
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: { 'service-worker': 'src/background/service-worker.ts' },
  outdir: 'dist/background',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
});

await esbuild.build({
  entryPoints: { overlay: 'src/content/overlay.ts' },
  outdir: 'dist/content',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

await esbuild.build({
  entryPoints: { login: 'src/login/login.ts' },
  outdir: 'dist/login',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

mkdirSync('dist/login', { recursive: true });
copyFileSync('src/login/login.html', 'dist/login/login.html');
copyFileSync('manifest.json', 'dist/manifest.json');
```

- [ ] **Step 7: Run the build to verify it produces the expected output**

Run: `npm run build`
Expected: exit 0. Confirm `dist/login/login.js` and `dist/login/login.html` both exist.

- [ ] **Step 8: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/login/login.html src/login/login.ts esbuild.config.mjs tests/login.test.ts
git commit -m "feat: add bare-bones login/signup extension page"
```

---

### Task 8: Manifest Permissions

**Files:**
- Modify: `manifest.json`

No dedicated test — `manifest.json` is structural JSON with no logic to unit test; correctness is verified by the build step and Task 9's manual QA (loading the unpacked extension in Chrome).

- [ ] **Step 1: Modify `manifest.json`**

Current file:

```json
{
  "manifest_version": 3,
  "name": "fontCIA",
  "version": "0.1.0",
  "description": "Identify fonts on any webpage by selecting text.",
  "action": {
    "default_title": "fontCIA — select text to identify its font"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "permissions": ["activeTab", "scripting", "storage"]
}
```

Change to:

```json
{
  "manifest_version": 3,
  "name": "fontCIA",
  "version": "0.1.0",
  "description": "Identify fonts on any webpage by selecting text.",
  "action": {
    "default_title": "fontCIA — select text to identify its font"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://localhost:3001/*"],
  "web_accessible_resources": [
    {
      "resources": ["login/login.html"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

- [ ] **Step 2: Rebuild and confirm the manifest copies correctly**

Run: `npm run build`
Expected: exit 0. Confirm `dist/manifest.json` contains the new `host_permissions` and `web_accessible_resources` fields (it's a straight `copyFileSync`, so this should be automatic — spot-check with a file read if you want certainty).

- [ ] **Step 3: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; all tests pass (no test targets `manifest.json` directly, so the count is unchanged from Task 7).

- [ ] **Step 4: Commit**

```bash
git add manifest.json
git commit -m "chore: add host_permissions and web_accessible_resources for backend wiring"
```

---

### Task 9: Final Verification

**Files:** None (verification only).

- [ ] **Step 1: Full suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; full suite passes (every test file in `tests/`, including all files touched or added by this plan).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: exit 0. Confirm `dist/` contains: `background/service-worker.js`, `content/overlay.js`, `login/login.js`, `login/login.html`, `manifest.json`.

- [ ] **Step 3: Manual end-to-end QA in Chrome**

Prerequisite: the sub-project 4a backend server running locally (`cd server && npm run dev`, with its own `docker compose up -d` Postgres already up — see `server/README`-equivalent setup from the 4a plan if a fresh environment).

Load the unpacked extension (`dist/`) in Chrome (`chrome://extensions` → Developer mode → Load unpacked → select `dist/`), then walk through:

1. On any `http`/`https` page, click the extension icon, drag-select some text, click Scan. Confirm the result renders and (since you're not logged in) the button reads "Log in to save."
2. Click "Log in to save." Confirm a new tab opens to the login page (not a popup) and the crosshair/panel in the original tab is unaffected.
3. On the login page, sign up with a fresh email. Confirm it shows "Logged in as `<email>`."
4. Switch back to the original tab (the scan panel should still be open, assuming you didn't dismiss it). Confirm the Save button now reads "☆ Save" (the cross-tab `storage.onChanged` reactivity — give it a moment if it doesn't update instantly).
5. Click Save. Confirm it flips to "★ Saved." Run `curl -H "Authorization: Bearer <token>" http://localhost:3001/saved-fonts` (or check via the login page / a future saved-fonts UI) to confirm the row actually persisted server-side — you'll need the access token; simplest is to inspect `chrome.storage.local` via the extension's service worker DevTools console (`chrome://extensions` → fontCIA → "service worker" → Inspect → `chrome.storage.local.get('fontcia-auth', console.log)`).
6. Click the Saved button again to unsave. Confirm it reverts to "☆ Save" and the server-side row is gone (re-check via the same curl/console approach).
7. Perform a new scan (match or no-match) and confirm a corresponding row appears via `POST /scans` — check with `curl http://localhost:3001/scans` isn't exposed as a GET in this API, so instead confirm indirectly via the server's logs/database (`docker compose exec -T postgres psql -U fontcia -d fontcia_dev -c "SELECT * FROM \"Scan\" ORDER BY \"createdAt\" DESC LIMIT 5;"` from `server/`) that a new row appeared immediately after the scan, with no visible delay in the panel's own render.
8. In the extension's service worker DevTools console, corrupt the stored access token (`chrome.storage.local.get('fontcia-auth', (r) => { const auth = r['fontcia-auth']; auth.accessToken = 'deliberately-invalid'; chrome.storage.local.set({ 'fontcia-auth': auth }); })`), then perform a Save action in the panel. Confirm it still succeeds (proving the 401-refresh-and-retry path works for real, not just in the unit tests) and the stored access token has changed to a new valid value afterward.
9. On the login page (open it again from the panel, or navigate directly to `chrome-extension://<id>/login/login.html`), click Log out. Confirm it returns to the form view, and confirm (via the panel, after triggering the `storage.onChanged` reactivity by re-opening/re-rendering a result) that Save now shows "Log in to save" again.

- [ ] **Step 4: Record results**

If all checks pass, this sub-project is complete. If a fix is required, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix.

---

## Self-Review Notes

- **Spec coverage:** background-proxied messaging (Tasks 1, 3, 4, 6, 7) → covered; reactive single-flighted 401-refresh-and-retry (Task 3) → covered; `chrome.storage.local` token persistence (Task 2) → covered; `login.html` as a separate page opened via `window.open`, never a popup (Task 7, and `handleLoginPrompt` in Task 6) → covered; Save button replaced (not disabled) when logged out (Task 5) → covered; `chrome.storage.onChanged` cross-tab reactivity (Task 6) → covered; fire-and-forget scan logging decoupled from render (Task 6's `logScanResult`, called synchronously alongside the render branch, never awaited) → covered; `handleToggleSave` becoming async with `savedFontId` tracked (Task 6) → covered; `host_permissions`/`web_accessible_resources` manifest changes (Task 8) → covered; manual-QA-only items (`window.open`, real `storage.onChanged` across tabs, real network round-trip) called out explicitly in Task 9 → covered.
- **Placeholder scan:** none found — every step has complete, runnable code; the one deferred detail flagged in the spec (exact `web_accessible_resources` path) is resolved concretely in Task 7/8 as `login/login.html`, matching the esbuild output structure defined in the same task.
- **Type consistency check:** `ApiMessage`/`ApiResponse<T>` (Task 1) are used identically across `api-client.ts` (Task 3), `service-worker.ts`'s `handleApiMessage` (Task 4), `locked-selection.ts`'s `sendApiMessage` (Task 6), and `login.ts`'s `sendMessage` (Task 7) — same generic envelope shape everywhere, no drift. `StoredAuth` (Task 2) matches exactly how `api-client.ts` constructs it in `signup`/`login`/`doRefresh` (Task 3). `renderResultState`'s new signature (`isLoggedIn`, `onLoginPrompt` appended, Task 5) matches exactly how `locked-selection.ts` calls it in `renderResult` (Task 6) — confirmed both were updated together, no stale call site left with the old 5-argument form. `saveFont`'s `(fontName, confidence, sources)` parameter order (Task 3) matches exactly how `handleApiMessage` destructures and forwards `message.fontName, message.confidence, message.sources` (Task 4) and how `locked-selection.ts` constructs the `SAVE_FONT` message (Task 6). The chrome-mock's `runtime.sendMessage`/`storage.onChanged`/`storage.local`/`runtime.getURL` additions (Task 2) are consumed with matching call shapes by every later task's tests (Tasks 3, 4, 6, 7) — no test references a mock method that wasn't actually added.
- **Test count corrections made during self-review:** Task 4's "Expected" line originally miscounted the pre-existing `service-worker.test.ts` suite mid-sentence (written as "12... recount... 14") — corrected to state the existing 14 tests plainly, plus the 8 new ones (22 total). Task 6's total was originally stated as 18 but a literal count of the rewritten file's `it(...)` blocks is 20 — corrected inline to match the actual test file content given in that task's Step 1.
