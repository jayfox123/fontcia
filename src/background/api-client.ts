import { API_BASE_URL } from '../shared/api-config';
import { getStoredAuth, setStoredAuth, clearStoredAuth } from './auth-storage';
import type { ApiResponse } from '../shared/api-messages';
import type { ScanSource } from '../content/scan-types';
import type { RankedMatch } from '../shared/match-messages';

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

  const current = await getStoredAuth();
  if (!current || current.refreshToken !== stored.refreshToken) {
    // Storage changed underneath us (a logout or a fresh login happened while
    // this refresh was in flight) — don't clobber whatever is there now.
    return false;
  }

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
  const result = await apiFetch<unknown>('/scans', {
    method: 'POST',
    body: { status, fontName, confidence },
    auth: 'optional',
  });

  if (!result.ok) return result;
  return { ok: true, data: null };
}

export async function matchImage(blob: Blob): Promise<ApiResponse<RankedMatch[]>> {
  const formData = new FormData();
  formData.append('image', blob, 'crop.png');

  // Bypasses apiFetch/rawRequest — those hardcode JSON.stringify + a
  // Content-Type: application/json header, incompatible with the
  // multipart/form-data body multer expects on this one endpoint.
  const res = await fetch(`${API_BASE_URL}/font-matches`, { method: 'POST', body: formData });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (res.status >= 200 && res.status < 300) {
    const data = json as { matches: RankedMatch[] };
    return { ok: true, data: data.matches };
  }

  const errorMessage = (json as { error?: string } | null)?.error ?? `Request failed with status ${res.status}`;
  return { ok: false, error: errorMessage };
}
