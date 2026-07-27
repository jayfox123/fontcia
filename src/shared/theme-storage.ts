export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'fontcia-theme';

export async function getStoredTheme(): Promise<Theme> {
  const result = await chrome.storage.local.get(THEME_STORAGE_KEY);
  return result[THEME_STORAGE_KEY] === 'light' ? 'light' : 'dark';
}

export async function setStoredTheme(theme: Theme): Promise<void> {
  await chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme });
}
