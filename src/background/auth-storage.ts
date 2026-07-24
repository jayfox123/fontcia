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
