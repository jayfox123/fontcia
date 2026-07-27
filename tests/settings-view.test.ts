import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderSettingsView } from '../src/account/settings-view';
import { THEME_STORAGE_KEY } from '../src/shared/theme-storage';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true, email: 'a@example.com' } };
    return { ok: true, data: null };
  });
});

describe('renderSettingsView', () => {
  it('shows Dark as active when nothing is stored', async () => {
    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    const darkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Dark theme');
    expect(darkBtn?.className).toContain('fontcia-btn-primary');
  });

  it('shows Light as active when light is stored', async () => {
    await chromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'light' });

    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    const lightBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Light theme');
    expect(lightBtn?.className).toContain('fontcia-btn-primary');
  });

  it('persists the choice and calls onThemeChange when Light is clicked', async () => {
    const onThemeChange = vi.fn();
    const container = document.createElement('div');
    await renderSettingsView(container, () => false, onThemeChange);

    const lightBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Light theme',
    ) as HTMLButtonElement;
    lightBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onThemeChange).toHaveBeenCalledWith('light');
    const stored = await chromeMock.storage.local.get(THEME_STORAGE_KEY);
    expect(stored[THEME_STORAGE_KEY]).toBe('light');
    expect(lightBtn.className).toContain('fontcia-btn-primary');
  });

  it('still calls onThemeChange when isStale becomes true while setStoredTheme is in flight, but skips the local re-render', async () => {
    const onThemeChange = vi.fn();
    const container = document.createElement('div');
    let stale = false;
    await renderSettingsView(container, () => stale, onThemeChange);

    const lightBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Light theme',
    ) as HTMLButtonElement;
    const lightClassBeforeClick = lightBtn.className;

    // Simulate the container going stale (e.g. the user switched tabs) during the
    // genuine async IPC window between clicking and setStoredTheme resolving.
    stale = true;
    lightBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onThemeChange).toHaveBeenCalledWith('light');
    const stored = await chromeMock.storage.local.get(THEME_STORAGE_KEY);
    expect(stored[THEME_STORAGE_KEY]).toBe('light');
    expect(lightBtn.className).toBe(lightClassBeforeClick);
  });

  it('shows the logged-in email', async () => {
    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    expect(container.textContent).toContain('Logged in as a@example.com');
  });

  it('shows a not-logged-in message when logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    expect(container.textContent).toContain('Not logged in');
  });

  it('does not show an email line if isStale reports true after the auth check', async () => {
    let callCount = 0;
    const isStale = () => {
      callCount += 1;
      return callCount > 1;
    };

    const container = document.createElement('div');
    await renderSettingsView(container, isStale, vi.fn());

    expect(container.textContent).not.toContain('Logged in as a@example.com');
    expect(container.textContent).not.toContain('Not logged in');
  });
});
