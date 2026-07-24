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
