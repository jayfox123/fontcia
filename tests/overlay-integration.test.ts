import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(async () => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  // Re-import fresh each test so the module's onMessage listener registers against this test's mock.
  // vi.resetModules() is required here: a bare dynamic import() of the same specifier is served
  // from vitest's module cache within a test file, so without this the listener registered during
  // an earlier test would stay bound to that test's (now stale) chrome mock instance.
  vi.resetModules();
  await import('../src/content/overlay');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('runtime message wiring', () => {
  it('arms selection mode on an ARM_SELECTION message', async () => {
    await chrome.tabs.sendMessage(7, { type: 'ARM_SELECTION', tabId: 7 });

    expect(document.getElementById('fontcia-overlay-host')).not.toBeNull();
  });

  it('dismisses on a DISMISS_SELECTION message and clears the storage flag', async () => {
    await chromeMock.storage.session.set({ 'fontcia-active:7': true });

    await chrome.tabs.sendMessage(7, { type: 'ARM_SELECTION', tabId: 7 });
    await chrome.tabs.sendMessage(7, { type: 'DISMISS_SELECTION' });

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
    const stored = await chromeMock.storage.session.get('fontcia-active:7');
    expect(stored['fontcia-active:7']).toBeUndefined();
  });
});
