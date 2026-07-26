import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { moduleLoadChromeMock } from './setup';
import { handleIconClick, isInjectableUrl } from '../src/background/service-worker';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('handleIconClick', () => {
  it('arms a fresh tab: marks it active, injects the content script, sends ARM_SELECTION', async () => {
    await handleIconClick({ id: 7, url: 'https://example.com/' } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content/overlay.js'],
    });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'ARM_SELECTION', tabId: 7 });

    const stored = await chromeMock.storage.session.get('fontcia-active:7');
    expect(stored['fontcia-active:7']).toBe(true);
  });

  it('toggles off an already-active tab instead of re-injecting', async () => {
    await chromeMock.storage.session.set({ 'fontcia-active:7': true });

    await handleIconClick({ id: 7, url: 'https://example.com/' } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'DISMISS_SELECTION' });
  });

  it('does nothing for a tab with no id', async () => {
    await handleIconClick({} as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does not attempt injection on a restricted chrome:// URL, and flashes a badge', async () => {
    await handleIconClick({ id: 7, url: 'chrome://extensions' } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
  });

  it('does not attempt injection on a chrome-extension:// URL', async () => {
    await handleIconClick({ id: 7, url: 'chrome-extension://abcdefghijklmnop/options.html' } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not attempt injection on the Chrome Web Store', async () => {
    await handleIconClick({ id: 7, url: 'https://chrome.google.com/webstore/detail/abc' } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('treats a tab with no url as non-injectable', async () => {
    await handleIconClick({ id: 7 } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('isInjectableUrl', () => {
  it('allows ordinary http/https pages', () => {
    expect(isInjectableUrl('https://example.com/')).toBe(true);
    expect(isInjectableUrl('http://example.com/')).toBe(true);
  });

  it('rejects chrome:// pages', () => {
    expect(isInjectableUrl('chrome://extensions')).toBe(false);
  });

  it('rejects chrome-extension:// pages', () => {
    expect(isInjectableUrl('chrome-extension://abcdefghijklmnop/options.html')).toBe(false);
  });

  it('rejects the Chrome Web Store', () => {
    expect(isInjectableUrl('https://chrome.google.com/webstore/detail/abc')).toBe(false);
  });

  it('rejects file:// URLs', () => {
    expect(isInjectableUrl('file:///Users/me/test.html')).toBe(false);
  });

  it('rejects undefined and malformed URLs', () => {
    expect(isInjectableUrl(undefined)).toBe(false);
    expect(isInjectableUrl('not a url')).toBe(false);
  });
});

// Each test here does vi.resetModules() + vi.doMock() + a dynamic import() of
// service-worker.ts, which re-transforms and re-executes its whole module graph
// (api-client -> auth-storage / shared/api-config, session-state, scan-types).
// That's cheap in isolation but under full-suite CPU contention (many test files'
// worker threads competing for the CPU) it can take several seconds, occasionally
// exceeding Vitest's default 5000ms per-test timeout. A killed-by-timeout test
// doesn't actually cancel its in-flight import() promise (JS promises aren't
// cancellable) — that orphaned import can then resolve into the *next* test's
// module registry state after that test's own resetModules()/doMock() has already
// run, handing it a stale/unmocked api-client and producing a cascading
// "X is not a spy" failure with no relation to that test's own logic. This is
// why the suite-wide testTimeout in vitest.config.ts is set generously rather
// than left at Vitest's default - see the comment there for the other files
// that share this risk.
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

  it('returns a network-error response instead of rejecting when the underlying api-client call throws', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');

    const result = await handleApiMessage({ type: 'SIGNUP', email: 'a@example.com', password: 'password123' });

    expect(result).toEqual({ ok: false, error: 'Network error — please try again' });
  });
});

describe('handleCaptureMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves windowId from the sender and delegates to captureAndCropSelection', async () => {
    vi.doMock('../src/background/image-capture', () => ({
      captureAndCropSelection: vi.fn(async () => ({ status: 'captured', blob: new Blob() })),
    }));
    const { handleCaptureMessage } = await import('../src/background/service-worker');
    const { captureAndCropSelection } = await import('../src/background/image-capture');

    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const sender = { tab: { windowId: 42 } } as chrome.runtime.MessageSender;

    const result = await handleCaptureMessage({ type: 'CAPTURE_SELECTION', rect, devicePixelRatio: 2 }, sender);

    expect(captureAndCropSelection).toHaveBeenCalledWith(42, rect, 2);
    expect(result).toEqual({ status: 'captured', blob: expect.any(Blob) });
  });

  it('returns an error response without calling captureAndCropSelection when the sender has no windowId', async () => {
    vi.doMock('../src/background/image-capture', () => ({
      captureAndCropSelection: vi.fn(),
    }));
    const { handleCaptureMessage } = await import('../src/background/service-worker');
    const { captureAndCropSelection } = await import('../src/background/image-capture');

    const result = await handleCaptureMessage(
      { type: 'CAPTURE_SELECTION', rect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1 },
      {} as chrome.runtime.MessageSender,
    );

    expect(captureAndCropSelection).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'error', message: 'Unable to determine window for capture' });
  });
});

describe('handleMatchImageMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls matchImage with the blob and maps a successful ApiResponse to an ok MatchImageResponse', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(async () => ({ ok: true, data: [{ fontName: 'Inter', confidence: 82, sources: [] }] })),
    }));
    const { handleMatchImageMessage } = await import('../src/background/service-worker');
    const { matchImage } = await import('../src/background/api-client');

    const blob = new Blob(['fake image data']);
    const result = await handleMatchImageMessage({ type: 'MATCH_IMAGE', blob });

    expect(matchImage).toHaveBeenCalledWith(blob);
    expect(result).toEqual({ status: 'ok', matches: [{ fontName: 'Inter', confidence: 82, sources: [] }] });
  });

  it('maps a failed ApiResponse to an error MatchImageResponse', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(async () => ({ ok: false, error: 'embedding service unreachable' })),
    }));
    const { handleMatchImageMessage } = await import('../src/background/service-worker');

    const result = await handleMatchImageMessage({ type: 'MATCH_IMAGE', blob: new Blob() });

    expect(result).toEqual({ status: 'error', message: 'embedding service unreachable' });
  });
});

describe('module load side effects', () => {
  it('grants content scripts access to chrome.storage.session on module load', () => {
    // The top-level `import '../src/background/service-worker'` above runs once,
    // the first time this test file is loaded by Vitest, against whatever
    // globalThis.chrome exists at that moment — the default mock installed by
    // tests/setup.ts (imported for its side effect via `moduleLoadChromeMock` above),
    // not the fresh per-test `chromeMock` created in beforeEach. So this assertion
    // targets the setup.ts mock, which is the one the module actually saw.
    expect(moduleLoadChromeMock.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
  });
});
