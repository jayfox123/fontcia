import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderLockedSelection } from '../src/content/locked-selection';
import type { ScanResult } from '../src/content/scan-types';
import type { CaptureResponse } from '../src/shared/capture-messages';
import type { MatchImageResponse } from '../src/shared/match-messages';

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

    expect(windowOpenSpy).toHaveBeenCalledWith('chrome-extension://fake-extension-id/account/account.html', '_blank');

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

  it('ignores a storage.onChanged auth-state fire while a save is in flight, and rejects a second click', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );
    const deferred = createDeferred<{ ok: true; data: { id: string } }>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'SAVE_FONT') return deferred.promise;
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
    saveBtn.click(); // SAVE_FONT now in flight, deferred, not yet resolved

    // Simulate the in-flight request's own token refresh writing to storage.
    const changeListener = chromeMock.storage.onChanged.addListener.mock.calls[0][0];
    changeListener({ 'fontcia-auth': { newValue: {} } }, 'local');
    await Promise.resolve();
    await Promise.resolve();

    // A second click while still pending must not fire a second SAVE_FONT.
    // Deliberately re-query rather than reuse `saveBtn`: if the storage-listener
    // fire were allowed to re-render mid-flight, that render would swap in a
    // *fresh, non-disabled* button, and clicking the original (now-detached,
    // disabled) `saveBtn` reference would silently no-op regardless of any
    // pending-guard logic — proving nothing either way. Querying live is what
    // actually exercises the race.
    const liveBtnAfterStorageFire = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    liveBtnAfterStorageFire.click();
    await Promise.resolve();

    const saveCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
      ([msg]) => (msg as { type: string }).type === 'SAVE_FONT',
    );
    expect(saveCalls).toHaveLength(1);

    deferred.resolve({ ok: true, data: { id: 'font-1' } });
    await deferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('★ Saved');
  });

  it('falls back to logged-out UI instead of hanging when GET_AUTH_STATE rejects', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') throw new Error('service worker unreachable');
      return { ok: true, data: null };
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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

    const btn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(btn.textContent).toBe('Log in to save');
    expect(btn.disabled).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('shows "Analyzing image…" and sends CAPTURE_SELECTION when the scan result is no-text', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const captureDeferred = createDeferred<CaptureResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return captureDeferred.promise;
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

    expect(panel.querySelector('.fontcia-analyzing-message')?.textContent).toBe('Analyzing image…');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 10, y: 20, width: 200, height: 30 },
      devicePixelRatio: window.devicePixelRatio,
    });
  });

  it('scales the CAPTURE_SELECTION message by the real window.devicePixelRatio', async () => {
    const originalDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const captureDeferred = createDeferred<CaptureResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return captureDeferred.promise;
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

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 10, y: 20, width: 200, height: 30 },
      devicePixelRatio: 2,
    });

    Object.defineProperty(window, 'devicePixelRatio', { value: originalDpr, configurable: true });
  });

  it('sends MATCH_IMAGE with the captured blob after a successful capture', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    const matchDeferred = createDeferred<MatchImageResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return matchDeferred.promise;
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

    expect(panel.querySelector('.fontcia-analyzing-message')?.textContent).toBe('Analyzing image…');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'MATCH_IMAGE', blob: fakeBlob });
  });

  it('renders ranked matches and logs the top candidate as a match when MATCH_IMAGE succeeds with candidates', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') {
        return {
          status: 'ok',
          matches: [
            {
              fontName: 'Inter',
              confidence: 82,
              sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
            },
            {
              fontName: 'Roboto',
              confidence: 61,
              sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
            },
          ],
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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
    await Promise.resolve();
    await Promise.resolve();

    const names = Array.from(panel.querySelectorAll('.fontcia-match-name')).map((el) => el.textContent);
    expect(names).toEqual(['Inter', 'Roboto']);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOG_SCAN',
      status: 'match',
      fontName: 'Inter',
      confidence: 82,
    });
  });

  it('renders the no-confident-match state and logs no-match when MATCH_IMAGE succeeds with an empty array', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return { status: 'ok', matches: [] };
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
  });

  it('renders the match-error state and logs no-match when MATCH_IMAGE resolves with an error status', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return { status: 'error', message: 'embedding service unreachable' };
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong analyzing this image.',
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
  });

  it('renders the match-error state when the MATCH_IMAGE message itself rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') throw new Error('service worker unreachable');
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong analyzing this image.',
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('fontCIA: image match message failed', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('does not render a match result after dispose() while MATCH_IMAGE is still pending', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    const matchDeferred = createDeferred<MatchImageResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return matchDeferred.promise;
      return { ok: true, data: null };
    });

    const { panel, dispose } = renderLockedSelection(
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

    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();

    dispose();
    matchDeferred.resolve({ status: 'ok', matches: [{ fontName: 'Inter', confidence: 90, sources: [] }] });
    await matchDeferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-match-name')).toBeNull();
    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();
  });

  it('saves a candidate via SAVE_FONT using its own fontName/confidence/sources, independent of other candidates', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') {
        return {
          status: 'ok',
          matches: [
            {
              fontName: 'Inter',
              confidence: 82,
              sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
            },
            {
              fontName: 'Roboto',
              confidence: 61,
              sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
            },
          ],
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'SAVE_FONT') return { ok: true, data: { id: 'saved-1' } };
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
    await Promise.resolve();
    await Promise.resolve();

    const saveButtons = Array.from(panel.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(saveButtons).toHaveLength(2);
    expect(saveButtons[0].textContent).toBe('☆ Save');
    expect(saveButtons[1].textContent).toBe('☆ Save');

    saveButtons[1].click(); // save the SECOND candidate (Roboto)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_FONT',
      fontName: 'Roboto',
      confidence: 61,
      sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
    });

    const saveButtonsAfter = Array.from(panel.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(saveButtonsAfter[0].textContent).toBe('☆ Save'); // Inter unaffected
    expect(saveButtonsAfter[1].textContent).toBe('★ Saved'); // Roboto now saved
  });

  it('shows an enabled Name it button on the DOM no-match state when the reason is unrecognized and logged in', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'unrecognized' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
    const buttons = Array.from(panel.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);
  });

  it('shows the bare no-match state for a mixed reason, with no working Name it button', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'mixed' }));

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

    const buttons = Array.from(panel.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(true);
  });

  it('tries the server-side name resolution fallback when a detectedFontFamily is present, and shows a match on success', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'Brandon Grotesque, sans-serif',
        detectedConfidence: 92,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') {
        return {
          ok: true,
          data: {
            fontName: 'Brandon Grotesque',
            sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
          },
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'RESOLVE_FONT_NAME',
      fontFamilyStack: 'Brandon Grotesque, sans-serif',
    });
    expect(panel.querySelector('.fontcia-result-font')?.textContent).toBe('Brandon Grotesque');
    expect(panel.querySelector('.fontcia-confidence')?.textContent).toBe('92% confidence');
  });

  it('logs the fallback match with LOG_SCAN, in addition to the initial no-match log', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'Brandon Grotesque',
        detectedConfidence: 92,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') {
        return { ok: true, data: { fontName: 'Brandon Grotesque', sources: [] } };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOG_SCAN',
      status: 'match',
      fontName: 'Brandon Grotesque',
      confidence: 92,
    });
  });

  it('falls through to the enrollment-capable unrecognized state when the fallback finds nothing', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'SomeUnknownFont',
        detectedConfidence: 100,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') return { ok: false, error: 'Font not found' };
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);
  });

  it('falls through to the unrecognized state when the fallback message itself rejects', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'SomeUnknownFont',
        detectedConfidence: 100,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') throw new Error('network error');
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
  });

  it('does not attempt the fallback for a mixed reason', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'mixed' }));

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

    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RESOLVE_FONT_NAME' }),
    );
  });

  it('starts enrollment via a fresh CAPTURE_SELECTION when Name it is clicked from the unrecognized state', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'unrecognized' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'SUBMIT_FONT') return { status: 'ok', submissionId: 'sub-1' };
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

    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    nameItBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const nameInput = panel.querySelector('.fontcia-input') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    nameInput.value = 'New Font Name';

    const submitBtn = Array.from(panel.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 10, y: 20, width: 200, height: 30 },
      devicePixelRatio: window.devicePixelRatio,
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SUBMIT_FONT',
      fontName: 'New Font Name',
      sourceUrl: null,
      blob: fakeBlob,
    });
    expect(panel.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('starts enrollment reusing the already-captured blob when Name it is clicked from no-confident-match', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return { status: 'ok', matches: [] };
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      if (message.type === 'SUBMIT_FONT') return { status: 'ok', submissionId: 'sub-1' };
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
    await Promise.resolve();
    await Promise.resolve();

    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    nameItBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const nameInput = panel.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'New Font Name';

    const submitBtn = Array.from(panel.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    // Only ONE CAPTURE_SELECTION call total (the original capture that fed
    // MATCH_IMAGE) — enrollment from this entry point must reuse that same
    // blob, not trigger a second capture round trip.
    const captureCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
      ([msg]) => (msg as { type: string }).type === 'CAPTURE_SELECTION',
    );
    expect(captureCalls).toHaveLength(1);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SUBMIT_FONT',
      fontName: 'New Font Name',
      sourceUrl: null,
      blob: fakeBlob,
    });
    expect(panel.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('cancelling enrollment returns to the ready state', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'unrecognized' }));
    const onRestart = vi.fn();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

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

    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    nameItBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const cancelBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('re-renders the ranked-matches Save buttons when auth state changes via storage.onChanged', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') {
        return {
          status: 'ok',
          matches: [{ fontName: 'Inter', confidence: 82, sources: [] }],
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
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
    await Promise.resolve();
    await Promise.resolve();

    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('Log in to save');

    // Simulate the user logging in from a separate tab, exactly as
    // chrome.storage.onChanged would fire when that page's background write
    // completes.
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      return { ok: true, data: null };
    });
    const changeListener = chromeMock.storage.onChanged.addListener.mock.calls[0][0];
    changeListener({ 'fontcia-auth': { newValue: {} } }, 'local');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('☆ Save');
  });

  it('renders the capture-blocked state when the response is blocked', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'blocked' };
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

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
  });

  it('renders the capture-blocked state and logs an error when the response is an error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'error', message: 'capture failed' };
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

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
    expect(consoleErrorSpy).toHaveBeenCalledWith('fontCIA: image capture failed', 'capture failed');

    consoleErrorSpy.mockRestore();
  });

  it('renders the capture-blocked state when the CAPTURE_SELECTION message itself rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') throw new Error('service worker unreachable');
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

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
    expect(consoleErrorSpy).toHaveBeenCalledWith('fontCIA: image capture message failed', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('does not render anything after dispose() while the capture response is still pending', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const captureDeferred = createDeferred<CaptureResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return captureDeferred.promise;
      return { ok: true, data: null };
    });

    const { panel, dispose } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();

    dispose();
    captureDeferred.resolve({ status: 'blocked' });
    await captureDeferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')).toBeNull();
    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();
  });
});
