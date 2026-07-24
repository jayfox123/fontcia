import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

let chromeMock: ReturnType<typeof createChromeMock>;

// This hook does vi.resetModules() + a dynamic import() of src/content/overlay.ts, which
// re-transforms and re-executes its whole module graph and registers a fresh
// chrome.runtime.onMessage listener. That's fast in isolation but under full-suite CPU
// contention it can take several seconds, occasionally exceeding Vitest's default per-hook
// timeout. A killed-by-timeout hook doesn't cancel its in-flight import() promise (JS
// promises aren't cancellable) - that orphaned import can go on to register a listener
// bound to a later test's (now stale) chrome mock instance, producing the same class of
// cascading failure already fixed twice on this branch for this exact
// vi.resetModules()+dynamic-import() pattern (tests/service-worker.test.ts's handleApiMessage
// describe, fixed in d19694b; tests/login.test.ts's login page describe, fixed in 7d9e511).
// This is why the suite-wide testTimeout/hookTimeout in vitest.config.ts are set generously
// rather than left at Vitest's defaults - see the comment there for the other files that
// share this risk.
beforeEach(async () => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  // Simulate a fresh page: the injection-idempotency flag lives on `window`,
  // which persists across tests in this file even though the module cache is reset.
  window.__fontciaOverlayInjected = false;
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

  it('ignores an unrecognized message type', async () => {
    await chrome.tabs.sendMessage(7, { type: 'SOME_OTHER_MESSAGE' });

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('ignores an ARM_SELECTION message missing a numeric tabId', async () => {
    await chrome.tabs.sendMessage(7, { type: 'ARM_SELECTION' });

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('does not throw on a malformed (non-object) message', async () => {
    await expect(chrome.tabs.sendMessage(7, null)).resolves.toBeUndefined();
  });

  it('does not register a second listener when injected again on an already-injected page', async () => {
    // Simulate a second chrome.scripting.executeScript injection onto a page that
    // already has an instance running (e.g. dismiss, then re-arm without navigating) —
    // deliberately NOT resetting window.__fontciaOverlayInjected before this re-import,
    // unlike the outer beforeEach.
    vi.resetModules();
    await import('../src/content/overlay');

    await chrome.tabs.sendMessage(7, { type: 'ARM_SELECTION', tabId: 7 });

    expect(document.querySelectorAll('#fontcia-overlay-host').length).toBe(1);
  });
});
