import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { getStoredTheme, setStoredTheme, THEME_STORAGE_KEY } from '../src/shared/theme-storage';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('getStoredTheme', () => {
  it('defaults to dark when nothing is stored', async () => {
    await expect(getStoredTheme()).resolves.toBe('dark');
  });

  it('returns the stored value when it is light', async () => {
    await chromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'light' });
    await expect(getStoredTheme()).resolves.toBe('light');
  });

  it('falls back to dark for any unrecognized stored value', async () => {
    await chromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'not-a-real-theme' });
    await expect(getStoredTheme()).resolves.toBe('dark');
  });
});

describe('setStoredTheme', () => {
  it('persists the theme so a later getStoredTheme sees it', async () => {
    await setStoredTheme('light');
    await expect(getStoredTheme()).resolves.toBe('light');
  });

  it('round-trips back to dark', async () => {
    await setStoredTheme('light');
    await setStoredTheme('dark');
    await expect(getStoredTheme()).resolves.toBe('dark');
  });
});
